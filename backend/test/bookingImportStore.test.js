import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBookingPool, createBookingStore } from "../src/lib/bookingStore.js";

test("import commits are atomic, restart-safe, and not duplicated by concurrent requests", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const store = createBookingStore(pool);
  const importId = randomUUID();
  const bookingIds = [randomUUID(), randomUUID()];
  try {
    await store.createImport({ id: importId, rows: [
      { rowNo: 1, status: "VALID", bookingId: bookingIds[0] },
      { rowNo: 2, status: "VALID", bookingId: bookingIds[1] }
    ] });
    await assert.rejects(store.commitImport(importId, (row) => {
      if (row.rowNo === 2) throw new Error("failed validation");
      return { id: row.bookingId, notes: "imported" };
    }), /failed validation/);
    assert.equal(await store.get(bookingIds[0]), null);
    assert.equal((await store.getImport(importId)).rows[0].status, "VALID");
    const makeBooking = (row) => ({ id: row.bookingId, notes: "imported" });
    const [first, second] = await Promise.all([store.commitImport(importId, makeBooking), store.commitImport(importId, makeBooking)]);
    assert.deepEqual([first.bookings.length, second.bookings.length].sort(), [0, 2]);
    assert.ok((await store.getImport(importId)).rows.every((row) => row.status === "COMMITTED"));
    assert.equal((await store.get(bookingIds[0])).notes, "imported");
    assert.notEqual((await store.get(bookingIds[0])).reference, (await store.get(bookingIds[1])).reference);
    assert.equal(await store.commitImport(randomUUID(), makeBooking), null);
  } finally {
    try {
      await pool.query("DELETE FROM booking_portal_v3.imports WHERE id = $1", [importId]);
      await pool.query("DELETE FROM booking_portal_v3.bookings WHERE id = ANY($1::text[])", [bookingIds]);
    } finally {
      await pool.end();
    }
  }
});
