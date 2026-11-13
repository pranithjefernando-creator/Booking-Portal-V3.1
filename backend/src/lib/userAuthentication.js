import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createUserRecord, deleteUserRecord, updateUserRecord, userAccessTransaction } from "./userAccessStore.js";
import { DEFAULT_APPROVAL_ID, initializeDefaultApproval, setUserAssignments } from "./accessConfigurationStore.js";
import { validatePasswordStrength } from "./passwordPolicy.js";
import { verifyNoUserAccessRowSecurity } from "./userAccessSchema.js";
import { passwordHash } from "./passwordHash.js";

const MAX_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;
const DUMMY_SALT = Buffer.alloc(16);
const DUMMY_HASH = Buffer.alloc(64);

async function matches(password, salt, expected) {
  if (!Buffer.isBuffer(salt) || salt.length !== 16 || !Buffer.isBuffer(expected) || expected.length !== 64) throw new Error("Invalid stored password hash");
  return timingSafeEqual(await passwordHash(password, salt), expected);
}

function credentialsPassword(password) {
  const error = validatePasswordStrength(password);
  if (error) throw new Error(error);
}

function parseToken(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]) || !/^[A-Za-z0-9_-]{43}$/.test(parts[1])) return null;
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const actual = Buffer.from(parts[1], "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (typeof data.uid !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.uid) ||
        typeof data.version !== "string" || !Number.isSafeInteger(data.exp) || data.exp <= Date.now()) return null;
    return data;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function issueToken(user, secret, ttl) {
  const body = Buffer.from(JSON.stringify({ uid: user.id, version: user.session_version, exp: Date.now() + ttl })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}

async function tokenUser(client, payload) {
  if (!payload) return null;
  const { rows } = await client.query(`
    SELECT u.id, u.name, u.email, u.role_name, c.password_salt, c.password_hash, c.session_version, c.must_change
    FROM portal_access_v1.users u JOIN portal_access_v1.user_credentials c ON c.user_id = u.id
    WHERE u.id = $1 AND c.session_version::text = $2
  `, [payload.uid, payload.version]);
  return rows[0] || null;
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role_name };
}

function temporaryCredential() {
  const password = `${randomBytes(18).toString("base64url")}-9A`;
  const salt = randomBytes(16);
  return { password, salt };
}

async function mayManage(client, payload, permissionCode) {
  const actor = await tokenUser(client, payload);
  if (!actor || actor.must_change) return "unauthorized";
  const permission = await client.query("SELECT 1 FROM portal_access_v1.role_permissions WHERE role_name = $1 AND permission_code = $2", [actor.role_name, permissionCode]);
  return permission.rows.length ? "ok" : "forbidden";
}
const mayManageUsers = (client, payload) => mayManage(client, payload, "admin.users");

function splitUserFields(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("User fields must be an object");
  const recordFields = new Set(["name", "email", "role", "branchCode"]);
  const assignmentFields = new Set(["ruleConfigurationId", "bookingVisibilityProfileId", "orderVisibilityProfileId"]);
  const record = {};
  const assignments = {};
  for (const [key, value] of Object.entries(input)) {
    if (recordFields.has(key)) record[key] = value;
    else if (assignmentFields.has(key)) assignments[key] = value;
    else throw new Error(`Unsupported user field: ${key}`);
  }
  return { record, assignments };
}

export function createUserAuthentication(pool, { secret, tokenTtlMs = 8 * 60 * 60 * 1000 }) {
  if (typeof secret !== "string" || !secret.trim() || Buffer.byteLength(secret, "utf8") < 32) throw new Error("AUTH_SECRET must be a nonblank authentication signing secret of at least 32 bytes");
  if (!Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0) throw new Error("Invalid authentication token lifetime");
  return {
    async authorizedWrite(actorToken, permission, operation) {
      if (!["admin.users", "admin.roles"].includes(permission)) throw new Error("Unsupported management permission");
      const payload = parseToken(actorToken, secret);
      if (!payload) return { status: "unauthorized" };
      return userAccessTransaction(pool, async (client) => {
        const status = await mayManage(client, payload, permission);
        if (status !== "ok") return { status };
        return { status: "ok", value: await operation(client) };
      });
    },
    async login(email, password) {
      if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password || password.length > 128) throw new Error("Email and password are required");
      return userAccessTransaction(pool, async (client) => {
        const { rows } = await client.query(`
          SELECT u.id, u.name, u.email, u.role_name, c.password_salt, c.password_hash, c.session_version, c.must_change, c.failed_attempts, c.locked_until
          FROM portal_access_v1.users u JOIN portal_access_v1.user_credentials c ON c.user_id = u.id
          WHERE lower(u.email) = lower($1) FOR UPDATE OF c
        `, [email.trim()]);
        const row = rows[0];
        if (!row) {
          await matches(password, DUMMY_SALT, DUMMY_HASH);
          return { status: "invalid" };
        }
        if (Number(row.locked_until) > Date.now()) return { status: "locked" };
        if (!await matches(password, row.password_salt, row.password_hash)) {
          const attempts = row.failed_attempts + 1;
          await client.query("UPDATE portal_access_v1.user_credentials SET failed_attempts = $2, locked_until = $3 WHERE user_id = $1", [row.id, attempts >= MAX_ATTEMPTS ? 0 : attempts, attempts >= MAX_ATTEMPTS ? Date.now() + LOCK_MS : 0]);
          return { status: "invalid" };
        }
        await client.query("UPDATE portal_access_v1.user_credentials SET failed_attempts = 0, locked_until = 0 WHERE user_id = $1", [row.id]);
        return { status: "ok", token: issueToken(row, secret, tokenTtlMs), mustChangePassword: row.must_change, user: publicUser(row) };
      });
    },
    async authenticate(token) {
      const payload = parseToken(token, secret);
      if (!payload) return null;
      const row = await tokenUser(pool, payload);
      return row ? { user: publicUser(row), mustChangePassword: row.must_change } : null;
    },
    async authenticateAccess(token, settings, roleOverride) {
      const payload = parseToken(token, secret);
      if (!payload) return null;
      return userAccessTransaction(pool, async (client) => {
        await verifyNoUserAccessRowSecurity(client);
        const row = await tokenUser(client, payload);
        if (!row) return null;
        const snapshot = await settings.getAccess(row.id, client);
        if (!snapshot) throw new Error("Authenticated user is missing from access snapshot");
        let previewRole;
        if (roleOverride && snapshot.user.role === "Admin") {
          previewRole = (await settings.listRoles(client)).find((role) => role.name === roleOverride);
          if (!previewRole) return { invalidRole: true };
        }
        return { session: { user: publicUser(row), mustChangePassword: row.must_change }, snapshot, previewRole };
      }, true);
    },
    async changePassword(token, currentPassword, newPassword) {
      const payload = parseToken(token, secret);
      if (!payload) return { status: "unauthorized" };
      if (typeof currentPassword !== "string" || currentPassword.length > 128) return { status: "incorrect" };
      credentialsPassword(newPassword);
      if (currentPassword === newPassword) throw new Error("New password must differ from the current password");
      return userAccessTransaction(pool, async (client) => {
        const row = await tokenUser(client, payload);
        if (!row) return { status: "unauthorized" };
        if (!await matches(currentPassword, row.password_salt, row.password_hash)) return { status: "incorrect" };
        const salt = randomBytes(16);
        const hash = await passwordHash(newPassword, salt);
        await client.query("UPDATE portal_access_v1.user_credentials SET password_salt = $2, password_hash = $3, session_version = $4, must_change = false, failed_attempts = 0, locked_until = 0 WHERE user_id = $1", [row.id, salt, hash, randomUUID()]);
        return { status: "ok" };
      });
    },
    async resetPassword(actorToken, targetId) {
      const payload = parseToken(actorToken, secret);
      if (!payload) return { status: "unauthorized" };
      return userAccessTransaction(pool, async (client) => {
        const status = await mayManageUsers(client, payload);
        if (status !== "ok") return { status };
        const target = await client.query("SELECT id FROM portal_access_v1.users WHERE id = $1", [targetId]);
        if (!target.rows.length) return { status: "not_found" };
        const { password: temporaryPassword, salt } = temporaryCredential();
        const hash = await passwordHash(temporaryPassword, salt);
        await client.query(`
          INSERT INTO portal_access_v1.user_credentials (user_id, password_salt, password_hash, session_version, must_change, failed_attempts, locked_until)
          VALUES ($1, $2, $3, $4, true, 0, 0)
          ON CONFLICT (user_id) DO UPDATE SET password_salt = EXCLUDED.password_salt, password_hash = EXCLUDED.password_hash,
            session_version = EXCLUDED.session_version, must_change = true, failed_attempts = 0, locked_until = 0
        `, [targetId, salt, hash, randomUUID()]);
        return { status: "ok", temporaryPassword };
      });
    },
    async createUser(actorToken, input) {
      const payload = parseToken(actorToken, secret);
      if (!payload) return { status: "unauthorized" };
      const { record, assignments } = splitUserFields(input);
      if (typeof record.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(record.email.trim())) throw new Error("A valid email is required");
      return userAccessTransaction(pool, async (client) => {
        const status = await mayManageUsers(client, payload);
        if (status !== "ok") return { status };
        const user = await createUserRecord(client, record);
        if (!Object.hasOwn(assignments, "ruleConfigurationId")) {
          await initializeDefaultApproval(client);
          assignments.ruleConfigurationId = DEFAULT_APPROVAL_ID;
        }
        if (Object.keys(assignments).length) await setUserAssignments(client, user.id, assignments);
        const { password: temporaryPassword, salt } = temporaryCredential();
        const hash = await passwordHash(temporaryPassword, salt);
        await client.query(
          "INSERT INTO portal_access_v1.user_credentials (user_id, password_salt, password_hash, session_version, must_change, failed_attempts, locked_until) VALUES ($1, $2, $3, $4, true, 0, 0)",
          [user.id, salt, hash, randomUUID()]
        );
        return { status: "ok", user, temporaryPassword };
      });
    },
    async updateUser(actorToken, id, input) {
      const payload = parseToken(actorToken, secret);
      if (!payload) return { status: "unauthorized" };
      const { record, assignments } = splitUserFields(input);
      return userAccessTransaction(pool, async (client) => {
        const status = await mayManageUsers(client, payload);
        if (status !== "ok") return { status };
        const user = await updateUserRecord(client, id, record);
        if (!user) return { status: "not_found" };
        if (Object.keys(assignments).length) await setUserAssignments(client, id, assignments);
        return { status: "ok", user };
      });
    },
    async deleteUser(actorToken, id) {
      const payload = parseToken(actorToken, secret);
      if (!payload) return { status: "unauthorized" };
      return userAccessTransaction(pool, async (client) => {
        const status = await mayManageUsers(client, payload);
        if (status !== "ok") return { status };
        return { status: await deleteUserRecord(client, id) ? "ok" : "not_found" };
      });
    }
  };
}
