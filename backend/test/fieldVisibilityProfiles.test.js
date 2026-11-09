import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { db, seed } from "../src/db.js";
import { authMiddleware, login, setPassword } from "../src/auth.js";
import { createApp, Router } from "../src/lib/http.js";
import miscRouter from "../src/routes/misc.js";
import { FIELD_CATALOG } from "../src/fieldVisibilityCatalog.js";

test("backend field catalog matches the frontend when both are available", async (t) => {
  const frontend = new URL("../../frontend/src/lib/formVisibility.js", import.meta.url);
  if (!existsSync(frontend)) return t.skip("Frontend is not present in this backend deployment");
  const { FIELD_CATALOG: clientCatalog } = await import(frontend.href);
  for (const module of ["booking", "order"]) {
    assert.deepEqual(FIELD_CATALOG[module], clientCatalog[module].map(({ key, required }) => ({ key, required })));
  }
});

test("visibility profiles are validated, assigned independently and resolved per user", async () => {
  seed();
  const [admin, ordinary] = db.users;
  setPassword(admin.id, "Test-Password1");
  setPassword(ordinary.id, "Test-Password1");
  const app = createApp();
  app.post("/api/auth/login", login);
  const router = Router();
  router.use(authMiddleware);
  router.use("/", miscRouter);
  app.use("/api/v1", router);
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, method = "GET", body, token) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const api = "/api/v1";
  try {
    const adminToken = (await (await request("/api/auth/login", "POST", { email: admin.email, password: "Test-Password1" })).json()).token;
    const userToken = (await (await request("/api/auth/login", "POST", { email: ordinary.email, password: "Test-Password1" })).json()).token;
    const call = (path, method, body, token = adminToken) => request(api + path, method, body, token);
    assert.deepEqual((await (await call("/me", "GET", undefined, userToken)).json()).fieldVisibility, { booking: [], order: [] });
    assert.equal((await call("/field-visibility-profiles", "GET", undefined, userToken)).status, 403);
    const endpoint = "/field-visibility-profiles";
    for (const invalid of [
      { name: "", module: "booking", hiddenFields: [] },
      { name: "Bad", module: "other", hiddenFields: [] },
      { name: "Bad", module: "booking", hiddenFields: "notes" },
      { name: "Bad", module: "booking", hiddenFields: ["unknown"] },
      { name: "Bad", module: "order", hiddenFields: ["cargoLines.volume"] }
    ]) assert.equal((await call(endpoint, "POST", invalid)).status, 400);
    for (const module of ["booking", "order"]) {
      for (const field of FIELD_CATALOG[module].filter((item) => item.required)) {
        assert.equal((await call(endpoint, "POST", { name: "Invalid", module, hiddenFields: [field.key] })).status, 400);
      }
    }
    const booking = await (await call(endpoint, "POST", { name: "Booking compact", module: "booking", hiddenFields: ["notes", "notes"] })).json();
    assert.deepEqual(booking.hiddenFields, ["notes"]);
    const order = await (await call(endpoint, "POST", { name: "Order compact", module: "order", hiddenFields: ["orderNoSplit"] })).json();
    assert.equal((await (await call(endpoint)).json()).items.length, 2);
    assert.equal((await call("/users", "POST", { name: "Invalid", email: "invalid@example.com", bookingVisibilityProfileId: order.id })).status, 400);
    const createdResponse = await call("/users", "POST", { name: "New user", email: "visibility@example.com", bookingVisibilityProfileId: booking.id, orderVisibilityProfileId: order.id });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.bookingVisibilityProfileId, booking.id);
    assert.equal(created.orderVisibilityProfileId, order.id);
    assert.equal((await call(`/users/${ordinary.id}`, "PUT", { bookingVisibilityProfileId: order.id })).status, 400);
    const oldRules = ordinary.ruleConfigurationId;
    assert.equal((await call(`/users/${ordinary.id}`, "PUT", { bookingVisibilityProfileId: booking.id, orderVisibilityProfileId: order.id })).status, 200);
    assert.equal(ordinary.ruleConfigurationId, oldRules);
    assert.deepEqual((await (await call("/me", "GET", undefined, userToken)).json()).fieldVisibility, { booking: ["notes"], order: ["orderNoSplit"] });
    assert.equal((await call(`${endpoint}/${booking.id}`, "DELETE")).status, 409);
    assert.equal((await call(`${endpoint}/${booking.id}`, "PUT", { ...booking, module: "order", hiddenFields: [] })).status, 409);
    assert.equal((await call(`${endpoint}/${booking.id}`, "PUT", { ...booking, hiddenFields: ["freightTerms"] })).status, 200);
    assert.deepEqual((await (await call("/me", "GET", undefined, userToken)).json()).fieldVisibility.booking, ["freightTerms"]);
    await call(`/users/${ordinary.id}`, "PUT", { bookingVisibilityProfileId: null, orderVisibilityProfileId: "" });
    assert.deepEqual((await (await call("/me", "GET", undefined, userToken)).json()).fieldVisibility, { booking: [], order: [] });
    await call(`/users/${created.id}`, "PUT", { bookingVisibilityProfileId: "", orderVisibilityProfileId: "" });
    assert.equal((await call(`${endpoint}/${booking.id}`, "DELETE")).status, 200);
    assert.equal((await call(`${endpoint}/${booking.id}`, "DELETE")).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
