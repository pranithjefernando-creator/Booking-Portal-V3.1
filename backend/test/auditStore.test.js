import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createAuditStore } from "../src/lib/auditStore.js";

test("audit store validates events and propagates database errors", async () => {
  const failure = new Error("database unavailable");
  const store = createAuditStore({ query: async () => { throw failure; } });
  await assert.rejects(store.append({ action: "", entityType: "Booking", entityId: "BK-1" }), /Audit action is required/);
  await assert.rejects(store.append({ action: "CREATE", entityType: "Booking", entityId: "BK-1", after: () => {} }), /JSON serializable/);
  await assert.rejects(store.append({ action: "CREATE", entityType: "Booking", entityId: "BK-1" }), (error) => error === failure);
  await assert.rejects(store.list(), (error) => error === failure);
});

test("audit store saves events and lists the latest 200 with the full count", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const ddl = (await readFile(new URL("../sql/booking-v4.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(ddl);
    const database = { query: (sql, params) => client.query(sql.replaceAll("booking_portal_v4", schema), params) };
    const store = createAuditStore(database);
    assert.deepEqual(await store.list(), { total: 0, items: [] });
    const event = await store.append({
      user: { id: "user-1", name: "User", role: "Admin" },
      action: "UPDATE", entityType: "Booking", entityId: "BK-1",
      before: { status: "DRAFT" }, after: ["VALIDATED"]
    });
    assert.equal(event.actorName, "User");
    assert.equal(event.actorRole, "Admin");
    assert.deepEqual(event.before, { status: "DRAFT" });
    assert.deepEqual(event.after, ["VALIDATED"]);
    assert.equal(new Date(event.occurredAt).toISOString(), event.occurredAt);
    assert.equal((await client.query(`SELECT actor_id FROM ${schema}.audit_events WHERE id = $1`, [event.id])).rows[0].actor_id, "user-1");
    assert.deepEqual(await store.list(), { total: 1, items: [event] });
    const systemEvent = await store.append({ action: "SEED", entityType: "System", entityId: "-" });
    assert.equal(systemEvent.actorName, "system");
    assert.equal(systemEvent.before, null);
    assert.equal(systemEvent.after, null);
    await client.query(`INSERT INTO ${schema}.audit_events (id, occurred_at, actor_name, actor_role, action, entity_type, entity_id)
      VALUES ('z-older', '2100-01-01'::timestamptz, 'User', 'Admin', 'TEST', 'Booking', 'old'),
             ('a-newer', '2101-01-01'::timestamptz, 'User', 'Admin', 'TEST', 'Booking', 'new'),
             ('b-newer', '2101-01-01'::timestamptz, 'User', 'Admin', 'TEST', 'Booking', 'new')`);
    assert.deepEqual((await store.list()).items.slice(0, 3).map((item) => item.id), ["b-newer", "a-newer", "z-older"]);
    await client.query(`DELETE FROM ${schema}.audit_events WHERE id = ANY($1::text[])`, [["z-older", "a-newer", "b-newer"]]);
    await client.query(`INSERT INTO ${schema}.audit_events (id, occurred_at, actor_name, actor_role, action, entity_type, entity_id)
      SELECT 'bulk-' || lpad(n::text, 3, '0'), '2100-01-01'::timestamptz, 'User', 'Admin', 'CREATE', 'Booking', n::text
      FROM generate_series(1, 205) AS n`);
    const result = await store.list();
    assert.equal(result.total, 207);
    assert.equal(result.items.length, 200);
    assert.equal(result.items[0].id, "bulk-205");
    assert.equal(result.items[199].id, "bulk-006");
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
