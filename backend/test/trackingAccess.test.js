import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { db, seed } from "../src/db.js";
import { canSeeTracking, historicalPorts, trackingOrganizations, trackingRecords } from "../src/lib/trackingAccess.js";
import { createApp, Router } from "../src/lib/http.js";
import { authMiddleware, login, setPassword } from "../src/auth.js";
import { config } from "../src/lib/config.js";
import trackingRouter from "../src/routes/tracking.js";
import congestionRouter from "../src/routes/portCongestion.js";
import miscRouter from "../src/routes/misc.js";

seed();
const record = { "Shipment ID": "S1", Trans: "SEA", "Consignor Name": "Customer A", "Consignee Name": "Receiver A", "Leg 1-Load": " SGSIN ", "Leg 1 - Discharge": "CNSHA" };
const user = { role: "Ops", modules: ["tracking"], trackingOrgs: ["tracking:CUSTOMER A"] };
test("tracking records require module access and an explicit matching scope", () => {
  assert.equal(canSeeTracking(user, record), true);
  assert.equal(canSeeTracking({ ...user, trackingOrgs: [] }, record), false);
  assert.equal(canSeeTracking({ ...user, trackingOrgs: ["tracking:CUSTOMER B"] }, record), false);
  assert.equal(canSeeTracking({ ...user, modules: ["orders"] }, record), false);
  assert.equal(canSeeTracking({ role: "Admin", trackingOrgs: [] }, record), false);
});
test("organization scopes come from trusted historical parties", () => {
  const organizations = trackingOrganizations([record]);
  assert.ok(organizations.some((org) => org.code === "tracking:CUSTOMER A"));
  assert.ok(organizations.some((org) => org.code === "tracking:RECEIVER A"));
  assert.equal(canSeeTracking({ ...user, trackingOrgs: ["tracking:RECEIVER A"] }, record), true);
});
test("congestion eligibility uses historical ocean leg ports only", () => {
  assert.deepEqual(historicalPorts([record, { ...record, Trans: "AIR", "Leg 1-Load": "GBLHR" }]), ["SGSIN", "CNSHA"]);
});

test("scoped accounts share one port fetch without sharing unauthorized shipment access", async () => {
  const records = await trackingRecords();
  const shipment = records.find((item) => item.Trans === "SEA" && historicalPorts([item]).length && item["Consignor Name"] && item["Consignee Name"]);
  assert.ok(shipment);
  const organizations = trackingOrganizations([shipment]);
  const shipper = organizations.find((org) => org.label === shipment["Consignor Name"]);
  const consignee = organizations.find((org) => org.label === shipment["Consignee Name"]);
  const makeUser = (id, scope, modules = ["tracking"]) => ({ id, email: `${id}@example.test`, name: id, role: "Ops", modules, modulesConfigured: true, trackingOrgs: scope });
  const users = [makeUser("scope-a", [shipper.code]), makeUser("scope-b", [consignee.code]), makeUser("scope-empty", []), makeUser("scope-disabled", [shipper.code], [])];
  db.users.push(...users);
  const password = "Scope-Test-Pass1";
  for (const account of [...users, db.users[0]]) setPassword(account.id, password);
  const settings = { ...config.freightPulse };
  Object.assign(config.freightPulse, { apiKey: "test-key", mode: "live", baseUrl: "https://api.panvaya.com/api/v1", rateLimitPerMin: 100, monthlyQuota: 1000 });
  const originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.panvaya.com/")) {
      providerCalls += 1;
      const code = new URL(url).searchParams.get("locode");
      return new Response(JSON.stringify({ count: 1, ports: [{ locode: code, name: code, country: "US", anchorLast30: { median: 2 } }] }));
    }
    return originalFetch(url, options);
  };
  const app = createApp();
  app.post("/api/auth/login", login);
  const router = Router();
  router.use(authMiddleware);
  router.use("/", trackingRouter);
  router.use("/", congestionRouter);
  router.use("/", miscRouter);
  app.use("/api/v1", router);
  const server = app.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, token) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const get = (path, token) => fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  try {
    const tokens = [];
    for (const account of [...users, db.users[0]]) tokens.push((await (await post("/api/auth/login", { email: account.email, password })).json()).token);
    const port = historicalPorts([shipment])[0];
    const history = await (await get("/api/v1/tracking/shipments", tokens[0])).json();
    assert.ok(history.records.length);
    assert.ok(history.records.every((item) => canSeeTracking(users[0], item)));
    assert.ok(Object.keys(history.eventsByShipment).every((id) => history.records.some((item) => item["Shipment ID"] === id)));
    assert.equal((await (await get("/api/v1/tracking/shipments", tokens[2])).json()).records.length, 0);
    assert.equal((await get("/api/v1/tracking/shipments", tokens[3])).status, 403);
    assert.ok((await (await get("/api/v1/port-congestion/history", tokens[0])).json()).ports.includes(port));
    const first = await (await post("/api/v1/port-congestion/lookup", { ports: [port] }, tokens[0])).json();
    const second = await (await post("/api/v1/port-congestion/lookup", { ports: [port] }, tokens[1])).json();
    assert.equal(first.ports[port].cached, false);
    assert.equal(second.ports[port].cached, true);
    assert.equal(providerCalls, 1);
    assert.equal((await post("/api/v1/port-congestion/lookup", { ports: [port] }, tokens[2])).status, 403);
    assert.equal((await post("/api/v1/port-congestion/lookup", { ports: ["ZZZZZ"] }, tokens[0])).status, 403);
    assert.equal(providerCalls, 1);
    assert.equal((await post("/api/v1/tracking/lookup", { mode: "SEA", bol: "UNASSIGNED" }, tokens[0])).status, 403);
    assert.equal((await post(`/api/v1/users/${users[1].id}/tracking-scope`, { trackingOrgs: [] }, tokens[0])).status, 403);
    assert.equal((await post(`/api/v1/users/${users[1].id}/tracking-scope`, { trackingOrgs: ["unknown-org"] }, tokens[4])).status, 400);
    assert.equal((await post(`/api/v1/users/${users[1].id}/tracking-scope`, { trackingOrgs: [] }, tokens[4])).status, 200);
    assert.equal((await (await get("/api/v1/port-congestion/history", tokens[1])).json()).ports.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.freightPulse, settings);
    await new Promise((resolve) => server.close(resolve));
  }
});