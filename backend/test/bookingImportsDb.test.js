import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { closeBookingDatabase } from "../src/lib/bookingDatabase.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createApp } from "../src/lib/http.js";
import importsRouter from "../src/routes/imports.js";
import bookingsRouter from "../src/routes/bookings.js";

test("booking imports persist, enforce ownership and commit once", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const owner = { ...db.users[0], email: `${randomUUID()}@example.invalid` };
  const other = { ...owner, email: `${randomUUID()}@example.invalid` };
  const pool = createBookingPool();
  let server, batchId, sampleId, xlsxId;
  async function start() {
    const app = createApp();
    app.use((req, res, next) => { req.user = req.header("x-test-other") ? other : owner; next(); });
    app.use("/imports", importsRouter);
    app.use("/bookings", bookingsRouter);
    server = app.listen(0);
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); server = undefined; }
    await closeBookingDatabase();
  }
  const json = (method, body, otherUser = false) => ({ method, headers: { "content-type": "application/json", ...(otherUser ? { "x-test-other": "1" } : {}) }, body: JSON.stringify(body) });
  try {
    let base = await start();
    const sample = await fetch(`${base}/imports/sample`, json("POST", {}));
    assert.equal(sample.status, 201);
    sampleId = (await sample.json()).id;
    const form = new FormData();
    form.append("file", new Blob([await readFile(new URL("../../samples/SBMS_Booking_Upload_Template.xlsx", import.meta.url))]), "booking.xlsx");
    const workbook = await fetch(`${base}/imports`, { method: "POST", body: form });
    assert.equal(workbook.status, 201);
    xlsxId = (await workbook.json()).id;
    const csv = "shipperCode,consigneeCode,mode,incotermCode,cargoReadyDate,goodsDescription,packages,grossWeight\nLANKAENG,ACME,Air,FOB,2027-01-01,,1,10\n";
    const upload = await fetch(`${base}/imports`, json("POST", { csv }));
    assert.equal(upload.status, 201);
    const batch = await upload.json();
    batchId = batch.id;
    assert.equal(batch.errorCount, 1);
    await stop();
    base = await start();
    assert.equal((await fetch(`${base}/imports/${batchId}`, { headers: { "x-test-other": "1" } })).status, 403);
    assert.equal((await fetch(`${base}/imports/${batchId}/commit`, json("POST", {}, true))).status, 403);
    const edit = await fetch(`${base}/imports/${batchId}/rows/1`, json("PATCH", { booking: { goodsDescription: "edited import", id: "forged" } }));
    assert.equal(edit.status, 200);
    assert.equal((await edit.json()).valid, 1);
    await stop();
    base = await start();
    assert.equal((await (await fetch(`${base}/imports/${batchId}`)).json()).rows[0].booking.goodsDescription, "edited import");
    const commits = await Promise.all([fetch(`${base}/imports/${batchId}/commit`, json("POST", {})), fetch(`${base}/imports/${batchId}/commit`, json("POST", {}))]);
    assert.deepEqual(commits.map((r) => r.status), [200, 200]);
    const results = await Promise.all(commits.map((response) => response.json()));
    assert.deepEqual(results.map((result) => result.committed).sort(), [0, 1]);
    assert.equal(results[0].batch.valid, 0);
    assert.equal((await fetch(`${base}/imports/${batchId}/rows/1`, json("PATCH", { booking: {} }))).status, 400);
    await stop();
    base = await start();
    const storedBatch = (await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [batchId])).rows[0].data;
    const bookingId = storedBatch.rows[0].committedBookingId;
    assert.ok(bookingId);
    assert.notEqual(bookingId, "forged");
    const booking = await (await fetch(`${base}/bookings/${bookingId}`)).json();
    assert.equal(booking.goodsDescription, "edited import");
    assert.equal(booking.status, "VALIDATED");
    assert.equal((await (await fetch(`${base}/imports/${batchId}`)).json()).rows[0].status, "COMMITTED");
  } finally {
    await stop();
    try {
      if (batchId) {
        const row = (await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [batchId])).rows[0];
        const bookingIds = (row?.data.rows || []).map((r) => r.committedBookingId).filter(Boolean);
        await pool.query("DELETE FROM booking_portal_v4.imports WHERE id = $1", [batchId]);
        await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [bookingIds]);
      }
      if (sampleId) await pool.query("DELETE FROM booking_portal_v4.imports WHERE id = $1", [sampleId]);
      if (xlsxId) await pool.query("DELETE FROM booking_portal_v4.imports WHERE id = $1", [xlsxId]);
    } finally { await pool.end(); }
  }
});
