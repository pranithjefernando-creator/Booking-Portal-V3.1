import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBookingPool } from "../src/lib/bookingStore.js";

test("order links persist, enforce scopes and restore after a process restart and refresh", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const orderNo = `TEST-LINK-${randomUUID()}`;
  const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
  const pool = createBookingPool();
  const bookingIds = [];
  const base = `http://127.0.0.1:${port}`;
  let child;
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/orderLinkServer.js", import.meta.url))], { stdio: "ignore", env: { ...process.env, PORT: String(port), TEST_ORDER_NO: orderNo } });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Order link test server exited before becoming ready");
      try { if ((await fetch(`${base}/ready`)).ok) return; } catch { await sleep(100); }
    }
    throw new Error("Order link test server did not become ready");
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    child = undefined;
  }
  function request(path, method = "GET", body, scope) {
    return fetch(base + path, { method, headers: { "content-type": "application/json", ...(scope ? { "x-test-scope": scope } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  try {
    await start();
    for (let i = 0; i < 2; i++) {
      const response = await request("/bookings", "POST", { cwOrgCode: "TESTCO", notes: "order link test" });
      assert.equal(response.status, 201);
      bookingIds.push((await response.json()).id);
    }
    const [first, second] = bookingIds;
    const linkPath = `/orders/${orderId}/link-booking`;
    const unlinkPath = `/orders/${orderId}/unlink-booking`;
    assert.ok((await (await request("/orders/meta/bookings")).json()).items.some((item) => item.id === first));
    assert.equal((await request(linkPath, "POST", { bookingId: first }, "order-restricted")).status, 403);
    assert.equal((await request(linkPath, "POST", { bookingId: first }, "restricted")).status, 403);
    assert.equal((await request(linkPath, "POST", { bookingId: first }, "order-only")).status, 403);
    assert.equal((await request("/orders/meta/bookings", "GET", undefined, "order-only")).status, 403);
    assert.equal((await request(linkPath, "POST", {})).status, 400);
    assert.equal((await request(linkPath, "POST", { bookingId: randomUUID() })).status, 404);
    const attempts = await Promise.all(bookingIds.map((bookingId) => request(linkPath, "POST", { bookingId })));
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 409]);
    const winner = bookingIds[attempts.findIndex((response) => response.status === 200)];
    const loser = winner === first ? second : first;
    const booking = await (await request(`/bookings/${winner}`)).json();
    assert.equal((await request(linkPath, "POST", { bookingId: winner })).status, 200);
    assert.equal((await request(linkPath, "POST", { bookingId: loser })).status, 409);
    assert.equal((await request(unlinkPath, "POST", {}, "restricted")).status, 403);
    assert.equal((await request(unlinkPath, "POST", { bookingId: loser })).status, 409);
    assert.equal((await (await request(`/orders/${orderId}`, "GET", undefined, "restricted")).json()).bookingId, "");
    assert.equal((await (await request(`/orders/${orderId}`, "GET", undefined, "order-only")).json()).bookingId, "");
    assert.deepEqual((await (await request(`/bookings/${winner}`, "GET", undefined, "booking-only")).json()).orderIds, []);
    assert.deepEqual(booking.orderIds, [orderId]);
    assert.equal(booking.linkedOrders[0].orderNo, orderNo);
    assert.deepEqual((await (await request(`/bookings/${winner}`, "PUT", { notes: "updated" })).json()).orderIds, [orderId]);
    assert.ok((await (await request("/bookings")).json()).items.find((item) => item.id === winner).linkedOrders.includes(orderNo));
    await request("/refresh", "POST", {});
    await stop();
    await start();
    let order = await (await request(`/orders/${orderId}`)).json();
    assert.equal(order.bookingId, winner);
    assert.equal(order.bookingRef, booking.reference);
    const filters = encodeURIComponent(JSON.stringify([{ field: "bookingRef", type: "text", operator: "eq", value: booking.reference }]));
    assert.ok((await (await request(`/orders?filters=${filters}`)).json()).items.some((item) => item.id === orderId && item.bookingId === winner));
    await request("/refresh", "POST", {});
    order = await (await request(`/orders/${orderId}`)).json();
    assert.equal(order.bookingId, winner);
    assert.equal((await request(unlinkPath, "POST", {})).status, 200);
    assert.equal((await request(unlinkPath, "POST", {})).status, 200);
    await stop();
    await start();
    assert.equal((await (await request(`/orders/${orderId}`)).json()).bookingId, "");
    assert.deepEqual((await (await request(`/bookings/${winner}`)).json()).orderIds, []);
  } finally {
    await stop();
    try {
      await pool.query("DELETE FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [bookingIds]);
    } finally { await pool.end(); }
  }
});
