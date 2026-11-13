import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { FIELD_CATALOG } from "../src/fieldVisibilityCatalog.js";

const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
function columnFor(field) {
  const [group, key] = field.split(".");
  if (!key) return [group === "documents" ? "booking_documents" : "bookings", group === "documents" ? "content" : snake(group)];
  if (group === "shipper" || group === "consignee") return ["booking_parties", snake(key)];
  if (group === "cargoLines") return ["booking_cargo_lines", snake(key)];
  if (group === "containers") return ["booking_containers", snake(key)];
  if (group === "dates") return ["bookings", snake(key)];
  if (group === "dg" && key === "dgClass") return ["bookings", "dg_class"];
  return ["bookings", `${snake(group)}_${snake(key)}`];
}

test("relational booking schema stores scalar fields and related records", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const sql = (await readFile(new URL("../sql/booking-v4.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(sql);
    await client.query(sql);
    const columnRows = await client.query("SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1", [schema]);
    const columns = new Map(columnRows.rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
    for (const field of FIELD_CATALOG.booking) {
      const [table, column] = columnFor(field.key);
      assert.ok(columns.has(`${table}.${column}`), `${field.key} is missing ${table}.${column}`);
    }
    for (const [table, column, type] of [
      ["bookings", "cargo_ready_date", "date"], ["bookings", "created_at", "timestamp with time zone"],
      ["bookings", "cfs_received", "boolean"], ["booking_cargo_lines", "gross_weight", "numeric"],
      ["booking_containers", "count", "numeric"], ["booking_documents", "content", "bytea"],
      ["booking_documents", "size", "bigint"]
    ]) assert.equal(columns.get(`${table}.${column}`).data_type, type);
    for (const [column, type, nullable] of [
      ["id", "text", "NO"], ["occurred_at", "timestamp with time zone", "NO"],
      ["actor_id", "text", "YES"], ["actor_name", "text", "NO"], ["actor_role", "text", "NO"],
      ["action", "text", "NO"], ["entity_type", "text", "NO"], ["entity_id", "text", "NO"],
      ["before_data", "jsonb", "YES"], ["after_data", "jsonb", "YES"]
    ]) {
      const field = columns.get(`audit_events.${column}`);
      assert.ok(field, `audit_events.${column} is missing`);
      assert.equal(field.data_type, type);
      assert.equal(field.is_nullable, nullable);
    }
    const auditIndex = await client.query("SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'audit_events_newest_idx'", [schema]);
    assert.match(auditIndex.rows[0].indexdef, /\(occurred_at DESC, id DESC\)/);
    await client.query(`INSERT INTO ${schema}.audit_events (id, actor_name, actor_role, action, entity_type, entity_id, before_data, after_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, ["audit-1", "User", "Admin", "UPDATE", "Booking", "BK-1", { status: "DRAFT" }, { status: "VALIDATED" }]);
    const audit = (await client.query(`SELECT occurred_at, before_data, after_data FROM ${schema}.audit_events WHERE id = $1`, ["audit-1"])).rows[0];
    assert.ok(audit.occurred_at instanceof Date);
    assert.deepEqual(audit.before_data, { status: "DRAFT" });
    assert.deepEqual(audit.after_data, { status: "VALIDATED" });
    assert.ok(!columns.has("bookings.data"));
    await client.query(`INSERT INTO ${schema}.bookings (id, reference, status, cargo_ready_date) VALUES ($1, $2, $3, $4)`, ["booking", "reference", "DRAFT", "2027-01-01"]);
    await client.query(`INSERT INTO ${schema}.bookings (id, reference) VALUES ($1, $2)`, ["empty-draft", "reference-2"]);
    assert.equal((await client.query(`SELECT status FROM ${schema}.bookings WHERE id = $1`, ["empty-draft"])).rows[0].status, "DRAFT");
    await client.query(`INSERT INTO ${schema}.booking_parties (booking_id, party_type, company_name) VALUES ($1, $2, $3)`, ["booking", "shipper", "test"]);
    await client.query(`INSERT INTO ${schema}.booking_cargo_lines (booking_id, position, id, packages, gross_weight) VALUES ($1, $2, $3, $4, $5)`, ["booking", 0, "line-1", 3, 10.5]);
    await client.query(`INSERT INTO ${schema}.booking_cargo_lines (booking_id, position, id, packages, gross_weight) VALUES ($1, $2, $3, $4, $5)`, ["empty-draft", 0, "draft-line", 0, 0]);
    await client.query(`INSERT INTO ${schema}.booking_containers (booking_id, position, id, count) VALUES ($1, $2, $3, $4)`, ["booking", 0, "container-1", 0]);
    await client.query(`INSERT INTO ${schema}.booking_documents (booking_id, position, id, type, file_name, size, content) VALUES ($1, $2, $3, $4, $5, $6, $7)`, ["booking", 0, "doc-1", "DOC", "test.txt", 4, Buffer.from("test")]);
    const { rows } = await client.query(`SELECT b.status, b.cargo_ready_date::text, c.packages::text, c.gross_weight::text, d.content FROM ${schema}.bookings b JOIN ${schema}.booking_cargo_lines c ON c.booking_id = b.id JOIN ${schema}.booking_documents d ON d.booking_id = b.id WHERE b.id = $1`, ["booking"]);
    assert.equal(rows[0].status, "DRAFT");
    assert.equal(rows[0].cargo_ready_date, "2027-01-01");
    assert.equal(rows[0].packages, "3");
    assert.equal(rows[0].gross_weight, "10.5");
    assert.equal(rows[0].content.toString(), "test");
    async function rejects(sql, params, code) {
      await client.query("SAVEPOINT expected_failure");
      await assert.rejects(client.query(sql, params), { code });
      await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    }
    await rejects(`INSERT INTO ${schema}.booking_cargo_lines (booking_id, position, id) VALUES ($1, 0, 'line')`, ["missing"], "23503");
    await rejects(`INSERT INTO ${schema}.booking_cargo_lines (booking_id, position, id) VALUES ($1, 1, 'line-1')`, ["booking"], "23505");
    await rejects(`INSERT INTO ${schema}.booking_containers (booking_id, position, id) VALUES ($1, -1, 'container-2')`, ["booking"], "23514");
    await rejects(`INSERT INTO ${schema}.booking_parties (booking_id, party_type) VALUES ($1, 'other')`, ["booking"], "23514");
    await rejects(`UPDATE ${schema}.bookings SET status = 'INVALID' WHERE id = $1`, ["booking"], "23514");
    await rejects(`INSERT INTO ${schema}.bookings (id, reference) VALUES ($1, $2)`, ["booking-2", "reference"], "23505");
    await rejects(`INSERT INTO ${schema}.booking_documents (booking_id, position, id, type, file_name, size, content) VALUES ($1, 1, 'doc-2', 'DOC', 'bad.txt', 5, $2)`, ["booking", Buffer.from("test")], "23514");
    await rejects(`INSERT INTO ${schema}.booking_documents (booking_id, position, id, type, file_name, size, content) VALUES ($1, 1, 'doc-1', 'DOC', 'duplicate.txt', 0, $2)`, ["booking", Buffer.alloc(0)], "23505");
    await rejects(`UPDATE ${schema}.bookings SET additional_data = '[]'::jsonb WHERE id = $1`, ["booking"], "23514");
    await client.query(`INSERT INTO ${schema}.approvals (id, booking_id, data) VALUES ($1, $2, $3)`, ["approval", "booking", { status: "PENDING" }]);
    await rejects(`DELETE FROM ${schema}.bookings WHERE id = $1`, ["booking"], "23503");
    await client.query(`DELETE FROM ${schema}.approvals WHERE id = $1`, ["approval"]);
    await client.query(`INSERT INTO ${schema}.order_links (order_id, booking_id) VALUES ($1, $2)`, ["order", "booking"]);
    await rejects(`INSERT INTO ${schema}.order_links (order_id, booking_id) VALUES ($1, $2)`, ["order", "empty-draft"], "23505");
    await client.query(`DELETE FROM ${schema}.order_links WHERE order_id = $1`, ["order"]);
    await client.query(`DELETE FROM ${schema}.bookings WHERE id = $1`, ["booking"]);
    for (const table of ["booking_parties", "booking_cargo_lines", "booking_containers", "booking_documents"]) {
      assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.${table} WHERE booking_id = $1`, ["booking"])).rows[0].count, 0);
    }
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
