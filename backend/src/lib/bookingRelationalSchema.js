import { readFile } from "node:fs/promises";

const tables = {
  bookings: {
    text: "id reference status mode incoterm_code freight_terms origin_code dest_code commodity_code goods_description marks_and_numbers shipper_reference_no notes branch_code cw_org_code shipper_code consignee_code dg_un_number dg_proper_shipping_name dg_class dg_packing_group dg_special_handling pickup_phone pickup_contact pickup_address handling_remarks documents_accompanying cw1_shipment_ref cw_status cw_response cw_last_action created_by_user_id created_by_email created_by updated_by",
    date: "cargo_ready_date cfs_received_at pickup_estimated_pickup pickup_required_date pickup_estimated_delivery pickup_delivery_required_by required_pickup required_etd required_eta requested_delivery client_requested_eta",
    boolean: "cfs_received is_dg pickup_required cw_converted",
    integer: "cw_http_status",
    "timestamp with time zone": "cw_sent_at created_at updated_at completed_at",
    jsonb: "additional_data",
    required: "id reference status additional_data"
  },
  booking_parties: { text: "booking_id party_type code company_name name address1 address2 city state post_code country phone email", jsonb: "additional_data", required: "booking_id party_type additional_data" },
  booking_cargo_lines: { text: "booking_id id package_type_code weight_unit volume_unit hs_code po_numbers order_id commodity_code un_number dg_class", integer: "position", numeric: "packages gross_weight volume", jsonb: "additional_data", required: "booking_id position id additional_data" },
  booking_containers: { text: "booking_id id container_type_code", integer: "position", numeric: "count", jsonb: "additional_data", required: "booking_id position id additional_data" },
  booking_documents: { text: "booking_id id type type_name file_name mime_type uploaded_by", integer: "position", bigint: "size", bytea: "content", jsonb: "additional_data", required: "booking_id position id type file_name size content additional_data" },
  approvals: { text: "id booking_id", jsonb: "data", required: "id booking_id data" },
  imports: { text: "id", jsonb: "data", required: "id data" },
  templates: { text: "id owner_email", jsonb: "data", required: "id owner_email data" },
  preferences: { text: "owner_email preference_type", jsonb: "data", required: "owner_email preference_type data" },
  order_links: { text: "order_id booking_id", required: "order_id booking_id" },
  audit_events: { text: "id actor_id actor_name actor_role action entity_type entity_id", "timestamp with time zone": "occurred_at", jsonb: "before_data after_data", required: "id occurred_at actor_name actor_role action entity_type entity_id" },
  external_operations: { text: "id operation_key kind entity_id entity_ref actor_id actor_name actor_role status", "timestamp with time zone": "started_at resolved_at", jsonb: "details resolution", required: "id operation_key kind entity_id entity_ref actor_name actor_role details status started_at" }
};

const keys = [
  ["bookings", "p", ["id"]], ["bookings", "u", ["reference"]],
  ["booking_parties", "p", ["booking_id", "party_type"]],
  ...["booking_cargo_lines", "booking_containers", "booking_documents"].flatMap((table) => [[table, "p", ["booking_id", "position"]], [table, "u", ["booking_id", "id"]]]),
  ["approvals", "p", ["id"]], ["imports", "p", ["id"]], ["templates", "p", ["id"]],
  ["preferences", "p", ["owner_email", "preference_type"]], ["order_links", "p", ["order_id"]],
  ["audit_events", "p", ["id"]], ["external_operations", "p", ["id"]]
];
const checks = {
  bookings: ["(length(btrim(id)) > 0)", "(length(btrim(reference)) > 0)", "(status = ANY (ARRAY['DRAFT'::text, 'VALIDATED'::text, 'PENDING_APPROVAL'::text, 'APPROVED'::text, 'COMPLETED'::text, 'CANCELLED'::text]))"],
  booking_parties: ["(party_type = ANY (ARRAY['shipper'::text, 'consignee'::text]))"],
  booking_cargo_lines: ['("position" >= 0)', "(length(btrim(id)) > 0)"],
  booking_containers: ['("position" >= 0)', "(length(btrim(id)) > 0)"],
  booking_documents: ['("position" >= 0)', "(length(btrim(id)) > 0)", "(size >= 0)", "(size = octet_length(content))"],
  external_operations: ["(kind = ANY (ARRAY['CW_COMPLETE'::text, 'CW_SEND'::text, 'ORDER_CREATE'::text, 'ORDER_DELETE'::text]))", "(status = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'ABORTED'::text, 'RECONCILED'::text]))", "(jsonb_typeof(details) = 'object'::text)"]
};
for (const table of ["bookings", "booking_parties", "booking_cargo_lines", "booking_containers", "booking_documents"]) {
  checks[table].push("(jsonb_typeof(additional_data) = 'object'::text)");
}
for (const table of ["approvals", "templates", "imports", "preferences"]) checks[table] = [`(jsonb_typeof(data) = '${table === "preferences" ? "array" : "object"}'::text)`];

const grants = {
  bookings: ["SELECT", "INSERT", "UPDATE"],
  booking_parties: ["SELECT", "INSERT", "DELETE"],
  booking_cargo_lines: ["SELECT", "INSERT", "DELETE"],
  booking_containers: ["SELECT", "INSERT", "DELETE"],
  booking_documents: ["SELECT", "INSERT", "DELETE"],
  approvals: ["SELECT", "INSERT", "UPDATE"],
  imports: ["SELECT", "INSERT", "UPDATE"],
  templates: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  preferences: ["SELECT", "INSERT", "UPDATE"],
  order_links: ["SELECT", "INSERT", "DELETE"],
  audit_events: ["SELECT", "INSERT"],
  external_operations: ["SELECT", "INSERT", "UPDATE"]
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function validateSchemaName(schema) {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema) || schema.length > 63) throw new Error("Invalid relational booking schema name");
}

export async function checkRelationalBookingReadiness(client, schema = "booking_portal_v4") {
  validateSchemaName(schema);
  const statements = Object.entries(tables).map(([table, fields]) => {
    const columns = Object.entries(fields).filter(([type]) => type !== "required").flatMap(([, names]) => names.split(" "));
    return `SELECT ${columns.map((name) => `"${name}"`).join(", ")} FROM "${schema}"."${table}" WHERE false`;
  });
  await client.query(statements.join("; "));
}

export async function verifyRelationalBookingSchema(client, schema = "booking_portal_v4") {
  validateSchemaName(schema);
  const { rows } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null,
      a.attidentity AS identity_kind, a.attgenerated AS generated_kind, pg_get_expr(d.adbin, d.adrelid) AS default_expression
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  `, [schema]);
  for (const [table, fields] of Object.entries(tables)) {
    const required = new Set(fields.required.split(" "));
    const expected = new Set(Object.entries(fields).filter(([type]) => type !== "required").flatMap(([, names]) => names.split(" ")));
    const extra = rows.find((row) => row.table_name === table && !expected.has(row.column_name) && row.not_null && !row.default_expression && !row.identity_kind && !row.generated_kind);
    if (extra) throw new Error(`Relational booking schema is incompatible: unexpected required column ${table}.${extra.column_name}`);
    for (const [type, names] of Object.entries(fields)) {
      if (type === "required") continue;
      for (const name of names.split(" ")) {
        const found = rows.find((row) => row.table_name === table && row.column_name === name);
        if (!found || found.type !== type || found.not_null !== required.has(name)) throw new Error(`Relational booking schema is incompatible: ${table}.${name} must be ${type} ${required.has(name) ? "NOT NULL" : "nullable"}`);
      }
      const auditTimestamp = rows.find((row) => row.table_name === "audit_events" && row.column_name === "occurred_at");
      if (auditTimestamp.default_expression !== "now()") throw new Error("Relational booking schema is incompatible: audit_events.occurred_at must default to now()");
      for (const [column, expression] of [["started_at", "now()"], ["status", "'PENDING'::text"]]) {
        if (rows.find((row) => row.table_name === "external_operations" && row.column_name === column).default_expression !== expression) throw new Error(`Relational booking schema is incompatible: external_operations.${column} has an invalid default`);
      }
    }
  }
  const constraints = (await client.query(`
    SELECT t.relname AS table_name, con.contype AS type, con.condeferrable AS deferrable,
      con.confdeltype AS on_delete, pg_get_expr(con.conbin, con.conrelid) AS expression,
      target.relname AS target, target_ns.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns
    FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_class target ON target.oid = con.confrelid
    LEFT JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
    WHERE n.nspname = $1 AND con.convalidated
  `, [schema])).rows;
  for (const [table, type, columns] of keys) {
    if (!constraints.some((row) => row.table_name === table && row.type === type && !row.deferrable && same(row.columns, columns))) throw new Error(`Relational booking schema is incompatible: missing key on ${table} (${columns.join(", ")})`);
  }
  for (const table of ["booking_parties", "booking_cargo_lines", "booking_containers", "booking_documents", "approvals", "order_links"]) {
    const onDelete = table.startsWith("booking_") ? "c" : "a";
    if (!constraints.some((row) => row.table_name === table && row.type === "f" && !row.deferrable && row.on_delete === onDelete && row.target_schema === schema && row.target === "bookings" && same(row.columns, ["booking_id"]) && same(row.target_columns, ["id"]))) throw new Error(`Relational booking schema is incompatible: missing booking relationship on ${table}`);
  }
  for (const [table, expressions] of Object.entries(checks)) {
    for (const expression of expressions) {
      if (!constraints.some((row) => row.table_name === table && row.type === "c" && row.expression === expression)) throw new Error(`Relational booking schema is incompatible: missing check on ${table}: ${expression}`);
    }
    const auditIndex = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_index i
        JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tbl ON tbl.oid = i.indrelid
        JOIN pg_namespace n ON n.oid = tbl.relnamespace
        JOIN pg_am am ON am.oid = idx.relam
        WHERE n.nspname = $1 AND tbl.relname = 'audit_events' AND idx.relname = 'audit_events_newest_idx'
          AND am.amname = 'btree' AND i.indisvalid AND i.indisready AND i.indpred IS NULL
          AND i.indexprs IS NULL AND i.indnkeyatts = 2
          AND pg_get_indexdef(i.indexrelid, 1, true) = 'occurred_at'
          AND pg_get_indexdef(i.indexrelid, 2, true) = 'id'
          AND (i.indoption[0] & 1) = 1 AND (i.indoption[1] & 1) = 1
      ) AS valid
    `, [schema]);
    if (!auditIndex.rows[0].valid) throw new Error("Relational booking schema is incompatible: audit_events newest-first index is missing or invalid");
    const pendingIndex = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
        JOIN pg_class tbl ON tbl.oid = i.indrelid JOIN pg_namespace n ON n.oid = tbl.relnamespace
        JOIN pg_am am ON am.oid = idx.relam
        WHERE n.nspname = $1 AND tbl.relname = 'external_operations' AND idx.relname = 'external_operations_pending_key_idx'
          AND am.amname = 'btree' AND i.indisvalid AND i.indisready AND i.indisunique AND i.indexprs IS NULL
          AND i.indnkeyatts = 1 AND pg_get_indexdef(i.indexrelid, 1, true) = 'operation_key'
          AND pg_get_expr(i.indpred, i.indrelid) = '(status = ''PENDING''::text)'
      ) AS valid
    `, [schema]);
    if (!pendingIndex.rows[0].valid) throw new Error("Relational booking schema is incompatible: external_operations pending key index is missing or invalid");
  }
  const sequence = await client.query("SELECT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'booking_reference_seq' AND c.relkind = 'S') AS exists", [schema]);
  if (!sequence.rows[0].exists) throw new Error("Relational booking reference sequence is missing");
  await checkRelationalBookingReadiness(client, schema);
  const entries = Object.entries(grants).flatMap(([table, privileges]) => privileges.map((privilege) => ({ table, privilege })));
  const result = await client.query(`
    SELECT table_name, privilege, has_table_privilege(format('%I.%I', $1::text, table_name), privilege) AS allowed
    FROM unnest($2::text[], $3::text[]) AS requested(table_name, privilege)
  `, [schema, entries.map((entry) => entry.table), entries.map((entry) => entry.privilege)]);
  const denied = result.rows.find((row) => !row.allowed);
  if (denied) throw new Error(`Relational booking database role lacks ${denied.privilege} on ${denied.table_name}`);
}

export async function initializeRelationalBookingSchema(pool) {
  const schema = await readFile(new URL("../../sql/booking-v4.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["booking_portal_v4_schema"]);
    await client.query(schema);
    await verifyRelationalBookingSchema(client);
    await client.query("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error(`Relational schema rollback failed: ${rollbackError.message}`); }
    }
    throw error;
  } finally { client.release(); }
}
