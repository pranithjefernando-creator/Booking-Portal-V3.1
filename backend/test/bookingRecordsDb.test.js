import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { closeBookingDatabase } from "../src/lib/bookingDatabase.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createApp } from "../src/lib/http.js";
import bookingsRouter from "../src/routes/bookings.js";
import approvalsRouter from "../src/routes/approvals.js";
import importsRouter from "../src/routes/imports.js";
import ordersRouter from "../src/routes/orders.js";

test("booking records, edits, statuses and documents persist across server restarts", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const admin = db.users[0];
  const pool = createBookingPool();
  let server;
  let id;
  async function start() {
    const app = createApp();
    app.use((req, res, next) => { req.user = admin; next(); });
    app.use("/bookings", bookingsRouter);
    app.use("/approvals", approvalsRouter);
    app.use("/imports", importsRouter);
    app.use("/orders", ordersRouter);
    server = app.listen(0);
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); server = undefined; }
    await closeBookingDatabase();
  }
  const json = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let base = await start();
    const createdResponse = await fetch(`${base}/bookings`, json("POST", { notes: "initial", shipperCode: "LANKAENG", cargoLines: [], createdByEmail: "forged@example.invalid", completedAt: "2000-01-01" }));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    id = created.id;
    assert.equal(created.createdByEmail, admin.email);
    assert.equal(created.completedAt, undefined);
    assert.match(created.reference, /^BKV4-[0-9a-f-]{36}$/);
    const edited = await fetch(`${base}/bookings/${id}`, json("PUT", { notes: "persisted edit", createdByEmail: "forged@example.invalid", completedAt: "2000-01-01", consigneeCode: "ACME", mode: "Air", incotermCode: "FOB", cargoReadyDate: "2027-01-01", goodsDescription: "Test", cargoLines: [{ packages: 1, grossWeight: 10 }] }));
    assert.equal(edited.status, 200);
    assert.equal((await fetch(`${base}/bookings/${id}/validate`, json("POST", {}))).status, 200);
    const form = new FormData();
    form.append("type", "DOC");
    form.append("file", new Blob(["booking document"]), "booking.txt");
    const upload = await fetch(`${base}/bookings/${id}/documents`, { method: "POST", body: form });
    assert.equal(upload.status, 201);
    const document = (await upload.json()).document;
    assert.equal((await fetch(`${base}/bookings/${id}/cfs-received`, json("POST", { received: true }))).status, 200);
    assert.equal((await fetch(`${base}/orders/example/link-booking`, json("POST", { bookingId: id }))).status, 404);
    await stop();
    base = await start();
    const read = await fetch(`${base}/bookings/${id}`);
    assert.equal(read.status, 200);
    const booking = await read.json();
    assert.equal(booking.notes, "persisted edit");
    assert.equal(booking.createdByEmail, admin.email);
    assert.equal(booking.completedAt, undefined);
    assert.equal(booking.reference, created.reference);
    assert.equal(booking.cfsReceived, true);
    assert.equal(booking.status, "VALIDATED");
    assert.equal(booking.documents[0].id, document.id);
    assert.equal(await (await fetch(`${base}/bookings/${id}/documents/${document.id}/download`)).text(), "booking document");
    assert.equal((await fetch(`${base}/bookings/${id}/documents/${document.id}`, { method: "DELETE" })).status, 200);
    assert.ok((await (await fetch(`${base}/bookings`)).json()).items.some((item) => item.id === id));
    assert.equal((await fetch(`${base}/bookings/${id}/cancel`, json("POST", { reason: "test" }))).status, 200);
    await stop();
    base = await start();
    assert.equal((await (await fetch(`${base}/bookings/${id}`)).json()).status, "CANCELLED");
    assert.equal((await fetch(`${base}/bookings/${id}/documents/${document.id}/download`)).status, 404);
    assert.equal((await fetch(`${base}/bookings/${id}`, json("PUT", { notes: "not allowed" }))).status, 409);
  } finally {
    await stop();
    try { if (id) await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = $1", [id]); }
    finally { await pool.end(); }
  }
});
