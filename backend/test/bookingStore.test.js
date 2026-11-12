import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBookingPool, createBookingStore } from "../src/lib/bookingStore.js";

test("booking pool rejects incomplete or invalid configuration", () => {
  assert.throws(() => createBookingPool({}), /Missing PostgreSQL configuration/);
  assert.throws(() => createBookingPool({ PGHOST: "localhost", PGDATABASE: "db", PGUSER: "user", PGPASSWORD: "secret", PGPORT: "bad" }), /Invalid PostgreSQL port/);
});

test("booking store commits records, serializes edits, and preserves identity", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const id = randomUUID();
  const secondId = randomUUID();
  const pool = createBookingPool();
  const store = createBookingStore(pool);
  let otherPool;
  try {
    const [first, second] = await Promise.all([
      store.create({ id, reference: "untrusted", notes: "original", count: 0 }),
      store.create({ id: secondId, count: 0 })
    ]);
    assert.match(first.reference, /^BK-0\d+$/);
    assert.notEqual(first.reference, second.reference);
    otherPool = createBookingPool();
    const restartedStore = createBookingStore(otherPool);
    assert.deepEqual(await restartedStore.get(id), first);
    assert.ok((await restartedStore.list()).some((booking) => booking.id === id));
    await Promise.all(Array.from({ length: 5 }, () => restartedStore.update(id, async (booking) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...booking, id: secondId, reference: "changed", count: booking.count + 1 };
    })));
    const edited = await store.get(id);
    assert.equal(edited.id, id);
    assert.equal(edited.reference, first.reference);
    assert.equal(edited.count, 5);
    await assert.rejects(store.update(id, () => { throw new Error("cancel update"); }), /cancel update/);
    assert.deepEqual(await restartedStore.get(id), edited);
    assert.equal(await store.get(randomUUID()), null);
    assert.equal(await store.update(randomUUID(), (booking) => booking), null);
  } finally {
    await pool.query("DELETE FROM booking_portal_v3.bookings WHERE id = ANY($1::text[])", [[id, secondId]]);
    if (otherPool) await otherPool.end();
    await pool.end();
  }
});
