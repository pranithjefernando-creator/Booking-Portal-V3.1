import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { db, makeOrder, uuid, seed } from "../src/db.js";
import { authMiddleware, login, setPassword } from "../src/auth.js";
import { createApp, Router } from "../src/lib/http.js";
import ordersRouter from "../src/routes/orders.js";

test("an order can be linked to only one booking", async () => {
  seed();
  const admin = db.users[0];
  const password = "Order-Link-Test1";
  setPassword(admin.id, password);
  const order = makeOrder({ orderNo: "PO-LINK-1", cwOrgCode: "INTCOMMIA" });
  db.orders.push(order);
  const firstBooking = { id: uuid(), reference: "BK-LINK-1", orderIds: [] };
  const secondBooking = { id: uuid(), reference: "BK-LINK-2", orderIds: [] };
  db.bookings.push(firstBooking, secondBooking);

  const app = createApp();
  app.post("/api/auth/login", login);
  const router = Router();
  router.use(authMiddleware);
  router.use("/orders", ordersRouter);
  app.use("/api/v1", router);
  const server = app.listen(0);
  await once(server, "listening");

  const base = `http://127.0.0.1:${server.address().port}`;
  const response = (path, method, body, token) => fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  try {
    const loginResponse = await response("/api/auth/login", "POST", { email: admin.email, password });
    const { token } = await loginResponse.json();
    assert.ok(token);
    const headers = { Authorization: `Bearer ${token}` };
    const firstLink = await response(`/api/v1/orders/${order.id}/link-booking`, "POST", { bookingId: firstBooking.id }, token);
    assert.equal(firstLink.status, 200);
    assert.deepEqual(firstBooking.orderIds, [order.id]);

    const repeatedLink = await response(`/api/v1/orders/${order.id}/link-booking`, "POST", { bookingId: firstBooking.id }, token);
    assert.equal(repeatedLink.status, 200);

    const secondLink = await response(`/api/v1/orders/${order.id}/link-booking`, "POST", { bookingId: secondBooking.id }, token);
    assert.equal(secondLink.status, 409);
    assert.equal(order.bookingId, firstBooking.id);
    assert.deepEqual(secondBooking.orderIds, []);

    const update = await fetch(base + `/api/v1/orders/${order.id}`, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId: secondBooking.id, bookingRef: secondBooking.reference })
    });
    assert.equal(update.status, 200);
    assert.equal(order.bookingId, firstBooking.id);

    const unlink = await response(`/api/v1/orders/${order.id}/unlink-booking`, "POST", {}, token);
    assert.equal(unlink.status, 200);
    assert.deepEqual(firstBooking.orderIds, []);
    const linkAfterUnlink = await response(`/api/v1/orders/${order.id}/link-booking`, "POST", { bookingId: secondBooking.id }, token);
    assert.equal(linkAfterUnlink.status, 200);
    assert.equal(order.bookingId, secondBooking.id);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
