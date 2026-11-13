import { readFile } from "node:fs/promises";

const tables = {
  roles: { name: "text", description: "text", builtin: "boolean" },
  permissions: { code: "text", label: "text" },
  modules: { code: "text", label: "text" },
  users: { id: "uuid", name: "text", email: "text", role_name: "text", branch_code: "text", modules_configured: "boolean", created_at: "timestamp with time zone", updated_at: "timestamp with time zone" },
  user_credentials: { user_id: "uuid", password_salt: "bytea", password_hash: "bytea", session_version: "uuid", must_change: "boolean", failed_attempts: "integer", locked_until: "bigint" },
  role_permissions: { role_name: "text", permission_code: "text" },
  role_modules: { role_name: "text", module_code: "text", position: "integer" },
  user_modules: { user_id: "uuid", module_code: "text", position: "integer" },
  user_organization_scopes: { user_id: "uuid", scope_type: "text", organization_code: "text", position: "integer" },
  approval_rule_configurations: { id: "uuid", name: "text", enabled: "boolean", rules: "jsonb", created_at: "timestamp with time zone", updated_at: "timestamp with time zone" },
  visibility_profiles: { id: "uuid", name: "text", module: "text", hidden_fields: "jsonb" },
  user_rule_assignments: { user_id: "uuid", configuration_id: "uuid" },
  user_visibility_assignments: { user_id: "uuid", module: "text", profile_id: "uuid" }
};
export const USER_ACCESS_TABLES = Object.freeze(Object.keys(tables));
const keys = [
  ["roles", "p", ["name"]], ["permissions", "p", ["code"]], ["modules", "p", ["code"]], ["users", "p", ["id"]],
  ["user_credentials", "p", ["user_id"]],
  ["role_permissions", "p", ["role_name", "permission_code"]],
  ["role_modules", "p", ["role_name", "module_code"]], ["role_modules", "u", ["role_name", "position"]],
  ["user_modules", "p", ["user_id", "module_code"]], ["user_modules", "u", ["user_id", "position"]],
  ["user_organization_scopes", "p", ["user_id", "scope_type", "organization_code"]],
  ["user_organization_scopes", "u", ["user_id", "scope_type", "position"]],
  ["approval_rule_configurations", "p", ["id"]], ["visibility_profiles", "p", ["id"]],
  ["visibility_profiles", "u", ["id", "module"]], ["user_rule_assignments", "p", ["user_id"]],
  ["user_visibility_assignments", "p", ["user_id", "module"]]
];
const relationships = [
  ["users", "role_name", "roles", "name", "a"],
  ["user_credentials", "user_id", "users", "id", "c"],
  ["role_permissions", "role_name", "roles", "name", "c"], ["role_permissions", "permission_code", "permissions", "code", "a"],
  ["role_modules", "role_name", "roles", "name", "c"], ["role_modules", "module_code", "modules", "code", "a"],
  ["user_modules", "user_id", "users", "id", "c"], ["user_modules", "module_code", "modules", "code", "a"],
  ["user_organization_scopes", "user_id", "users", "id", "c"],
  ["user_rule_assignments", "user_id", "users", "id", "c"],
  ["user_rule_assignments", "configuration_id", "approval_rule_configurations", "id", "a"],
  ["user_visibility_assignments", "user_id", "users", "id", "c"],
  ["user_visibility_assignments", ["profile_id", "module"], "visibility_profiles", ["id", "module"], "a"]
];
const checks = {
  roles: ["((name = btrim(name)) AND (length(name) > 0))"],
  permissions: ["((code = btrim(code)) AND (length(code) > 0))", "(length(btrim(label)) > 0)"],
  modules: ["((code = btrim(code)) AND (length(code) > 0))", "(length(btrim(label)) > 0)"],
  users: ["(length(btrim(name)) > 0)", "((email = btrim(email)) AND (email ~ '^[^[:space:]@]+@[^[:space:]@]+\\.[^[:space:]@]+$'::text))"],
  user_credentials: ["(octet_length(password_salt) = 16)", "(octet_length(password_hash) = 64)", "((failed_attempts >= 0) AND (failed_attempts < 5))", "(locked_until >= 0)"],
  role_modules: ['("position" >= 0)'],
  user_modules: ['("position" >= 0)'],
  user_organization_scopes: ['("position" >= 0)', "((organization_code = btrim(organization_code)) AND (length(organization_code) > 0))", "(scope_type = ANY (ARRAY['booking'::text, 'booking_shipper'::text, 'booking_consignee'::text, 'order'::text, 'order_supplier'::text, 'order_buyer'::text, 'tracking'::text]))"],
  approval_rule_configurations: ["(length(btrim(name)) > 0)", "(jsonb_typeof(rules) = 'array'::text)"],
  visibility_profiles: ["(length(btrim(name)) > 0)", "(module = ANY (ARRAY['booking'::text, 'order'::text]))", "(jsonb_typeof(hidden_fields) = 'array'::text)"]
};
const defaults = { "roles.description": "''::text", "roles.builtin": "false", "users.branch_code": "'CMB'::text", "users.modules_configured": "false", "users.created_at": "now()", "users.updated_at": "now()", "approval_rule_configurations.created_at": "now()", "approval_rule_configurations.updated_at": "now()" };
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function validateSchema(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema.length > 63) throw new Error("Invalid user access schema name");
}

export async function verifyNoUserAccessRowSecurity(client, schema = "portal_access_v1") {
  validateSchema(schema);
  const { rows } = await client.query(`
    SELECT c.relname AS table_name, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')
  `, [schema, USER_ACCESS_TABLES]);
  const missing = USER_ACCESS_TABLES.find((table) => !rows.some((row) => row.table_name === table));
  const secured = rows.find((row) => row.relrowsecurity || row.relforcerowsecurity);
  if (missing || secured) {
    const error = new Error(missing ? `User access schema is incompatible: missing table ${missing}` : `User access schema is incompatible: row security enabled on ${secured.table_name}`);
    error.code = "ACCESS_SCHEMA_INCOMPATIBLE";
    throw error;
  }
}

export async function verifyUserAccessSchema(client, schema = "portal_access_v1") {
  validateSchema(schema);
  const columns = (await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null, a.attidentity AS identity_kind, a.attgenerated AS generated_kind,
      pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  `, [schema])).rows;
  for (const [table, fields] of Object.entries(tables)) {
    const unexpected = columns.find((row) => row.table_name === table && !Object.hasOwn(fields, row.column_name));
    if (unexpected) throw new Error(`User access schema is incompatible: unexpected column ${table}.${unexpected.column_name}`);
    for (const [name, type] of Object.entries(fields)) {
      const found = columns.find((row) => row.table_name === table && row.column_name === name);
      if (!found || found.type !== type || !found.not_null || found.identity_kind || found.generated_kind) throw new Error(`User access schema is incompatible: ${table}.${name} must be ${type} NOT NULL`);
      const expectedDefault = defaults[`${table}.${name}`] || null;
      if (found.default_expression !== expectedDefault) throw new Error(`User access schema is incompatible: invalid default on ${table}.${name}`);
    }
  }
  const constraints = (await client.query(`
    SELECT t.relname AS table_name, con.contype AS type, con.condeferrable AS deferrable, con.convalidated AS validated,
      idx.indisvalid AS index_valid, idx.indisready AS index_ready, idx.indimmediate AS index_immediate,
      con.confdeltype AS on_delete, con.confupdtype AS on_update, pg_get_expr(con.conbin, con.conrelid) AS expression,
      target.relname AS target, target_ns.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns
    FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_class target ON target.oid = con.confrelid
    LEFT JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
    LEFT JOIN pg_index idx ON idx.indexrelid = con.conindid
    WHERE n.nspname = $1 AND con.contype IN ('p', 'u', 'f', 'c', 'x')
  `, [schema])).rows;
  if (constraints.some((row) => Object.hasOwn(tables, row.table_name) && !row.validated)) throw new Error("User access schema is incompatible: unvalidated constraint");
  for (const [table, type, fields] of keys) {
    if (!constraints.some((row) => row.table_name === table && row.type === type && !row.deferrable && row.index_valid && row.index_ready && row.index_immediate && same(row.columns, fields))) throw new Error(`User access schema is incompatible: missing key on ${table} (${fields.join(", ")})`);
  }
  for (const [table, field, target, targetField, onDelete] of relationships) {
    if (!constraints.some((row) => row.table_name === table && row.type === "f" && !row.deferrable && row.on_delete === onDelete && row.on_update === "a" && row.target_schema === schema && row.target === target && same(row.columns, Array.isArray(field) ? field : [field]) && same(row.target_columns, Array.isArray(targetField) ? targetField : [targetField]))) throw new Error(`User access schema is incompatible: missing relationship ${table}.${field}`);
  }
  for (const [table, expressions] of Object.entries(checks)) {
    for (const expression of expressions) {
      if (!constraints.some((row) => row.table_name === table && row.type === "c" && row.expression === expression)) throw new Error(`User access schema is incompatible: missing check on ${table}: ${expression}`);
    }
  }
  for (const table of Object.keys(tables)) {
    const expected = keys.filter((item) => item[0] === table).length + relationships.filter((item) => item[0] === table).length + (checks[table]?.length || 0);
    if (constraints.filter((row) => row.table_name === table).length !== expected) throw new Error(`User access schema is incompatible: unexpected constraints on ${table}`);
  }
  const indexes = (await client.query(`
    SELECT i.indisunique AS unique_index, i.indisvalid AS valid, i.indisready AS ready,
      i.indimmediate AS immediate, i.indnkeyatts AS key_count, i.indnatts AS total_count,
      pg_get_expr(i.indpred, i.indrelid) AS predicate, pg_get_indexdef(i.indexrelid, 1, true) AS key_expression
    FROM pg_index i JOIN pg_class t ON t.oid = i.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = $1 AND t.relname = 'users'
  `, [schema])).rows;
  if (!indexes.some((row) => row.unique_index && row.valid && row.ready && row.immediate && row.key_count === 1 && row.total_count === 1 && !row.predicate && row.key_expression === "lower(email)")) throw new Error("User access schema is incompatible: missing case-insensitive unique email index");
  const usage = await client.query("SELECT has_schema_privilege($1, 'USAGE') AS allowed", [schema]);
  if (!usage.rows[0].allowed) throw new Error("User access database role lacks schema USAGE");
  await verifyNoUserAccessRowSecurity(client, schema);
  const privileges = Object.keys(tables).flatMap((table) => ["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => ({ table, privilege })));
  const grants = await client.query(`
    SELECT table_name, privilege, has_table_privilege(format('%I.%I', $1::text, table_name), privilege) AS allowed
    FROM unnest($2::text[], $3::text[]) AS requested(table_name, privilege)
  `, [schema, privileges.map((item) => item.table), privileges.map((item) => item.privilege)]);
  for (const { table, privilege } of privileges) {
    if (!grants.rows.some((row) => row.table_name === table && row.privilege === privilege && row.allowed)) throw new Error(`User access database role lacks ${privilege} on ${table}`);
  }
}

export async function initializeUserAccessSchema(pool) {
  const sql = await readFile(new URL("../../sql/user-access-v1.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  let started = false;
  let releaseError;
  try {
    await client.query("BEGIN");
    started = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["portal_access_v1_schema"]);
    await client.query(sql);
    await verifyUserAccessSchema(client);
    await client.query("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) {
        releaseError = rollbackError;
        console.error(`User access schema rollback failed: ${rollbackError.message}`);
      }
    }
    throw error;
  } finally { client.release(releaseError); }
}
