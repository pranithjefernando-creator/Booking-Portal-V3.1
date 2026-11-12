import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { closeBookingDatabase } from "../src/lib/bookingDatabase.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../src/lib/bookingRelationalStore.js";
import { createApp } from "../src/lib/http.js";
import bookingsRouter from "../src/routes/bookings.js";
import ordersRouter from "../src/routes/orders.js";
import miscRouter from "../src/routes/misc.js";

test("shared views use scoped PostgreSQL bookings and approvals", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const org = `TEST-${randomUUID()}`;
  const user = { ...db.users[2], email: `${randomUUID()}@example.invalid`, bookingOrgs: [org] };
  const sameName = { ...user, email: `${randomUUID()}@example.invalid` };
  const pool = createBookingPool();
  const store = createRelationalBookingStore(pool);
  const ids = [];
  let server;
  async function start() {
    const app = createApp();
    app.use((req, res, next) => { req.user = req.header("x-other") ? sameName : user; next(); });
    app.use("/bookings", bookingsRouter);
    app.use("/orders", ordersRouter);
    app.use("/", miscRouter);
    server = app.listen(0);
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) { await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); server = undefined; }
    await closeBookingDatabase();
  }
  const now = new Date();
  const current = new Date(now.getFullYear(), now.getMonth(), 15, 12).toISOString();
  const previous = new Date(now.getFullYear(), now.getMonth() - 1, 15, 12).toISOString();
  const old = new Date(now.getFullYear(), now.getMonth() - 2, 15, 12).toISOString();
  async function booking(status, values = {}) {
    const id = randomUUID();
    ids.push(id);
    return store.create({ id, reference: `TEST-${id}`, cwOrgCode: org, status, mode: "Air", shipper: {}, createdBy: user.name, createdByEmail: user.email, createdAt: current, updatedAt: current, ...values });
  }
  async function approval(b, status, requestedAt) {
    const a = { id: randomUUID(), bookingId: b.id, status, requestedAt };
    await pool.query("INSERT INTO booking_portal_v4.approvals (id, booking_id, data) VALUES ($1, $2, $3)", [a.id, b.id, a]);
  }
  async function json(base, path, other = false) {
    const response = await fetch(base + path, { headers: other ? { "x-other": "1" } : {} });
    assert.equal(response.status, 200);
    return response.json();
  }
  try {
    const draft = await booking("DRAFT");
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
    db.bookings.push({ id: randomUUID(), cwOrgCode: org, status: "DRAFT", createdAt: current });
    let base = await start();
    const summary = await json(base, "/dashboard/summary");
    assert.equal(summary.kpis.total, 6);
    assert.equal(summary.kpis.draft, 3);
    assert.equal(summary.kpis.completed, 2);
    assert.equal(summary.kpis.cfsReceived, 1);
    assert.equal(summary.months.length, 6);
    assert.equal(summary.months[4].created, 2);
    assert.equal(summary.months[5].created, 4);
    assert.equal(summary.months[5].completed, 1);
    assert.ok(summary.recent.some((b) => b.id === completed.id));
    assert.ok(!summary.recent.some((b) => b.id === hidden.id));
    const counts = await json(base, "/bookings/kpis");
    assert.equal(counts.total, 6);
    assert.equal(counts.pendingApproval, 1);
    const options = await json(base, "/orders/meta/bookings");
    assert.equal(options.total, 6);
    assert.ok(options.items.some((b) => b.id === draft.id));
    assert.ok(!options.items.some((b) => b.id === hidden.id));
    const notifications = await json(base, "/notifications/summary");
    assert.deepEqual(Object.fromEntries(notifications.items.map((n) => [n.key, n.count])), { approvals: 1, rejected: 1, validation: 2 });
    assert.equal(notifications.total, 4);
    const other = await json(base, "/notifications/summary", true);
    assert.ok(!other.items.some((item) => item.key === "rejected"));
    await stop();
    base = await start();
    assert.deepEqual(await json(base, "/notifications/summary"), notifications);
    assert.equal((await json(base, "/dashboard/summary")).kpis.total, 6);
    assert.equal((await json(base, "/orders/meta/bookings")).total, 6);
    await store.update(draft.id, (b) => ({ ...b, status: "VALIDATED" }));
    assert.equal((await json(base, "/bookings/kpis")).validated, 1);
    assert.equal((await json(base, "/dashboard/summary")).kpis.draft, 2);
    assert.equal((await json(base, "/notifications/summary")).items.find((n) => n.key === "validation").count, 1);
  } finally {
    await stop();
    try {
      await pool.query("DELETE FROM booking_portal_v4.approvals WHERE booking_id = ANY($1::text[])", [ids]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});

test("shared booking views report database failures instead of returning empty results", async () => {
  seed();
  const keys = ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"];
  const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  await closeBookingDatabase();
  Object.assign(process.env, { PGHOST: "127.0.0.1", PGPORT: "1", PGDATABASE: "test", PGUSER: "test", PGPASSWORD: "test" });
  const app = createApp();
  app.use((req, res, next) => { req.user = db.users[0]; next(); });
  app.use("/bookings", bookingsRouter);
  app.use("/orders", ordersRouter);
  app.use("/", miscRouter);
  const server = app.listen(0);
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const path of ["/dashboard/summary", "/bookings/kpis", "/notifications/summary", "/orders/meta/bookings"]) {
      assert.equal((await fetch(base + path)).status, 500);
    }
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await closeBookingDatabase();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
