import { randomUUID } from "node:crypto";

const userColumns = "id, name, email, role_name, branch_code, modules_configured, created_at, updated_at";
const createFields = new Set(["id", "name", "email", "role", "branchCode"]);
const updateFields = new Set(["name", "email", "role", "branchCode"]);

function validateInput(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("User fields must be an object");
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`Unsupported user field: ${key}`);
    if (typeof value !== "string") throw new Error(`${key} must be a string`);
  }
}

function mapUser(row) {
  return {
    id: row.id, name: row.name, email: row.email, role: row.role_name,
    branchCode: row.branch_code, modulesConfigured: row.modules_configured,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString()
  };
}

export async function userAccessTransaction(pool, operation, readOnly = false) {
  const client = await pool.connect();
  let started = false;
  let releaseError;
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    started = true;
    if (!readOnly) await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["portal_access_v1", "user_records"]);
    const result = await operation(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError;
        console.error(`User record transaction rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

async function preventLastAdminRemoval(client, user) {
  if (user.role_name !== "Admin") return;
  const { rows } = await client.query("SELECT count(*)::int AS count FROM portal_access_v1.users WHERE role_name = 'Admin'");
  if (rows[0].count <= 1) {
    const error = new Error("Cannot remove the last Admin");
    error.code = "LAST_ADMIN";
    throw error;
  }
}

export async function createUserRecord(client, input) {
  validateInput(input, createFields);
  if (!input.name?.trim()) throw new Error("Full name is required");
  if (!input.email?.trim()) throw new Error("Email is required");
  const id = input.id === undefined ? randomUUID() : input.id;
  const { rows } = await client.query(
    `INSERT INTO portal_access_v1.users (id, name, email, role_name, branch_code)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${userColumns}`,
    [id, input.name.trim(), input.email.trim(), input.role === undefined ? "Data Entry" : input.role, input.branchCode === undefined ? "CMB" : input.branchCode]
  );
  return mapUser(rows[0]);
}

export async function updateUserRecord(client, id, changes) {
  validateInput(changes, updateFields);
  if (Object.hasOwn(changes, "name") && !changes.name.trim()) throw new Error("Full name is required");
  if (Object.hasOwn(changes, "email") && !changes.email.trim()) throw new Error("Email is required");
  const selected = await client.query(`SELECT ${userColumns} FROM portal_access_v1.users WHERE id = $1 FOR UPDATE`, [id]);
  if (!selected.rows.length) return null;
  const user = selected.rows[0];
  if (changes.role !== undefined && changes.role !== "Admin") await preventLastAdminRemoval(client, user);
  if (!Object.keys(changes).length) return mapUser(user);
  const { rows } = await client.query(
    `UPDATE portal_access_v1.users SET name = $2, email = $3, role_name = $4, branch_code = $5, updated_at = clock_timestamp()
     WHERE id = $1 RETURNING ${userColumns}`,
    [id, changes.name === undefined ? user.name : changes.name.trim(), changes.email === undefined ? user.email : changes.email.trim(), changes.role === undefined ? user.role_name : changes.role, changes.branchCode === undefined ? user.branch_code : changes.branchCode]
  );
  return mapUser(rows[0]);
}

export async function deleteUserRecord(client, id) {
  const selected = await client.query(`SELECT ${userColumns} FROM portal_access_v1.users WHERE id = $1 FOR UPDATE`, [id]);
  if (!selected.rows.length) return false;
  await preventLastAdminRemoval(client, selected.rows[0]);
  await client.query("DELETE FROM portal_access_v1.users WHERE id = $1", [id]);
  return true;
}

export function createUserAccessStore(pool) {
  return {
    async list() {
      const { rows } = await pool.query(`SELECT ${userColumns} FROM portal_access_v1.users ORDER BY created_at, id`);
      return rows.map(mapUser);
    },

    async get(id) {
      const { rows } = await pool.query(`SELECT ${userColumns} FROM portal_access_v1.users WHERE id = $1`, [id]);
      return rows.length ? mapUser(rows[0]) : null;
    },

    async create(input) {
      return userAccessTransaction(pool, (client) => createUserRecord(client, input));
    },

    async update(id, changes) {
      return userAccessTransaction(pool, (client) => updateUserRecord(client, id, changes));
    },

    async delete(id) {
      return userAccessTransaction(pool, (client) => deleteUserRecord(client, id));
    }
  };
}
