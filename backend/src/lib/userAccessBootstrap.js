import { randomBytes, randomUUID } from "node:crypto";
import { userAccessTransaction } from "./userAccessStore.js";
import { initializeAccessCatalogs } from "./userAccessSettingsStore.js";
import { defaultRoles } from "../rbac.js";
import { validatePasswordStrength } from "./passwordPolicy.js";
import { DEFAULT_APPROVAL_ID, initializeDefaultApproval, setUserAssignments } from "./accessConfigurationStore.js";
import { passwordHash } from "./passwordHash.js";

export async function bootstrapUserAccess(pool, { name, email, password }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Administrator name is required");
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error("A valid administrator email is required");
  const error = validatePasswordStrength(password);
  if (error) throw new Error(error);
  const salt = randomBytes(16);
  const hash = await passwordHash(password, salt);
  return userAccessTransaction(pool, async (client) => {
    const { rows } = await client.query("SELECT EXISTS (SELECT 1 FROM portal_access_v1.users) AS has_users");
    if (rows[0].has_users) throw new Error("Bootstrap refused: user records already exist");
    await initializeAccessCatalogs(client);
    await initializeDefaultApproval(client);
    const grants = await client.query("SELECT permission_code FROM portal_access_v1.role_permissions WHERE role_name = 'Admin'");
    const modules = await client.query("SELECT module_code FROM portal_access_v1.role_modules WHERE role_name = 'Admin'");
    const adminRole = defaultRoles().Admin;
    if (adminRole.permissions.some((code) => !grants.rows.some((row) => row.permission_code === code)) ||
        adminRole.modules.some((code) => !modules.rows.some((row) => row.module_code === code))) {
      throw new Error("Bootstrap refused: existing Admin role is missing required grants");
    }
    const id = randomUUID();
    await client.query("INSERT INTO portal_access_v1.users (id, name, email, role_name) VALUES ($1, $2, $3, 'Admin')", [id, name.trim(), email.trim()]);
    await setUserAssignments(client, id, { ruleConfigurationId: DEFAULT_APPROVAL_ID });
    await client.query(
      "INSERT INTO portal_access_v1.user_credentials (user_id, password_salt, password_hash, session_version, must_change, failed_attempts, locked_until) VALUES ($1, $2, $3, $4, true, 0, 0)",
      [id, salt, hash, randomUUID()]
    );
    return { id, name: name.trim(), email: email.trim() };
  });
}
