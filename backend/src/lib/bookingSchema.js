import { readFile } from "node:fs/promises";

const tables = {
  bookings: { id: "text", reference: "text", data: "jsonb" },
  approvals: { id: "text", booking_id: "text", data: "jsonb" },
  templates: { id: "text", owner_email: "text", data: "jsonb" },
  imports: { id: "text", data: "jsonb" },
  preferences: { owner_email: "text", preference_type: "text", data: "jsonb" },
  order_links: { order_id: "text", booking_id: "text" }
};

const keys = [
  ["bookings", "p", ["id"]], ["bookings", "u", ["reference"]],
  ["approvals", "p", ["id"]], ["templates", "p", ["id"]], ["imports", "p", ["id"]],
  ["preferences", "p", ["owner_email", "preference_type"]], ["order_links", "p", ["order_id"]]
];

export async function verifyBookingSchema(client) {
  const { rows } = await client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS not_null
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'booking_portal_v3' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  `);
  for (const [table, columns] of Object.entries(tables)) {
    for (const [name, type] of Object.entries(columns)) {
      if (!rows.some((row) => row.table_name === table && row.column_name === name && row.type === type && row.not_null)) {
        throw new Error(`Booking schema is incompatible: ${table}.${name} must be ${type} NOT NULL`);
      }
    }
  }
  const constraints = await client.query(`
    SELECT t.relname AS table_name, con.contype AS type, con.condeferrable AS deferrable, pg_get_expr(con.conbin, con.conrelid) AS expression, target.relname AS target, target_ns.nspname AS target_schema,
      ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord) AS columns,
      ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY AS k(num, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.num ORDER BY k.ord) AS target_columns
    FROM pg_constraint con JOIN pg_class t ON t.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_class target ON target.oid = con.confrelid
    LEFT JOIN pg_namespace target_ns ON target_ns.oid = target.relnamespace
    WHERE n.nspname = 'booking_portal_v3' AND con.convalidated
  `);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  for (const [table, type, columns] of keys) {
    if (!constraints.rows.some((row) => row.table_name === table && row.type === type && !row.deferrable && same(row.columns, columns))) {
      throw new Error(`Booking schema is incompatible: missing key on ${table} (${columns.join(", ")})`);
    }
  }
  for (const table of ["approvals", "order_links"]) {
    if (!constraints.rows.some((row) => row.table_name === table && row.type === "f" && row.target_schema === "booking_portal_v3" && row.target === "bookings" && same(row.columns, ["booking_id"]) && same(row.target_columns, ["id"]))) {
      throw new Error(`Booking schema is incompatible: missing booking relationship on ${table}`);
    }
    for (const [table, kind] of [["bookings", "object"], ["approvals", "object"], ["templates", "object"], ["imports", "object"], ["preferences", "array"]]) {
      const expression = `(jsonb_typeof(data) = '${kind}'::text)`;
      if (!constraints.rows.some((row) => row.table_name === table && row.type === "c" && row.expression === expression)) {
        throw new Error(`Booking schema is incompatible: missing JSON ${kind} check on ${table}`);
      }
    }
  }
  await checkBookingReadiness(client);
  const grants = {
    bookings: ["SELECT", "INSERT", "UPDATE"],
    approvals: ["SELECT", "INSERT", "UPDATE"],
    templates: ["SELECT", "INSERT", "UPDATE", "DELETE"],
    imports: ["SELECT", "INSERT", "UPDATE"],
    preferences: ["SELECT", "INSERT", "UPDATE"],
    order_links: ["SELECT", "INSERT", "DELETE"]
  };
  for (const [table, privileges] of Object.entries(grants)) {
    for (const privilege of privileges) {
      const result = await client.query("SELECT has_table_privilege($1, $2) AS allowed", [`booking_portal_v3.${table}`, privilege]);
      if (!result.rows[0].allowed) throw new Error(`Booking database role lacks ${privilege} on ${table}`);
    }
  }
}

export async function checkBookingReadiness(client) {
  await client.query(`
    SELECT id, reference, data FROM booking_portal_v3.bookings WHERE false;
    SELECT id, booking_id, data FROM booking_portal_v3.approvals WHERE false;
    SELECT id, owner_email, data FROM booking_portal_v3.templates WHERE false;
    SELECT id, data FROM booking_portal_v3.imports WHERE false;
    SELECT owner_email, preference_type, data FROM booking_portal_v3.preferences WHERE false;
    SELECT order_id, booking_id FROM booking_portal_v3.order_links WHERE false
  `);
  const result = await client.query("SELECT to_regclass('booking_portal_v3.booking_reference_seq') IS NOT NULL AND COALESCE(has_sequence_privilege(to_regclass('booking_portal_v3.booking_reference_seq'), 'USAGE, UPDATE'), false) AS allowed");
  if (!result.rows[0].allowed) throw new Error("Booking reference sequence is unavailable or not writable");
}

export async function initializeBookingSchema(pool) {
  const schema = await readFile(new URL("../../sql/booking-v3.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["booking_portal_v3_schema"]);
    await client.query(schema);
    await verifyBookingSchema(client);
    await client.query("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error(`Schema rollback failed: ${rollbackError.message}`); }
    }
    throw error;
  } finally {
    client.release();
  }
}
