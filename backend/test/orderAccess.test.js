import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { canSeeOrder, db, makeOrder } from "../src/db.js";
import { createApp } from "../src/lib/http.js";
import ordersRouter from "../src/routes/orders.js";

const user = { role: "Ops", orderOrgs: ["SUPPLIER", "BUYER"] };

test("order visibility matches the assigned supplier organization or buyer code", () => {
  assert.equal(canSeeOrder(user, { cwOrgCode: "SUPPLIER" }), true);
  assert.equal(canSeeOrder(user, { cwOrgCode: "OTHER", buyerCode: "BUYER" }), true);
  assert.equal(canSeeOrder(user, { buyerCode: "BUYER" }), true);
  assert.equal(canSeeOrder(user, { cwOrgCode: "OTHER", buyerCode: "OTHER" }), false);
});

test("order writes, documents and imports enforce scope and batch ownership", async () => {
  const scopedUser = { id: "owner", name: "Owner", email: "owner@example.invalid", role: "Test", orderOrgs: ["ACME"] };
  const otherUser = { ...scopedUser, id: "other", email: "other@example.invalid" };
  const role = { name: "Test", permissions: ["order.view", "order.create", "order.import"], modules: ["orders"] };
  const outside = makeOrder({ cwOrgCode: "LRG", buyerCode: "LRG", documents: [{ id: "doc", contentBase64: Buffer.from("private").toString("base64") }] });
  db.orders.push(outside);
  const app = createApp();
  app.use((req, res, next) => {
    req.user = req.header("x-other") ? otherUser : req.header("x-empty") ? { ...scopedUser, orderOrgs: [] } : scopedUser;
    req.accessRole = role;
    next();
  });
  app.use("/orders", ordersRouter);
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method, body, header = {}) => fetch(base + path, { method, headers: { "content-type": "application/json", ...header }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const order = { orderNo: "scope-test", orderDate: "2027-01-01", transportMode: "Air", supplierCode: "LRG", buyerCode: "LRG" };
    assert.equal((await request("/orders", "POST", order)).status, 403);
    for (const [path, method] of [[`/orders/${outside.id}/documents`, "POST"], [`/orders/${outside.id}/documents/doc/download`, "GET"], [`/orders/${outside.id}/documents/doc`, "DELETE"]]) {
      assert.equal((await request(path, method, method === "POST" ? {} : undefined)).status, 403);
    }
    const csv = "orderNo,orderDate,transportMode,supplierCode,buyerCode\nscope-test,2027-01-01,Air,LRG,LRG\n";
    const batchResponse = await request("/orders/import", "POST", { csv });
    assert.equal(batchResponse.status, 201);
    const batch = await batchResponse.json();
    assert.equal((await request(`/orders/import/${batch.id}/rows/1`, "PATCH", { data: {} }, { "x-other": "1" })).status, 403);
    assert.equal((await request(`/orders/import/${batch.id}/commit`, "POST", {}, { "x-other": "1" })).status, 403);
    assert.equal((await request(`/orders/import/${batch.id}/commit`, "POST", {}, { "x-empty": "1" })).status, 403);
    assert.equal((await request(`/orders/import/${batch.id}/commit`, "POST", {})).status, 403);
    assert.equal((await request(`/orders/import/${batch.id}/rows/1`, "PATCH", { data: { supplierCode: "ACME" } })).status, 200);
    assert.equal((await request(`/orders/import/${batch.id}/commit`, "POST", {})).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
