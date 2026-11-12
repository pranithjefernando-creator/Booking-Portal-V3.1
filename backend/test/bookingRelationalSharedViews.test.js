import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../src/lib/bookingRelationalStore.js";

test("staged v4 shared views use scoped relational bookings and approvals across restart", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const org = `TEST-${randomUUID()}`;
  const email = `${randomUUID()}@example.invalid`;
  const otherEmail = `${randomUUID()}@example.invalid`;
  const pool = createBookingPool();
  const store = createRelationalBookingStore(pool);
  const ids = [];
  let child;
  let errors = "";
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  async function start(overrides = {}) {
    errors = "";
    child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/relationalWorkflowLoader.js", import.meta.url).href, fileURLToPath(new URL("./fixtures/relationalViewsServer.js", import.meta.url))], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: String(port), TEST_BOOKING_ORG: org, TEST_USER_EMAIL: email, TEST_OTHER_EMAIL: otherEmail, ...overrides }
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
  async function json(path, other = false) {
    const response = await fetch(base + path, { headers: other ? { "x-other": "1" } : {} });
    assert.equal(response.status, 200, path);
    return response.json();
  }
  const now = new Date();
  const current = new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).toISOString();
  const old = new Date(now.getFullYear(), now.getMonth() - 2, 15, 12).toISOString();
  async function booking(status, values = {}) {
    const id = randomUUID();
    ids.push(id);
    return store.create({ id, reference: `TEST-${id}`, cwOrgCode: org, status, mode: "Air", shipper: { companyName: "Example shipper" }, createdBy: db.users[2].name, createdByEmail: email, createdAt: current, updatedAt: current, ...values });
  }
  async function approval(booking, status, requestedAt) {
    const data = { id: randomUUID(), bookingId: booking.id, status, requestedAt };
    await pool.query("INSERT INTO booking_portal_v4.approvals (id, booking_id, data) VALUES ($1, $2, $3)", [data.id, booking.id, data]);
  }
  try {
    const draft = await booking("DRAFT", { documents: [{ id: "doc", type: "DOC", fileName: "test.txt", size: 3, contentBase64: "YWJj" }] });
    const rejected = await booking("DRAFT");
    const pending = await booking("PENDING_APPROVAL");
    const completed = await booking("COMPLETED", { createdAt: previous, completedAt: current, cfsReceived: true });
    await booking("COMPLETED", { createdAt: previous });
    const history = await booking("DRAFT");
    const hidden = await booking("PENDING_APPROVAL", { cwOrgCode: `OTHER-${randomUUID()}` });
    await approval(rejected, "REJECTED", previous);
    await approval(pending, "PENDING", current);
    await approval(history, "REJECTED", old);
    await approval(history, "APPROVED", previous);
    await approval(hidden, "PENDING", current);
    const snapshot = await store.listNotificationSnapshot();
    const draftRow = snapshot.find((row) => row.booking.id === draft.id);
    assert.ok(!Object.hasOwn(draftRow.booking, "documents"));
    assert.deepEqual(draftRow.approvals, []);
    assert.equal(snapshot.find((row) => row.booking.id === history.id).approvals.length, 2);

    await start();
    const list = await json("/bookings");
    assert.equal(list.total, 6);
    assert.equal(list.items.find((item) => item.id === draft.id).documentCount, 1);
    assert.ok(!list.items.some((item) => item.id === hidden.id || item.id === "in-memory-decoy"));
    assert.equal((await json("/bookings?status=COMPLETED")).total, 2);
    assert.equal((await json(`/bookings?q=${encodeURIComponent(completed.reference)}`)).items[0].id, completed.id);
    const summary = await json("/dashboard/summary");
    assert.equal(summary.kpis.total, 6);
    assert.equal(summary.kpis.draft, 3);
    assert.equal(summary.kpis.completed, 2);
    assert.equal(summary.kpis.cfsReceived, 1);
    assert.equal(summary.months.length, 6);
    assert.equal(summary.months[4].created, 2);
    assert.equal(summary.months[5].created, 4);
    assert.equal(summary.months[5].completed, 1);
    assert.ok(summary.recent.some((item) => item.id === completed.id));
    assert.ok(!summary.recent.some((item) => item.id === hidden.id));
    const counts = await json("/bookings/kpis");
    assert.equal(counts.total, 6);
    assert.equal(counts.pendingApproval, 1);
    const options = await json("/orders/meta/bookings");
    assert.equal(options.total, 6);
    assert.equal(options.items.find((item) => item.id === draft.id).shipper, "Example shipper");
    assert.ok(!options.items.some((item) => item.id === hidden.id));
    const notifications = await json("/notifications/summary");
    assert.deepEqual(Object.fromEntries(notifications.items.map((item) => [item.key, item.count])), { approvals: 1, rejected: 1, validation: 2 });
    assert.equal(notifications.total, 4);
    assert.ok(!(await json("/notifications/summary", true)).items.some((item) => item.key === "rejected"));
    await stop();
    await start();
    assert.deepEqual(await json("/notifications/summary"), notifications);
    assert.equal((await json("/dashboard/summary")).kpis.total, 6);
    assert.equal((await json("/orders/meta/bookings")).total, 6);
    await store.update(draft.id, (item) => ({ ...item, status: "VALIDATED" }));
    assert.equal((await json("/bookings/kpis")).validated, 1);
    assert.equal((await json("/dashboard/summary")).kpis.draft, 2);
    assert.equal((await json("/notifications/summary")).items.find((item) => item.key === "validation").count, 1);
    await stop();
    await start({ PGHOST: "127.0.0.1", PGPORT: "1", PGDATABASE: "test", PGUSER: "test", PGPASSWORD: "test" });
    for (const path of ["/bookings", "/bookings/kpis", "/dashboard/summary", "/notifications/summary", "/orders/meta/bookings"]) assert.equal((await fetch(base + path)).status, 500, path);
  } finally {
    await stop();
    try {
      await pool.query("DELETE FROM booking_portal_v4.approvals WHERE booking_id = ANY($1::text[])", [ids]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});

test("v4 notification snapshot keeps booking and approval transitions consistent", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const store = createRelationalBookingStore(pool);
  const id = randomUUID();
  const approvalId = randomUUID();
  let unblock, signalReached;
  const reached = new Promise((resolve) => { signalReached = resolve; });
  const unblocked = new Promise((resolve) => { unblock = resolve; });
  const instrumentedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          assert.ok(!sql.includes("booking_portal_v4.booking_documents"), "notification snapshots must not load documents");
          if (sql === "SELECT booking_id, data FROM booking_portal_v4.approvals") { signalReached(); await unblocked; }
          return client.query(sql, params);
        },
        release() { client.release(); }
      };
    }
  };
  try {
    await store.create({ id, reference: `TEST-${id}`, status: "VALIDATED", documents: [] });
    const pendingSnapshot = createRelationalBookingStore(instrumentedPool).listNotificationSnapshot();
    await reached;
    await store.updateWithApproval(id, (booking) => ({ booking: { ...booking, status: "PENDING_APPROVAL" }, approval: { id: approvalId, bookingId: id, status: "PENDING" } }));
    unblock();
    const before = (await pendingSnapshot).find((row) => row.booking.id === id);
    assert.equal(before.booking.status, "VALIDATED");
    assert.deepEqual(before.approvals, []);
    const after = (await store.listNotificationSnapshot()).find((row) => row.booking.id === id);
    assert.equal(after.booking.status, "PENDING_APPROVAL");
    assert.equal(after.approvals[0].status, "PENDING");
  } finally {
    unblock();
    try {
      await pool.query("DELETE FROM booking_portal_v4.approvals WHERE id = $1", [approvalId]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = $1", [id]);
    } finally { await pool.end(); }
  }
});
