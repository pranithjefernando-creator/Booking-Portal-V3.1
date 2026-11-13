import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBookingPool } from "../src/lib/bookingStore.js";

test("active v4 complete workflow survives backend restarts and failed writes", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const pool = createBookingPool();
  const originalPreferenceTypes = new Set((await pool.query("SELECT preference_type FROM booking_portal_v4.preferences WHERE owner_email = $1 AND preference_type = ANY($2::text[])", ["pranithf@efl.example", ["layouts", "filters"]])).rows.map((row) => row.preference_type));
  const ids = [];
  const orderNo = `TEST-V4-PROCESS-${randomUUID()}`;
  const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const base = `http://127.0.0.1:${port}`;
  const password = "Booking-Test-Password1";
  let child, errors = "", batchId, templateId, layoutId, filterId;
  async function start() {
    errors = "";
    child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/mockSqlLoader.js", import.meta.url).href, "server.js"], {
      cwd, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, NODE_ENV: "production", PORT: String(port), SEED_DEFAULT_PASSWORD: password, AUTH_SECRET: "booking-test-only-secret-at-least-32-bytes", TRACKING_DB_PASSWORD: "", ORDER_DB_PASSWORD: "test-only", TEST_ORDER_NO: orderNo, ORG_DB_PASSWORD: "", CW_MODE: "mock" }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Backend exited: ${errors}`);
      try { if ((await fetch(`${base}/api/ready`)).ok) return; } catch { await sleep(100); }
      await sleep(50);
    }
    throw new Error(`Backend did not become ready: ${errors}`);
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    child = undefined;
  }
  async function token() {
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "pranithf@efl.example", password }) });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  }
  function request(method, auth, body) {
    return { method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  }
  async function getOrder(auth) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = await fetch(`${base}/api/v1/orders/${orderId}`, request("GET", auth));
      if (response.status === 200) return response.json();
      if (response.status !== 404) throw new Error(`Mock SQL order lookup failed: ${response.status}`);
      await sleep(100);
    }
    throw new Error("Mock SQL order did not load");
  }
  try {
    await start();
    let auth = await token();
    assert.equal((await fetch(`${base}/api/v1/bookings`)).status, 401);
    const valid = { shipperCode: "LANKAENG", consigneeCode: "ACME", mode: "Air", incotermCode: "FOB", cargoReadyDate: "2027-01-01", goodsDescription: "Process test", cargoLines: [{ packages: 1, grossWeight: 10 }] };
    const createdResponse = await fetch(`${base}/api/v1/bookings`, request("POST", auth, valid));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    ids.push(created.id);
    assert.match(created.reference, /^BKV4-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const edit = await fetch(`${base}/api/v1/bookings/${created.id}`, request("PUT", auth, { notes: "saved relational edit", cargoLines: [{ id: "line-1", packages: 3, grossWeight: 10 }, { id: "line-2", packages: 2, grossWeight: 20 }] }));
    assert.equal(edit.status, 200);
    const edited = await edit.json();
    assert.equal(edited.notes, "saved relational edit");
    const duplicate = await fetch(`${base}/api/v1/bookings/${created.id}`, request("PUT", auth, { notes: "must roll back", cargoLines: [{ id: "duplicate", packages: 1 }, { id: "duplicate", packages: 2 }] }));
    assert.equal(duplicate.status, 500);
    const failure = await duplicate.json();
    assert.equal(failure.error, "Internal server error");
    assert.ok(failure.requestId);
    assert.ok(errors.includes(failure.requestId));
    const afterFailure = await (await fetch(`${base}/api/v1/bookings/${created.id}`, request("GET", auth))).json();
    assert.equal(afterFailure.notes, "saved relational edit");
    assert.deepEqual(afterFailure.cargoLines.map((line) => line.id), ["line-1", "line-2"]);
    assert.equal((await fetch(`${base}/api/v1/bookings/${randomUUID()}`, request("GET", auth))).status, 404);
    const form = new FormData();
    form.append("type", "DOC");
    form.append("file", new Blob(["v4 backend restart document"]), "v4.txt");
    const uploaded = await fetch(`${base}/api/v1/bookings/${created.id}/documents`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: form });
    assert.equal(uploaded.status, 201);
    const docId = (await uploaded.json()).document.id;
    const stored = await pool.query("SELECT b.notes, b.cargo_ready_date::text, d.content FROM booking_portal_v4.bookings b JOIN booking_portal_v4.booking_documents d ON d.booking_id = b.id WHERE b.id = $1 AND d.id = $2", [created.id, docId]);
    assert.equal(stored.rows[0].notes, "saved relational edit");
    assert.equal(stored.rows[0].cargo_ready_date, "2027-01-01");
    assert.equal(stored.rows[0].content.toString(), "v4 backend restart document");
    await getOrder(auth);
    assert.equal((await fetch(`${base}/api/v1/orders/${orderId}/link-booking`, request("POST", auth, { bookingId: created.id }))).status, 200);
    const needsApproval = await fetch(`${base}/api/v1/bookings`, request("POST", auth, { ...valid, mode: "Ocean FCL", cargoLines: [{ packages: 1, grossWeight: 12000, weightUnit: "KGS" }] }));
    assert.equal(needsApproval.status, 201);
    const approvalBooking = await needsApproval.json();
    ids.push(approvalBooking.id);
    assert.equal((await fetch(`${base}/api/v1/bookings/${approvalBooking.id}/validate`, request("POST", auth, {}))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/bookings/${approvalBooking.id}/submit-approval`, request("POST", auth, {}))).status, 200);
    const approvalId = (await (await fetch(`${base}/api/v1/bookings/${approvalBooking.id}`, request("GET", auth))).json()).pendingApproval.id;
    const csv = "shipperCode,consigneeCode,mode,incotermCode,cargoReadyDate,goodsDescription,packages,grossWeight\nLANKAENG,ACME,Air,FOB,2027-01-01,,1,10\n";
    const imported = await fetch(`${base}/api/v1/imports`, request("POST", auth, { csv }));
    assert.equal(imported.status, 201);
    batchId = (await imported.json()).id;
    assert.equal((await fetch(`${base}/api/v1/imports/${batchId}/rows/1`, request("PATCH", auth, { booking: { goodsDescription: "persisted import edit" } }))).status, 200);
    const template = await fetch(`${base}/api/v1/bookings/templates`, request("POST", auth, { name: `v4-${created.id}`, data: { mode: "Air" } }));
    assert.equal(template.status, 201);
    templateId = (await template.json()).id;
    const layout = await fetch(`${base}/api/v1/bookings/layouts`, request("POST", auth, { name: `v4-${created.id}`, columns: ["reference"] }));
    assert.equal(layout.status, 201);
    layoutId = (await layout.json()).layouts.find((item) => item.name === `v4-${created.id}`).id;
    const filter = await fetch(`${base}/api/v1/bookings/filters`, request("POST", auth, { name: `v4-${created.id}`, filters: [{ field: "status", operator: "eq", value: "DRAFT" }] }));
    assert.equal(filter.status, 201);
    filterId = (await filter.json()).layouts.find((item) => item.name === `v4-${created.id}`).id;
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM booking_portal_v3.bookings WHERE id = ANY($1::text[])", [ids])).rows[0].count, 0);
    await stop();
    await start();
    auth = await token();
    const read = await (await fetch(`${base}/api/v1/bookings/${created.id}`, request("GET", auth))).json();
    assert.equal(read.notes, "saved relational edit");
    assert.deepEqual(read.cargoLines.map((line) => line.id), ["line-1", "line-2"]);
    assert.equal(await (await fetch(`${base}/api/v1/bookings/${created.id}/documents/${docId}/download`, request("GET", auth))).text(), "v4 backend restart document");
    assert.equal((await getOrder(auth)).bookingId, created.id);
    assert.ok(read.orderIds.includes(orderId));
    assert.equal((await (await fetch(`${base}/api/v1/bookings/${approvalBooking.id}`, request("GET", auth))).json()).status, "PENDING_APPROVAL");
    assert.ok((await (await fetch(`${base}/api/v1/approvals`, request("GET", auth))).json()).items.some((item) => item.id === approvalId));
    assert.ok((await (await fetch(`${base}/api/v1/orders/meta/bookings`, request("GET", auth))).json()).items.some((item) => item.id === created.id));
    assert.ok((await (await fetch(`${base}/api/v1/dashboard/summary`, request("GET", auth))).json()).kpis.total >= 2);
    assert.ok((await (await fetch(`${base}/api/v1/notifications/summary`, request("GET", auth))).json()).items.some((item) => item.key === "approvals"));
    assert.equal((await (await fetch(`${base}/api/v1/imports/${batchId}`, request("GET", auth))).json()).rows[0].booking.goodsDescription, "persisted import edit");
    assert.equal((await (await fetch(`${base}/api/v1/bookings/templates/${templateId}`, request("GET", auth))).json()).data.mode, "Air");
    assert.ok((await (await fetch(`${base}/api/v1/bookings/layouts/list`, request("GET", auth))).json()).layouts.some((item) => item.id === layoutId));
    assert.ok((await (await fetch(`${base}/api/v1/bookings/filters/list`, request("GET", auth))).json()).layouts.some((item) => item.id === filterId));
    assert.equal((await fetch(`${base}/api/v1/approvals/${approvalId}/approve`, request("POST", auth, {}))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/approvals/${approvalId}/approve`, request("POST", auth, {}))).status, 409);
    const commits = await Promise.all([fetch(`${base}/api/v1/imports/${batchId}/commit`, request("POST", auth, {})), fetch(`${base}/api/v1/imports/${batchId}/commit`, request("POST", auth, {}))]);
    assert.deepEqual(commits.map((response) => response.status), [200, 200]);
    assert.deepEqual((await Promise.all(commits.map((response) => response.json()))).map((value) => value.committed).sort(), [0, 1]);
    const batch = (await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [batchId])).rows[0].data;
    ids.push(batch.rows[0].committedBookingId);
    const importedBooking = await (await fetch(`${base}/api/v1/bookings/${ids[2]}`, request("GET", auth))).json();
    assert.match(importedBooking.reference, /^BKV4-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(importedBooking.reference, created.reference);
    assert.equal((await fetch(`${base}/api/v1/bookings/${created.id}/validate`, request("POST", auth, {}))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/bookings/${created.id}/complete`, request("POST", auth, {}))).status, 200);
    await stop();
    await start();
    auth = await token();
    const completed = await (await fetch(`${base}/api/v1/bookings/${created.id}`, request("GET", auth))).json();
    assert.equal(completed.status, "COMPLETED");
    assert.equal(completed.notes, "saved relational edit");
    assert.equal(completed.cwStatus, "SENT");
    assert.ok(completed.cw1ShipmentRef);
    assert.equal((await (await fetch(`${base}/api/v1/bookings/${approvalBooking.id}`, request("GET", auth))).json()).status, "APPROVED");
    assert.equal((await (await fetch(`${base}/api/v1/bookings/${ids[2]}`, request("GET", auth))).json()).goodsDescription, "persisted import edit");
    assert.equal((await (await fetch(`${base}/api/v1/imports/${batchId}`, request("GET", auth))).json()).rows[0].status, "COMMITTED");
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
      if (templateId) await pool.query("DELETE FROM booking_portal_v4.templates WHERE id = $1", [templateId]);
      if (layoutId || filterId) {
        const { createRelationalBookingStore } = await import("../src/lib/bookingRelationalStore.js");
        const preferences = createRelationalBookingStore(pool);
        if (layoutId) await preferences.updatePreferences("pranithf@efl.example", "layouts", (items) => items.filter((item) => item.id !== layoutId));
        if (filterId) await preferences.updatePreferences("pranithf@efl.example", "filters", (items) => items.filter((item) => item.id !== filterId));
        for (const type of ["layouts", "filters"]) {
          if (!originalPreferenceTypes.has(type)) await pool.query("DELETE FROM booking_portal_v4.preferences WHERE owner_email = $1 AND preference_type = $2 AND data = '[]'::jsonb", ["pranithf@efl.example", type]);
        }
      }
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});
