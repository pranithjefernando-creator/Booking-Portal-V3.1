import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../src/lib/bookingRelationalStore.js";

test("booking workflow survives actual backend process restarts", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const password = "Booking-Test-Password1";
  const pool = createBookingPool();
  const originalPreferenceTypes = new Set((await pool.query("SELECT preference_type FROM booking_portal_v4.preferences WHERE owner_email = $1 AND preference_type = ANY($2::text[])", ["pranithf@efl.example", ["layouts", "filters"]])).rows.map((row) => row.preference_type));
  const store = createRelationalBookingStore(pool);
  const orderNo = `TEST-RESTART-${randomUUID()}`;
  const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
  const name = `restart-${randomUUID()}`;
  let child;
  let id;
  let approvalBookingId;
  let importId;
  let templateId;
  let layoutId;
  let filterId;
  let documentId;
  let childErrors = "";
  const base = `http://127.0.0.1:${port}`;
  async function start() {
    childErrors = "";
    child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/mockSqlLoader.js", import.meta.url).href, "server.js"], { cwd, stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PORT: String(port), SEED_DEFAULT_PASSWORD: password, AUTH_SECRET: "booking-test-only", TRACKING_DB_PASSWORD: "", ORDER_DB_PASSWORD: "test-only", TEST_ORDER_NO: orderNo, ORG_DB_PASSWORD: "", CW_MODE: "mock" } });
    child.stderr.on("data", (chunk) => { childErrors += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Backend exited before becoming ready: ${childErrors}`);
      try { if ((await fetch(`${base}/api/ready`)).ok) return; } catch { await sleep(100); }
    }
    throw new Error("Backend did not become ready");
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
  async function waitForOrder(auth) {
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
    const createdResponse = await fetch(`${base}/api/v1/bookings`, request("POST", auth, { notes: "process test" }));
    assert.equal(createdResponse.status, 201);
    id = (await createdResponse.json()).id;
    assert.equal((await fetch(`${base}/api/v1/bookings/${id}`, request("PUT", auth, { notes: "saved after restart" }))).status, 200);
    const form = new FormData();
    form.append("type", "DOC");
    form.append("file", new Blob(["restart document"]), "restart.txt");
    const uploaded = await fetch(`${base}/api/v1/bookings/${id}/documents`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body: form });
    assert.equal(uploaded.status, 201);
    documentId = (await uploaded.json()).document.id;
    await waitForOrder(auth);
    assert.equal((await fetch(`${base}/api/v1/orders/${orderId}/link-booking`, request("POST", auth, { bookingId: id }))).status, 200);
    const templateResponse = await fetch(`${base}/api/v1/bookings/templates`, request("POST", auth, { name, data: { mode: "Air" } }));
    assert.equal(templateResponse.status, 201);
    templateId = (await templateResponse.json()).id;
    const layoutResponse = await fetch(`${base}/api/v1/bookings/layouts`, request("POST", auth, { name, columns: ["reference"] }));
    assert.equal(layoutResponse.status, 201);
    layoutId = (await layoutResponse.json()).layouts.find((layout) => layout.name === name).id;
    const filterResponse = await fetch(`${base}/api/v1/bookings/filters`, request("POST", auth, { name, filters: [{ field: "status", operator: "eq", value: "DRAFT" }] }));
    assert.equal(filterResponse.status, 201);
    filterId = (await filterResponse.json()).layouts.find((layout) => layout.name === name).id;
    await stop();
    await start();
    auth = await token();
    const read = await fetch(`${base}/api/v1/bookings/${id}`, request("GET", auth));
    assert.equal(read.status, 200);
    assert.equal((await read.json()).notes, "saved after restart");
    assert.equal(await (await fetch(`${base}/api/v1/bookings/${id}/documents/${documentId}/download`, request("GET", auth))).text(), "restart document");
    assert.equal((await waitForOrder(auth)).bookingId, id);
    assert.ok((await (await fetch(`${base}/api/v1/bookings/${id}`, request("GET", auth))).json()).orderIds.includes(orderId));
    assert.equal((await (await fetch(`${base}/api/v1/bookings/templates/${templateId}`, request("GET", auth))).json()).data.mode, "Air");
    assert.ok((await (await fetch(`${base}/api/v1/bookings/layouts/list`, request("GET", auth))).json()).layouts.some((layout) => layout.id === layoutId));
    assert.ok((await (await fetch(`${base}/api/v1/bookings/filters/list`, request("GET", auth))).json()).layouts.some((layout) => layout.id === filterId));
    const choices = await (await fetch(`${base}/api/v1/orders/meta/bookings`, request("GET", auth))).json();
    assert.ok(choices.items.some((booking) => booking.id === id));
    assert.ok((await (await fetch(`${base}/api/v1/bookings/kpis`, request("GET", auth))).json()).total >= 1);
    assert.ok((await (await fetch(`${base}/api/v1/dashboard/summary`, request("GET", auth))).json()).kpis.total >= 1);
    const valid = { shipperCode: "LANKAENG", consigneeCode: "ACME", mode: "Air", incotermCode: "FOB", cargoReadyDate: "2027-01-01", goodsDescription: "Test", cargoLines: [{ packages: 1, grossWeight: 10 }] };
    assert.equal((await fetch(`${base}/api/v1/bookings/${id}`, request("PUT", auth, valid))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/bookings/${id}/validate`, request("POST", auth, {}))).status, 200);
    const completed = await fetch(`${base}/api/v1/bookings/${id}/complete`, request("POST", auth, {}));
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).cw.ok, true);
    await stop();
    await start();
    auth = await token();
    const saved = await (await fetch(`${base}/api/v1/bookings/${id}`, request("GET", auth))).json();
    assert.equal(saved.status, "COMPLETED");
    assert.equal(saved.cwStatus, "SENT");
    assert.ok(saved.cw1ShipmentRef);
    assert.ok(saved.completedAt);
    const attemptedEdit = await (await fetch(`${base}/api/v1/bookings/${id}`, request("PUT", auth, { completedAt: "2000-01-01", notes: "completion timestamp protected" }))).json();
    assert.equal(attemptedEdit.completedAt, saved.completedAt);
    const approvalResponse = await fetch(`${base}/api/v1/bookings`, request("POST", auth, { ...valid, mode: "Ocean FCL", cargoLines: [{ packages: 1, grossWeight: 12000, weightUnit: "KGS" }] }));
    assert.equal(approvalResponse.status, 201);
    approvalBookingId = (await approvalResponse.json()).id;
    assert.equal((await fetch(`${base}/api/v1/bookings/${approvalBookingId}/validate`, request("POST", auth, {}))).status, 200);
    assert.equal((await fetch(`${base}/api/v1/bookings/${approvalBookingId}/submit-approval`, request("POST", auth, {}))).status, 200);
    await stop();
    await start();
    auth = await token();
    const pending = await (await fetch(`${base}/api/v1/bookings/${approvalBookingId}`, request("GET", auth))).json();
    assert.equal(pending.status, "PENDING_APPROVAL");
    assert.ok(pending.pendingApproval.id);
    assert.ok((await (await fetch(`${base}/api/v1/notifications/summary`, request("GET", auth))).json()).items.some((item) => item.key === "approvals" && item.count >= 1));
    assert.equal((await fetch(`${base}/api/v1/approvals/${pending.pendingApproval.id}/approve`, request("POST", auth, {}))).status, 200);
    await stop();
    await start();
    auth = await token();
    assert.equal((await (await fetch(`${base}/api/v1/bookings/${approvalBookingId}`, request("GET", auth))).json()).status, "APPROVED");
    assert.ok((await (await fetch(`${base}/api/v1/approvals?status=APPROVED`, request("GET", auth))).json()).items.some((item) => item.id === pending.pendingApproval.id));
    const csv = "shipperCode,consigneeCode,mode,incotermCode,cargoReadyDate,goodsDescription,packages,grossWeight\nLANKAENG,ACME,Air,FOB,2027-01-01,,1,10\n";
    const imported = await fetch(`${base}/api/v1/imports`, request("POST", auth, { csv }));
    assert.equal(imported.status, 201);
    importId = (await imported.json()).id;
    await stop();
    await start();
    auth = await token();
    assert.equal((await (await fetch(`${base}/api/v1/imports/${importId}`, request("GET", auth))).json()).errorCount, 1);
    assert.equal((await fetch(`${base}/api/v1/imports/${importId}/rows/1`, request("PATCH", auth, { booking: { goodsDescription: "Restarted import" } }))).status, 200);
    await stop();
    await start();
    auth = await token();
    assert.equal((await (await fetch(`${base}/api/v1/imports/${importId}`, request("GET", auth))).json()).rows[0].booking.goodsDescription, "Restarted import");
    const committed = await (await fetch(`${base}/api/v1/imports/${importId}/commit`, request("POST", auth, {}))).json();
    assert.equal(committed.committed, 1);
    await stop();
    await start();
    auth = await token();
    assert.equal((await (await fetch(`${base}/api/v1/imports/${importId}`, request("GET", auth))).json()).rows[0].status, "COMMITTED");
    assert.equal((await (await fetch(`${base}/api/v1/imports/${importId}/commit`, request("POST", auth, {}))).json()).committed, 0);
    const persistedImport = await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [importId]);
    const importedBookingId = persistedImport.rows[0].data.rows[0].committedBookingId;
    assert.equal((await (await fetch(`${base}/api/v1/bookings/${importedBookingId}`, request("GET", auth))).json()).goodsDescription, "Restarted import");
  } finally {
    await stop();
    try { let importedIds = []; if (importId) { const result = await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [importId]); importedIds = (result.rows[0]?.data.rows || []).map((row) => row.committedBookingId).filter(Boolean); await pool.query("DELETE FROM booking_portal_v4.imports WHERE id = $1", [importId]); } if (approvalBookingId) await pool.query("DELETE FROM booking_portal_v4.approvals WHERE booking_id = $1", [approvalBookingId]); await pool.query("DELETE FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]); if (templateId) await pool.query("DELETE FROM booking_portal_v4.templates WHERE id = $1", [templateId]); if (layoutId) await store.updatePreferences("pranithf@efl.example", "layouts", (items) => items.filter((item) => item.id !== layoutId)); if (filterId) await store.updatePreferences("pranithf@efl.example", "filters", (items) => items.filter((item) => item.id !== filterId)); await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [[id, approvalBookingId, ...importedIds].filter(Boolean)]); }
    finally { try { for (const type of ["layouts", "filters"]) { if (!originalPreferenceTypes.has(type)) await pool.query("DELETE FROM booking_portal_v4.preferences WHERE owner_email = $1 AND preference_type = $2 AND data = '[]'::jsonb", ["pranithf@efl.example", type]); } } finally { await pool.end(); } }
  }
});
