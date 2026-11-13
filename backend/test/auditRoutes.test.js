import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBookingPool } from "../src/lib/bookingStore.js";

test("booking, approval and order audit writes share database boundaries", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `booking_session_${randomUUID().replaceAll("-", "")}`;
  let createdSchema = false;
  let child;
  let errors = "";
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const request = (path, method, body) => fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const failAction = (action) => pool.query(`UPDATE ${schema}.audit_test_failure SET action = $1`, [action]);
  const events = async (action, entityId) => (await pool.query(`SELECT action, entity_id FROM ${schema}.audit_events WHERE action = $1 AND entity_id = $2`, [action, entityId])).rows;
  const pendingOperation = async (kind) => (await (await request("/admin/operations", "GET")).json()).items.find((item) => item.kind === kind);
  const reconcile = (id, body) => request(`/admin/operations/${id}/reconcile`, "POST", body);
  async function start() {
    errors = "";
    child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/auditRoutesLoader.js", import.meta.url).href, fileURLToPath(new URL("./fixtures/auditRoutesServer.js", import.meta.url))], {
      stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PORT: String(port), TEST_BOOKING_SCHEMA: schema, CW_MODE: "mock" }
    });
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
  try {
    await pool.query(`CREATE SCHEMA ${schema}`);
    createdSchema = true;
    await pool.query((await readFile(new URL("../sql/booking-v4.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema));
    await pool.query(`CREATE TABLE ${schema}.audit_test_failure (action text);
      INSERT INTO ${schema}.audit_test_failure VALUES (NULL);
      CREATE FUNCTION ${schema}.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = (SELECT action FROM ${schema}.audit_test_failure) THEN RAISE EXCEPTION 'simulated audit failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_audit BEFORE INSERT ON ${schema}.audit_events FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_audit()`);
    await start();
    assert.equal((await fetch(`${base}/admin/operations`, { headers: { "x-test-deny": "1" } })).status, 403);
    assert.equal((await fetch(`${base}/audit-logs`, { headers: { "x-test-deny": "1" } })).status, 403);
    assert.deepEqual(await (await request("/audit-logs", "GET")).json(), { total: 0, items: [] });

    const body = { shipperCode: "LANKAENG", consigneeCode: "ACME", mode: "Air", incotermCode: "FOB", cargoReadyDate: "2027-01-01", goodsDescription: "Audit test", cargoLines: [{ packages: 1, grossWeight: 10, weightUnit: "KGS" }] };
    await failAction("CREATE");
    assert.equal((await request("/bookings", "POST", body)).status, 500);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.bookings`)).rows[0].count, 0);
    await failAction(null);
    const created = await request("/bookings", "POST", body);
    assert.equal(created.status, 201);
    const booking = await created.json();
    assert.equal((await events("CREATE", booking.reference)).length, 1);
    const auditAfterCreate = await (await request("/audit-logs", "GET")).json();
    assert.equal(auditAfterCreate.total, 1);
    assert.equal(auditAfterCreate.items[0].action, "CREATE");
    assert.equal(auditAfterCreate.items[0].entityId, booking.reference);
    assert.equal(typeof auditAfterCreate.items[0].id, "string");

    await failAction("UPDATE");
    assert.equal((await request(`/bookings/${booking.id}`, "PUT", { notes: "changed" })).status, 500);
    assert.notEqual((await (await request(`/bookings/${booking.id}`, "GET")).json()).notes, "changed");
    await failAction(null);
    assert.equal((await request(`/bookings/${booking.id}`, "PUT", { notes: "changed" })).status, 200);
    assert.equal((await events("UPDATE", booking.reference)).length, 1);
    assert.equal((await request(`/bookings/${booking.id}`, "PUT", { notes: "invalid", containers: [{ id: "duplicate" }, { id: "duplicate" }] })).status, 500);
    assert.equal((await events("UPDATE", booking.reference)).length, 1);
    assert.equal((await (await request(`/bookings/${booking.id}`, "GET")).json()).notes, "changed");
    assert.equal((await request(`/bookings/${booking.id}/validate`, "POST", {})).status, 200);
    assert.equal((await request(`/bookings/${booking.id}/submit-approval`, "POST", {})).status, 200);
    const pending = await (await request(`/bookings/${booking.id}`, "GET")).json();
    const approvalId = pending.pendingApproval.id;
    await failAction("APPROVE");
    assert.equal((await request(`/approvals/${approvalId}/approve`, "POST", {})).status, 500);
    assert.equal((await (await request(`/bookings/${booking.id}`, "GET")).json()).status, "PENDING_APPROVAL");
    await failAction(null);
    assert.equal((await request(`/approvals/${approvalId}/approve`, "POST", {})).status, 200);
    assert.equal((await request(`/approvals/${approvalId}/approve`, "POST", {})).status, 409);
    assert.equal((await events("APPROVE", booking.reference)).length, 1);

    await failAction("CW_SEND");
    assert.equal((await request(`/bookings/${booking.id}/complete`, "POST", {})).status, 503);
    assert.equal((await (await request(`/bookings/${booking.id}`, "GET")).json()).status, "APPROVED");
    const cwPending = await pendingOperation("CW_COMPLETE");
    assert.ok(cwPending);
    await stop();
    await start();
    assert.equal((await pendingOperation("CW_COMPLETE")).id, cwPending.id);
    assert.ok((await (await request("/audit-logs", "GET")).json()).items.some((item) => item.action === "CREATE" && item.entityId === booking.reference));
    assert.equal((await request(`/bookings/${booking.id}/complete`, "POST", {})).status, 409);
    assert.equal((await request(`/bookings/${booking.id}`, "PUT", { notes: "blocked" })).status, 409);
    assert.equal((await reconcile(cwPending.id, { outcome: "APPLIED", notes: "Checked" })).status, 400);
    await failAction(null);
    assert.equal((await reconcile(cwPending.id, { outcome: "NOT_APPLIED", notes: "Verified not sent" })).status, 200);
    assert.equal((await request(`/bookings/${booking.id}/complete`, "POST", {})).status, 200);
    assert.equal((await events("CW_SEND", booking.reference)).length, 1);
    assert.equal((await request(`/bookings/${booking.id}/resend-cw`, "POST", {})).status, 200);
    assert.equal((await events("CW_UPDATE", booking.reference)).length, 1);
    assert.equal((await request(`/bookings/${booking.id}`, "PUT", { notes: "completed edit" })).status, 200);
    assert.equal((await events("EDIT_COMPLETED", booking.reference)).length, 1);

    async function approvedBooking(description) {
      const response = await request("/bookings", "POST", { ...body, goodsDescription: description });
      assert.equal(response.status, 201);
      const item = await response.json();
      assert.equal((await request(`/bookings/${item.id}/validate`, "POST", {})).status, 200);
      assert.equal((await request(`/bookings/${item.id}/submit-approval`, "POST", {})).status, 200);
      const detail = await (await request(`/bookings/${item.id}`, "GET")).json();
      assert.equal((await request(`/approvals/${detail.pendingApproval.id}/approve`, "POST", {})).status, 200);
      return item;
    }
    const uncertain = await approvedBooking("AUDIT-UNCERTAIN");
    const uncertainResponse = await (await request(`/bookings/${uncertain.id}/complete`, "POST", {})).json();
    assert.equal(uncertainResponse.reconciliationRequired, true);
    assert.equal(uncertainResponse.cw.ok, false);
    assert.equal((await (await request(`/bookings/${uncertain.id}`, "GET")).json()).status, "COMPLETED");
    const uncertainOperation = await pendingOperation("CW_COMPLETE");
    assert.equal((await reconcile(uncertainOperation.id, { outcome: "NOT_APPLIED", notes: "Confirmed no booking" })).status, 200);
    assert.equal((await (await request(`/bookings/${uncertain.id}`, "GET")).json()).status, "APPROVED");

    const noReference = await approvedBooking("AUDIT-NO-REFERENCE");
    const noReferenceResponse = await (await request(`/bookings/${noReference.id}/complete`, "POST", {})).json();
    assert.equal(noReferenceResponse.reconciliationRequired, true);
    const appliedOperation = await pendingOperation("CW_COMPLETE");
    const denied = await fetch(`${base}/admin/operations/${appliedOperation.id}/reconcile`, {
      method: "POST", headers: { "content-type": "application/json", "x-test-deny": "1" },
      body: JSON.stringify({ outcome: "APPLIED", notes: "Checked", cwReference: "S12345678" })
    });
    assert.equal(denied.status, 403);
    assert.equal((await reconcile(appliedOperation.id, { outcome: "APPLIED", notes: "Verified in CargoWise", cwReference: "S12345678" })).status, 200);
    const reconciledBooking = await (await request(`/bookings/${noReference.id}`, "GET")).json();
    assert.equal(reconciledBooking.cw1ShipmentRef, "S12345678");
    assert.equal(reconciledBooking.status, "COMPLETED");
    assert.equal(reconciledBooking.cwStatus, "SENT");
    assert.equal((await events("OPERATION_RECONCILED", noReference.reference)).length, 1);

    const delayed = await approvedBooking("AUDIT-DELAY");
    const sending = request(`/bookings/${delayed.id}/complete`, "POST", {});
    let active;
    for (let attempt = 0; attempt < 30; attempt++) {
      active = await pendingOperation("CW_COMPLETE");
      if (active) break;
      await sleep(100);
    }
    assert.ok(active);
    assert.equal((await reconcile(active.id, { outcome: "NOT_APPLIED", notes: "Attempt while in progress" })).status, 409);
    assert.equal((await request(`/bookings/${delayed.id}/complete`, "POST", {})).status, 409);
    assert.equal((await sending).status, 200);
    assert.equal(await pendingOperation("CW_COMPLETE"), undefined);

    const interrupted = await approvedBooking("AUDIT-DELAY");
    const interruptedSend = request(`/bookings/${interrupted.id}/complete`, "POST", {}).catch(() => null);
    let interruptedOperation;
    for (let attempt = 0; attempt < 30; attempt++) {
      interruptedOperation = await pendingOperation("CW_COMPLETE");
      if (interruptedOperation) break;
      await sleep(100);
    }
    assert.ok(interruptedOperation);
    await stop();
    await interruptedSend;
    await start();
    assert.equal((await pendingOperation("CW_COMPLETE")).id, interruptedOperation.id);
    assert.equal((await request(`/bookings/${interrupted.id}/complete`, "POST", {})).status, 409);
    assert.equal((await reconcile(interruptedOperation.id, { outcome: "APPLIED", notes: "Verified after interruption", cwReference: "S87654321" })).status, 200);
    assert.equal((await (await request(`/bookings/${interrupted.id}`, "GET")).json()).cw1ShipmentRef, "S87654321");

    const rejectedBooking = await (await request("/bookings", "POST", body)).json();
    assert.equal((await request(`/bookings/${rejectedBooking.id}/validate`, "POST", {})).status, 200);
    assert.equal((await request(`/bookings/${rejectedBooking.id}/submit-approval`, "POST", {})).status, 200);
    const rejectedPending = await (await request(`/bookings/${rejectedBooking.id}`, "GET")).json();
    await failAction("REJECT");
    assert.equal((await request(`/approvals/${rejectedPending.pendingApproval.id}/reject`, "POST", { comment: "Not approved" })).status, 500);
    assert.equal((await (await request(`/bookings/${rejectedBooking.id}`, "GET")).json()).status, "PENDING_APPROVAL");
    await failAction(null);
    assert.equal((await request(`/approvals/${rejectedPending.pendingApproval.id}/reject`, "POST", { comment: "Not approved" })).status, 200);
    assert.equal((await events("REJECT", rejectedBooking.reference)).length, 1);

    const order = { orderNo: "AUDIT-TEST", orderDate: "2027-01-01", transportMode: "Air", supplierCode: "LANKAENG", buyerCode: "ACME" };
    await failAction("ORDER_CREATE");
    assert.equal((await request("/orders", "POST", order)).status, 503);
    const createPending = await pendingOperation("ORDER_CREATE");
    assert.ok(createPending);
    assert.equal((await request("/orders", "POST", order)).status, 409);
    await failAction(null);
    await stop();
    await start();
    assert.equal((await pendingOperation("ORDER_CREATE")).id, createPending.id);
    assert.ok(!(await (await request("/orders", "GET")).json()).items.some((item) => item.orderNo === order.orderNo));
    assert.equal((await request("/orders", "POST", order)).status, 409);
    assert.equal((await reconcile(createPending.id, { outcome: "NOT_APPLIED", notes: "Order was lost on restart" })).status, 200);
    const savedOrder = await (await request("/orders", "POST", order)).json();
    assert.equal((await events("ORDER_CREATE", savedOrder.reference)).length, 1);
    assert.equal((await request(`/orders/${savedOrder.id}/link-booking`, "POST", { bookingId: booking.id })).status, 200);
    await failAction("ORDER_DELETE");
    assert.equal((await request(`/orders/${savedOrder.id}`, "DELETE")).status, 503);
    const deletePending = await pendingOperation("ORDER_DELETE");
    assert.ok(deletePending);
    assert.equal((await request(`/orders/${savedOrder.id}`, "GET")).status, 404);
    await failAction(null);
    assert.equal((await reconcile(deletePending.id, { outcome: "APPLIED", notes: "Order no longer exists" })).status, 200);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.order_links WHERE order_id = $1`, [savedOrder.id])).rows[0].count, 0);

    await pool.query(`INSERT INTO ${schema}.audit_events (id, occurred_at, actor_name, actor_role, action, entity_type, entity_id, before_data, after_data)
      SELECT 'audit-api-' || lpad(n::text, 3, '0'), '2100-01-01'::timestamptz, 'User', 'Admin', 'TEST', 'Booking', n::text,
        '{"status":"before"}'::jsonb, '{"status":"after"}'::jsonb FROM generate_series(1, 205) AS n`);
    const count = (await pool.query(`SELECT count(*)::int AS total FROM ${schema}.audit_events`)).rows[0].total;
    const audit = await (await request("/audit-logs", "GET")).json();
    assert.equal(audit.total, count);
    assert.equal(audit.items.length, 200);
    assert.deepEqual(audit.items[0], {
      id: "audit-api-205", occurredAt: "2100-01-01T00:00:00.000Z", actorName: "User", actorRole: "Admin",
      action: "TEST", entityType: "Booking", entityId: "205", before: { status: "before" }, after: { status: "after" }
    });
    assert.equal(audit.items[199].id, "audit-api-006");
    await pool.query(`ALTER TABLE ${schema}.audit_events RENAME TO audit_events_unavailable`);
    try {
      const failedRead = await request("/audit-logs", "GET");
      assert.equal(failedRead.status, 500);
      assert.equal(typeof (await failedRead.json()).error, "string");
    } finally {
      await pool.query(`ALTER TABLE ${schema}.audit_events_unavailable RENAME TO audit_events`);
    }
    assert.equal((await (await request("/audit-logs", "GET")).json()).total, count);
  } finally {
    await stop();
    try { if (createdSchema) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
