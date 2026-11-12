import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

test("booking schema persists workflow data and enforces relationships", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const client = new pg.Client({ connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query("BEGIN");
    const id = randomUUID();
    const approvalId = randomUUID();
    const orderId = randomUUID();
    const data = { id, notes: "saved edit", documents: [{ id: randomUUID(), contentBase64: Buffer.from("test").toString("base64") }] };
    await client.query("INSERT INTO booking_portal_v3.bookings (id, reference, data) VALUES ($1, $2, $3)", [id, `test-${id}`, data]);
    await client.query("INSERT INTO booking_portal_v3.approvals (id, booking_id, data) VALUES ($1, $2, $3)", [approvalId, id, { status: "PENDING" }]);
    await client.query("INSERT INTO booking_portal_v3.order_links (order_id, booking_id) VALUES ($1, $2)", [orderId, id]);
    await client.query("INSERT INTO booking_portal_v3.templates (id, owner_email, data) VALUES ($1, $2, $3)", [randomUUID(), `${id}@example.invalid`, { name: "test" }]);
    await client.query("INSERT INTO booking_portal_v3.imports (id, data) VALUES ($1, $2)", [randomUUID(), { rows: [] }]);
    await client.query("INSERT INTO booking_portal_v3.preferences (owner_email, preference_type, data) VALUES ($1, $2, $3)", [`${id}@example.invalid`, "layouts", JSON.stringify([])]);
    const { rows } = await client.query("SELECT data FROM booking_portal_v3.bookings WHERE id = $1", [id]);
    assert.deepEqual(rows[0].data, data);
    await client.query("UPDATE booking_portal_v3.bookings SET data = jsonb_set(data, '{notes}', to_jsonb($2::text)) WHERE id = $1", [id, "updated"]);
    assert.equal((await client.query("SELECT data->>'notes' AS notes FROM booking_portal_v3.bookings WHERE id = $1", [id])).rows[0].notes, "updated");
    await client.query("SAVEPOINT constraint_check");
    await assert.rejects(client.query("INSERT INTO booking_portal_v3.order_links (order_id, booking_id) VALUES ($1, $2)", [randomUUID(), randomUUID()]), { code: "23503" });
    await client.query("ROLLBACK TO SAVEPOINT constraint_check");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
