import { getRole } from "../src/rbac.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { closeBookingDatabase } from "../src/lib/bookingDatabase.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createApp } from "../src/lib/http.js";
import bookingsRouter from "../src/routes/bookings.js";
import approvalsRouter from "../src/routes/approvals.js";
import { evaluateApproval } from "../src/validation.js";

test("approval submissions and decisions persist atomically and honor booking scope", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const admin = db.users[0];
  const restricted = { ...admin, role: "Manager", bookingOrgs: ["OTHER"] };
  const pool = createBookingPool();
  const ids = [];
  let server;
  async function start() {
    const app = createApp();
    app.use((req, res, next) => { req.user = req.header("x-test-other") ? restricted : admin; req.accessRole = getRole(req.user.role); req.evaluateBookingApproval = evaluateApproval; next(); });
    app.use("/bookings", bookingsRouter);
    app.use("/approvals", approvalsRouter);
    server = app.listen(0);
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); server = undefined; }
    await closeBookingDatabase();
  }
  const post = (body = {}) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let base = await start();
    async function create() {
      const response = await fetch(`${base}/bookings`, post({ shipperCode: "LANKAENG", consigneeCode: "ACME", mode: "Ocean FCL", incotermCode: "FOB", cargoReadyDate: "2027-01-01", goodsDescription: `test ${randomUUID()}`, cargoLines: [{ packages: 1, grossWeight: 12000, weightUnit: "KGS" }] }));
      assert.equal(response.status, 201);
      const booking = await response.json();
      ids.push(booking.id);
      assert.equal((await fetch(`${base}/bookings/${booking.id}/validate`, post())).status, 200);
      const submissions = await Promise.all([fetch(`${base}/bookings/${booking.id}/submit-approval`, post()), fetch(`${base}/bookings/${booking.id}/submit-approval`, post())]);
      assert.deepEqual(submissions.map((r) => r.status).sort(), [200, 409]);
      return booking.id;
    }
    const id = await create();
    const secondId = await create();
    await stop();
    base = await start();
    const booking = await (await fetch(`${base}/bookings/${id}`)).json();
    assert.equal(booking.status, "PENDING_APPROVAL");
    const approvalId = booking.pendingApproval.id;
    const secondApproval = (await (await fetch(`${base}/bookings/${secondId}`)).json()).pendingApproval.id;
    const restrictedList = await (await fetch(`${base}/approvals`, { headers: { "x-test-other": "1" } })).json();
    assert.ok(!restrictedList.items.some((a) => a.id === approvalId));
    assert.equal((await fetch(`${base}/approvals/${approvalId}/approve`, { ...post(), headers: { ...post().headers, "x-test-other": "1" } })).status, 403);
    assert.equal((await fetch(`${base}/bookings/${id}`, { ...post({ notes: "changed" }), method: "PUT" })).status, 409);
    assert.equal((await fetch(`${base}/bookings/${id}/validate`, post())).status, 409);
    assert.equal((await fetch(`${base}/bookings/${id}/cancel`, post({ reason: "test" }))).status, 409);
    assert.equal((await fetch(`${base}/approvals/${secondApproval}/reject`, post())).status, 400);
    const decisions = await Promise.all([fetch(`${base}/approvals/${approvalId}/approve`, post()), fetch(`${base}/approvals/${approvalId}/approve`, post())]);
    assert.deepEqual(decisions.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await fetch(`${base}/approvals/${secondApproval}/reject`, post({ comment: "Please correct" }))).status, 200);
    await stop();
    base = await start();
    assert.equal((await (await fetch(`${base}/bookings/${id}`)).json()).status, "APPROVED");
    assert.equal((await (await fetch(`${base}/bookings/${secondId}`)).json()).status, "DRAFT");
    assert.ok((await (await fetch(`${base}/approvals?status=APPROVED`)).json()).items.some((a) => a.id === approvalId));
    assert.ok((await (await fetch(`${base}/approvals?status=REJECTED`)).json()).items.some((a) => a.id === secondApproval && a.comment === "Please correct"));
  } finally {
    await stop();
    try {
      await pool.query("DELETE FROM booking_portal_v4.approvals WHERE booking_id = ANY($1::text[])", [ids]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});
