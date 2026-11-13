import { readFile } from "node:fs/promises";

const tables = {
  provider_tracking_cache: { text: "provider_account provider_environment request_key", jsonb: "result error", "timestamp with time zone": "fetched_at expires_at", required: "provider_account provider_environment request_key fetched_at expires_at" },
  provider_port_cache: { text: "provider_account provider_environment port_code source", jsonb: "result", "timestamp with time zone": "fetched_at expires_at", required: "provider_account provider_environment port_code source result fetched_at expires_at" },
  provider_usage: { text: "provider_account provider_environment", date: "month_start", bigint: "monthly_count", "timestamp with time zone": "blocked_until", required: "provider_account provider_environment month_start monthly_count" },
  provider_request_events: { text: "provider_account provider_environment request_id", "timestamp with time zone": "requested_at", required: "provider_account provider_environment request_id requested_at" },
  provider_fetch_leases: { text: "provider_account provider_environment cache_kind cache_key state", uuid: "lease_id", "timestamp with time zone": "started_at expires_at", required: "provider_account provider_environment cache_kind cache_key lease_id state started_at expires_at" },
  provider_port_retries: { text: "provider_account provider_environment port_code", uuid: "retry_id", "timestamp with time zone": "cache_fetched_at due_at", required: "provider_account provider_environment port_code retry_id cache_fetched_at due_at" }
};
const keys = {
  provider_tracking_cache: ["provider_account", "provider_environment", "request_key"],
  provider_port_cache: ["provider_account", "provider_environment", "port_code"],
  provider_usage: ["provider_account", "provider_environment"],
  provider_request_events: ["provider_account", "provider_environment", "request_id"],
  provider_fetch_leases: ["provider_account", "provider_environment", "cache_kind", "cache_key"],
  provider_port_retries: ["provider_account", "provider_environment", "port_code"]
};
const scopeChecks = [
  "((length(btrim(provider_account)) > 0) AND (provider_account = btrim(provider_account)))",
  "((length(btrim(provider_environment)) > 0) AND (provider_environment = btrim(provider_environment)))"
];
const checks = {
  provider_tracking_cache: [...scopeChecks, "(length(btrim(request_key)) > 0)", "((result IS NULL) OR (jsonb_typeof(result) = 'object'::text))", "((error IS NULL) OR (jsonb_typeof(error) = 'object'::text))", "(expires_at > fetched_at)", "((result IS NULL) <> (error IS NULL))"],
  provider_port_cache: [...scopeChecks, "(port_code ~ '^[A-Z]{2}[A-Z0-9]{3}$'::text)", "(jsonb_typeof(result) = 'object'::text)", "(length(btrim(source)) > 0)", "(expires_at > fetched_at)"],
  provider_usage: [...scopeChecks, "(EXTRACT(day FROM month_start) = (1)::numeric)", "(monthly_count >= 0)"],
  provider_request_events: ["(length(btrim(request_id)) > 0)"],
  provider_fetch_leases: [...scopeChecks, "(cache_kind = ANY (ARRAY['tracking'::text, 'port'::text]))", "(length(btrim(cache_key)) > 0)", "(state = ANY (ARRAY['active'::text, 'uncertain'::text]))", "(expires_at > started_at)"],
  provider_port_retries: [...scopeChecks, "(port_code ~ '^[A-Z]{2}[A-Z0-9]{3}$'::text)"]
};
const indexes = {
  provider_tracking_cache_expiry_idx: ["provider_tracking_cache", ["expires_at"]],
  provider_port_cache_expiry_idx: ["provider_port_cache", ["expires_at"]],
  provider_request_events_window_idx: ["provider_request_events", ["provider_account", "provider_environment", "requested_at"]],
  provider_request_events_expiry_idx: ["provider_request_events", ["requested_at"]],
  provider_fetch_leases_expiry_idx: ["provider_fetch_leases", ["expires_at"]],
  provider_port_retries_due_idx: ["provider_port_retries", ["provider_account", "provider_environment", "due_at"]]
};
const grants = {
  provider_tracking_cache: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  provider_port_cache: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  provider_usage: ["SELECT", "INSERT", "UPDATE"],
  provider_request_events: ["SELECT", "INSERT", "DELETE"],
  provider_fetch_leases: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  provider_port_retries: ["SELECT", "INSERT", "UPDATE", "DELETE"]
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function validateProviderCacheSchemaName(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema.length > 63) throw new Error("Invalid provider cache schema name");
}

async function checkRowSecurity(client, schema) {
  const { rows } = await client.query(`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = ANY($2::text[]) AND c.relkind IN ('r', 'p')`, [schema, Object.keys(tables)]);
  for (const table of Object.keys(tables)) {
    const row = rows.find((item) => item.relname === table);
    if (!row) throw new Error(`Provider cache schema is incompatible: missing table ${table}`);
    if (row.relrowsecurity || row.relforcerowsecurity) throw new Error(`Provider cache schema is incompatible: row security enabled on ${table}`);
  }
}

export async function checkProviderCacheReadiness(client, schema = "booking_portal_v4") {
  validateProviderCacheSchemaName(schema);
  await checkRowSecurity(client, schema);
  const statements = Object.entries(tables).map(([table, fields]) => {
    const columns = Object.entries(fields).filter(([type]) => type !== "required").flatMap(([, names]) => names.split(" "));
    return `SELECT ${columns.map((name) => `"${name}"`).join(", ")} FROM "${schema}"."${table}" WHERE false`;
  });
  await client.query(statements.join("; "));
}

export async function verifyProviderCacheSchema(client, schema = "booking_portal_v4") {
  validateProviderCacheSchemaName(schema);
  const { rows: columns } = await client.query(`SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
      a.attidentity AS identity_kind, a.attgenerated AS generated_kind,
      pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped`, [schema]);
  for (const [table, fields] of Object.entries(tables)) {
    const required = new Set(fields.required.split(" "));
    const expected = new Set(Object.entries(fields).filter(([type]) => type !== "required").flatMap(([, names]) => names.split(" ")));
    const unexpected = columns.find((row) => row.table_name === table && !expected.has(row.column_name));
    if (unexpected) throw new Error(`Provider cache schema is incompatible: unexpected column ${table}.${unexpected.column_name}`);
    for (const [type, names] of Object.entries(fields)) {
      if (type === "required") continue;
      for (const name of names.split(" ")) {
        const row = columns.find((item) => item.table_name === table && item.column_name === name);
        const defaultExpression = table === "provider_usage" && name === "monthly_count" ? "0" : null;
        if (!row || row.type !== type || row.not_null !== required.has(name) || row.identity_kind || row.generated_kind || row.default_expression !== defaultExpression) {
          throw new Error(`Provider cache schema is incompatible: invalid column ${table}.${name}`);
        }
      }
    }
  }
  const { rows: constraints } = await client.query(`SELECT t.relname AS table_name, con.contype AS type,
      con.condeferrable AS deferrable, con.convalidated AS validated, con.confdeltype AS on_delete,
      con.confupdtype AS on_update, target.relname AS target, target_ns.nspname AS target_schema,
      idx.indisvalid AS index_valid, idx.indisready AS index_ready, idx.indimmediate AS index_immediate,
      pg_get_expr(con.conbin, con.conrelid) AS expression,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns
    FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_class target ON target.oid = con.confrelid
    LEFT JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
    LEFT JOIN pg_index idx ON idx.indexrelid = con.conindid
    WHERE n.nspname = $1 AND t.relname = ANY($2::text[]) AND con.contype IN ('p', 'u', 'f', 'c', 'x')`, [schema, Object.keys(tables)]);
  for (const [table, fields] of Object.entries(keys)) {
    if (!constraints.some((row) => row.table_name === table && row.type === "p" && row.validated && !row.deferrable && row.index_valid && row.index_ready && row.index_immediate && same(row.columns, fields))) throw new Error(`Provider cache schema is incompatible: missing primary key on ${table}`);
    for (const expression of checks[table]) {
      if (!constraints.some((row) => row.table_name === table && row.type === "c" && row.validated && row.expression === expression)) throw new Error(`Provider cache schema is incompatible: missing check on ${table}: ${expression}`);
    }
    const count = 1 + checks[table].length + (["provider_request_events", "provider_fetch_leases", "provider_port_retries"].includes(table) ? 1 : 0);
    if (constraints.filter((row) => row.table_name === table).length !== count) throw new Error(`Provider cache schema is incompatible: unexpected constraints on ${table}`);
  }
  if (!constraints.some((row) => row.table_name === "provider_fetch_leases" && row.type === "u" && row.validated && !row.deferrable && row.index_valid && row.index_ready && row.index_immediate && same(row.columns, ["lease_id"]))) {
    throw new Error("Provider cache schema is incompatible: missing unique lease identifier");
  }
  if (!constraints.some((row) => row.table_name === "provider_port_retries" && row.type === "u" && row.validated && !row.deferrable && row.index_valid && row.index_ready && row.index_immediate && same(row.columns, ["retry_id"]))) {
    throw new Error("Provider cache schema is incompatible: missing unique retry identifier");
  }
  if (!constraints.some((row) => row.table_name === "provider_request_events" && row.type === "f" && row.validated && !row.deferrable && row.on_delete === "c" && row.on_update === "a" && row.target_schema === schema && row.target === "provider_usage" && same(row.columns, keys.provider_usage) && same(row.target_columns, keys.provider_usage))) {
    throw new Error("Provider cache schema is incompatible: missing usage relationship");
  }
  const { rows: indexRows } = await client.query(`SELECT idx.relname AS index_name, tbl.relname AS table_name,
      am.amname, i.indisvalid, i.indisready, i.indnkeyatts, i.indnatts,
      i.indpred IS NULL AS unfiltered, i.indexprs IS NULL AS plain,
      ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, true) FROM generate_series(1, i.indnkeyatts) AS n) AS columns,
      ARRAY(SELECT i.indoption[n]::integer FROM generate_series(0, i.indnkeyatts - 1) AS n) AS options
    FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_class tbl ON tbl.oid = i.indrelid JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
    JOIN pg_am am ON am.oid = idx.relam WHERE ns.nspname = $1 AND idx.relname = ANY($2::text[])`,
  [schema, Object.keys(indexes)]);
  for (const [name, [table, fields]] of Object.entries(indexes)) {
    const row = indexRows.find((item) => item.index_name === name);
    if (!row || row.table_name !== table || row.amname !== "btree" || !row.indisvalid || !row.indisready || !row.unfiltered || !row.plain || row.indnkeyatts !== fields.length || row.indnatts !== fields.length || !same(row.columns, fields) || !row.options.every((option) => option === 0)) throw new Error(`Provider cache schema is incompatible: missing or invalid index ${name}`);
  }
  const { rows: usage } = await client.query("SELECT has_schema_privilege($1, 'USAGE') AS allowed", [schema]);
  if (!usage[0]?.allowed) throw new Error("Provider cache database role lacks schema USAGE");
  await checkRowSecurity(client, schema);
  const entries = Object.entries(grants).flatMap(([table, privileges]) => privileges.map((privilege) => ({ table, privilege })));
  const { rows: privileges } = await client.query(`SELECT table_name, privilege, has_table_privilege(format('%I.%I', $1::text, table_name), privilege) AS allowed
    FROM unnest($2::text[], $3::text[]) AS requested(table_name, privilege)`,
  [schema, entries.map((entry) => entry.table), entries.map((entry) => entry.privilege)]);
  for (const entry of entries) {
    if (!privileges.some((row) => row.table_name === entry.table && row.privilege === entry.privilege && row.allowed)) throw new Error(`Provider cache database role lacks ${entry.privilege} on ${entry.table}`);
  }
  await checkProviderCacheReadiness(client, schema);
}

export async function initializeProviderCacheSchema(pool, schema = "booking_portal_v4") {
  validateProviderCacheSchemaName(schema);
  const ddl = (await readFile(new URL("../../sql/provider-cache-v1.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema);
  const client = await pool.connect();
  let started = false;
  let releaseError;
  try {
    await client.query("BEGIN");
    started = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`provider_cache_schema:${schema}`]);
    await client.query(ddl);
    await verifyProviderCacheSchema(client, schema);
    await client.query("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { releaseError = rollbackError; console.error(`Provider cache schema rollback failed: ${rollbackError.message}`); }
    }
    throw error;
  } finally { client.release(releaseError); }
}
