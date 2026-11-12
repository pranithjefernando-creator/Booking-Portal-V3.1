import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";

test("existing workflow routes operate on the staged v4 store across server restarts", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const orderNo = `TEST-V4-${randomUUID()}`;
  const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
  const pool = createBookingPool();
  const ids = [];
  let batchId, child, errors = "";
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    errors = "";
    child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/relationalWorkflowLoader.js", import.meta.url).href, fileURLToPath(new URL("./fixtures/relationalWorkflowServer.js", import.meta.url))], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PORT: String(port), TEST_ORDER_NO: orderNo } });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Test server exited: ${errors}`);
      try { if ((await fetch(`${base}/ready`)).ok) return; } catch { await sleep(100); }
    }
    throw new Error(`Test server did not start: ${errors}`);
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    child = undefined;
  }
  const json = (method, body = {}, other = false) => ({ method, headers: { "content-type": "application/json", ...(other ? { "x-test-other": "1" } : {}) }, body: JSON.stringify(body) });
  try {
    await start();
    const body = { shipperCode: "LANKAENG", consigneeCode: "ACME", mode: "Ocean FCL", incotermCode: "FOB", cargoReadyDate: "2027-01-01", goodsDescription: "Relational route test", cargoLines: [{ packages: 1, grossWeight: 12000, weightUnit: "KGS" }] };
    const created = await fetch(`${base}/bookings`, json("POST", body));
    assert.equal(created.status, 201);
    const booking = await created.json();
    ids.push(booking.id);
    assert.equal((await fetch(`${base}/bookings/${booking.id}/validate`, json("POST"))).status, 200);
    const form = new FormData();
    form.append("type", "DOC");
    form.append("file", new Blob(["v4 document"]), "v4.txt");
    const upload = await fetch(`${base}/bookings/${booking.id}/documents`, { method: "POST", body: form });
    assert.equal(upload.status, 201);
    const document = (await upload.json()).document;
    assert.equal((await fetch(`${base}/orders/${orderId}/link-booking`, json("POST", { bookingId: booking.id }))).status, 200);
    const submissions = await Promise.all([fetch(`${base}/bookings/${booking.id}/submit-approval`, json("POST")), fetch(`${base}/bookings/${booking.id}/submit-approval`, json("POST"))]);
    assert.deepEqual(submissions.map((response) => response.status).sort(), [200, 409]);
    const response = await (await fetch(`${base}/bookings/${booking.id}`)).json();
    const approvalId = response.pendingApproval.id;
    assert.deepEqual(response.orderIds, [orderId]);
    assert.equal((await fetch(`${base}/approvals/${approvalId}/approve`, json("POST", {}, true))).status, 403);
    const csv = "shipperCode,consigneeCode,mode,incotermCode,cargoReadyDate,goodsDescription,packages,grossWeight\nLANKAENG,ACME,Air,FOB,2027-01-01,,1,10\n";
    const uploaded = await fetch(`${base}/imports`, json("POST", { csv }));
    assert.equal(uploaded.status, 201);
    batchId = (await uploaded.json()).id;
    assert.equal((await fetch(`${base}/imports/${batchId}/commit`, json("POST", {}, true))).status, 403);
    assert.equal((await fetch(`${base}/imports/${batchId}/rows/1`, json("PATCH", { booking: { goodsDescription: "edited import" } }))).status, 200);
    await stop();
    await start();
    assert.equal(await (await fetch(`${base}/bookings/${booking.id}/documents/${document.id}/download`)).text(), "v4 document");
    assert.equal((await (await fetch(`${base}/orders/${orderId}`)).json()).bookingId, booking.id);
    assert.equal((await (await fetch(`${base}/imports/${batchId}`)).json()).rows[0].booking.goodsDescription, "edited import");
    const decisions = await Promise.all([fetch(`${base}/approvals/${approvalId}/approve`, json("POST")), fetch(`${base}/approvals/${approvalId}/approve`, json("POST"))]);
    assert.deepEqual(decisions.map((result) => result.status).sort(), [200, 409]);
    const commits = await Promise.all([fetch(`${base}/imports/${batchId}/commit`, json("POST")), fetch(`${base}/imports/${batchId}/commit`, json("POST"))]);
    assert.deepEqual(commits.map((result) => result.status), [200, 200]);
    assert.deepEqual((await Promise.all(commits.map((result) => result.json()))).map((result) => result.committed).sort(), [0, 1]);
    const batch = (await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [batchId])).rows[0].data;
    ids.push(batch.rows[0].committedBookingId);
    await stop();
    await start();
    assert.equal((await (await fetch(`${base}/bookings/${booking.id}`)).json()).status, "APPROVED");
    assert.equal((await (await fetch(`${base}/bookings/${ids[1]}`)).json()).goodsDescription, "edited import");
    assert.equal((await fetch(`${base}/bookings/${booking.id}/documents/${document.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/orders/${orderId}/unlink-booking`, json("POST", { bookingId: booking.id }))).status, 200);
  } finally {
    await stop();
    try {
      if (batchId) {
        const batch = (await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [batchId])).rows[0];
        for (const row of batch?.data.rows || []) if (row.committedBookingId && !ids.includes(row.committedBookingId)) ids.push(row.committedBookingId);
        await pool.query("DELETE FROM booking_portal_v4.imports WHERE id = $1", [batchId]);
      }
      await pool.query("DELETE FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]);
      await pool.query("DELETE FROM booking_portal_v4.approvals WHERE booking_id = ANY($1::text[])", [ids]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});
