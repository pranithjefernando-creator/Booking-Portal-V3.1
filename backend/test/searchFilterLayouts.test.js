import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { db, makeOrder, seed } from "../src/db.js";
import { authMiddleware, login, setPassword } from "../src/auth.js";
import { createApp, Router } from "../src/lib/http.js";
import bookingsRouter from "../src/routes/bookings.js";
import ordersRouter from "../src/routes/orders.js";

test("booking and order filter layouts are saved per user and can be deleted", async () => {
  seed();
  const admin = db.users[0];
  const password = "Filter-Layout-Test1";
  setPassword(admin.id, password);

  const app = createApp();
  app.post("/api/auth/login", login);
  const router = Router();
  router.use(authMiddleware);
  router.use("/bookings", bookingsRouter);
  router.use("/orders", ordersRouter);
  app.use("/api/v1", router);
  const server = app.listen(0);
  await once(server, "listening");

  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method, body, token) => fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  try {
    const loginResponse = await request("/api/auth/login", "POST", { email: admin.email, password });
    const { token } = await loginResponse.json();
    assert.ok(token);
    const filters = [{ field: "status", operator: "eq", value: "APPROVED", type: "text" }];
    const savedBooking = await request("/api/v1/bookings/filters", "POST", { name: "Approved", filters }, token);
    assert.equal(savedBooking.status, 201);
    const bookingLayouts = await (await request("/api/v1/bookings/filters/list", "GET", undefined, token)).json();
    assert.equal(bookingLayouts.layouts.length, 1);
    assert.deepEqual(bookingLayouts.layouts[0].filters, filters);

    const savedOrder = await request("/api/v1/orders/filters", "POST", { name: "Approved", filters }, token);
    assert.equal(savedOrder.status, 201);
    const orderLayouts = await (await request("/api/v1/orders/filters/list", "GET", undefined, token)).json();
    assert.equal(orderLayouts.layouts.length, 1);
    assert.deepEqual(orderLayouts.layouts[0].filters, filters);

    const invalid = await request("/api/v1/orders/filters", "POST", { name: "Invalid", filters: [] }, token);
    assert.equal(invalid.status, 400);
    const deleted = await request(`/api/v1/orders/filters/${orderLayouts.layouts[0].id}`, "DELETE", undefined, token);
    assert.equal(deleted.status, 200);
    assert.deepEqual((await deleted.json()).layouts, []);

    db.orders.push(
      makeOrder({ orderNo: "PO-SEARCH-1", cwOrgCode: "INTCOMMIA", weight: 12, status: "PENDING" }),
      makeOrder({ orderNo: "PO-SEARCH-2", cwOrgCode: "INTCOMMIA", weight: 4, status: "PENDING" })
    );
    const query = encodeURIComponent(JSON.stringify([{ field: "weight", operator: "gt", value: "10", type: "number" }]));
    const filteredOrders = await (await request(`/api/v1/orders?filters=${query}`, "GET", undefined, token)).json();
    assert.ok(filteredOrders.items.some((order) => order.orderNo === "PO-SEARCH-1"));
    assert.ok(!filteredOrders.items.some((order) => order.orderNo === "PO-SEARCH-2"));
    assert.ok(filteredOrders.items.every((order) => order.weight > 10));
    assert.equal((await request("/api/v1/orders?filters=not-json", "GET", undefined, token)).status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
