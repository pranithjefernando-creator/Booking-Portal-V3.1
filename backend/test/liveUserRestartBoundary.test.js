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
import { bootstrapUserAccess } from "../src/lib/userAccessBootstrap.js";

test("live PostgreSQL access controls workflows across changes and restarts", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_session_${randomUUID().replaceAll("-", "")}`;
  const bookingSchema = `booking_session_${randomUUID().replaceAll("-", "")}`;
  const unavailableSchema = `${schema}_unavailable`;
  const unavailableBookingSchema = `${bookingSchema}_unavailable`;
  const pool = createBookingPool();
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  const scoped = {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
    }
  };
  const secret = "restart-test-only-secret-at-least-32-bytes";
  const email = "admin@example.invalid";
  const initialPassword = "Initial-Password1";
  let created = false;
  let bookingCreated = false;
  let renamed = false;
  let bookingRenamed = false;
  let child;
  const bookingIds = [];
  const bookingReferences = [];
  let errors = "";
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const base = `http://127.0.0.1:${port}`;
  const cwd = fileURLToPath(new URL("..", import.meta.url));

  async function start() {
    errors = "";
    child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/postgresSessionLoader.js", import.meta.url).href, "server.js"], {
      cwd, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PORT: String(port), AUTH_SECRET: secret, AUTH_TOKEN_TTL_HOURS: "8", TEST_ACCESS_SCHEMA: schema, TEST_BOOKING_SCHEMA: bookingSchema, TRACKING_DB_PASSWORD: "", ORDER_DB_PASSWORD: "", ORG_DB_PASSWORD: "", CW_MODE: "mock", PANVAYA_CACHE_ACCOUNT: "test-account", PANVAYA_CACHE_ENVIRONMENT: "test", FREIGHTPULSE_MODE: "mock", NODE_ENV: "production" }
    });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Backend exited: ${errors}`);
      try { if ((await fetch(`${base}/api/ready`)).ok) return; } catch { }
      await sleep(100);
    }
    throw new Error(`Backend did not become ready: ${errors}`);
  }
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const done = once(child, "exit");
      child.kill();
      await done;
    }
    child = undefined;
  }
  const request = (path, method, body, token, role) => fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(role ? { "x-user-role": role } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const login = async (password) => request("/api/auth/login", "POST", { email, password });
  try {
    await pool.query((await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema));
    created = true;
    await pool.query((await readFile(new URL("../sql/booking-v4.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", bookingSchema));
    bookingCreated = true;
    const admin = await bootstrapUserAccess(scoped, { name: "Test administrator", email, password: initialPassword });
    const storedCredential = (await pool.query(`SELECT password_salt, password_hash FROM ${schema}.user_credentials WHERE user_id = $1`, [admin.id])).rows[0];
    assert.equal(storedCredential.password_salt.length, 16);
    assert.equal(storedCredential.password_hash.length, 64);
    assert.notEqual(storedCredential.password_hash.toString("utf8"), initialPassword);
    await start();
    assert.equal((await request("/api/v1/bookings", "GET")).status, 401);
    assert.equal((await request("/api/v1/audit-logs", "GET")).status, 401);
    assert.equal((await request("/api/v1/me", "GET", undefined, "invalid-token")).status, 401);
    assert.equal((await request("/api/auth/login", "POST", { email: "pranithf@efl.example", password: "Initial-Password1" })).status, 401);
    assert.equal((await login("Wrong-Password1")).status, 401);
    const first = await (await login(initialPassword)).json();
    assert.equal(first.mustChangePassword, true);
    const me = await (await request("/api/v1/me", "GET", undefined, first.token)).json();
    assert.equal(me.user.id, admin.id);
    assert.equal(me.mustChangePassword, true);
    assert.ok(me.permissions.includes("admin.users"));
    assert.equal((await request("/api/v1/bookings", "GET", undefined, first.token)).status, 403);
    assert.equal((await request("/api/v1/users", "POST", {}, first.token)).status, 403);
    const changed = await request("/api/v1/auth/change-password", "POST", { currentPassword: initialPassword, newPassword: "Updated-Password1" }, first.token);
    assert.equal(changed.status, 200);
    assert.deepEqual(await changed.json(), { ok: true, reauthenticate: true });
    assert.equal((await request("/api/v1/me", "GET", undefined, first.token)).status, 401);
    assert.equal((await login(initialPassword)).status, 401);
    const current = await (await login("Updated-Password1")).json();
    assert.equal(current.mustChangePassword, false);
    for (const path of ["/api/v1/bookings", "/api/v1/orders", "/api/v1/tracking/shipments"]) {
      assert.equal((await request(path, "GET", undefined, current.token)).status, 200);
    }
    for (const code of ["TESTCO", "LRG"]) {
      const response = await request("/api/v1/bookings", "POST", { cwOrgCode: code, goodsDescription: `access-test-${randomUUID()}` }, current.token);
      assert.equal(response.status, 201);
      const booking = await response.json();
      bookingIds.push(booking.id);
      bookingReferences.push(booking.reference);
    }
    const auditResponse = await request("/api/v1/audit-logs", "GET", undefined, current.token);
    assert.equal(auditResponse.status, 200);
    const createdAudit = await auditResponse.json();
    for (const reference of bookingReferences) {
      assert.ok(createdAudit.items.some((event) => event.action === "CREATE" && event.entityId === reference && event.actorName === "Test administrator"));
    }
    assert.equal((await request("/api/v1/audit-logs", "GET", undefined, current.token, "Data Entry")).status, 403);
    const auditRole = { name: "Audit test role", description: "Test audit access", permissions: [], modules: ["audit"] };
    assert.equal((await request("/api/v1/roles", "POST", auditRole, current.token)).status, 201);
    assert.equal((await request("/api/v1/audit-logs", "GET", undefined, current.token, auditRole.name)).status, 403);
    assert.equal((await request("/api/v1/roles/Audit%20test%20role", "PUT", { ...auditRole, permissions: ["audit.view"], modules: [] }, current.token)).status, 200);
    assert.equal((await request("/api/v1/audit-logs", "GET", undefined, current.token, auditRole.name)).status, 403);
    assert.equal((await request("/api/v1/roles/Audit%20test%20role", "PUT", { ...auditRole, permissions: ["audit.view"] }, current.token)).status, 200);
    assert.equal((await request("/api/v1/audit-logs", "GET", undefined, current.token, auditRole.name)).status, 200);
    assert.equal((await request("/api/v1/roles/Audit%20test%20role", "DELETE", undefined, current.token)).status, 200);
    assert.equal((await request("/api/v1/users", "GET", undefined, current.token)).status, 200);
    assert.equal((await request("/api/v1/users", "GET", undefined, current.token, "Data Entry")).status, 403);
    assert.equal((await request("/api/v1/bookings", "GET", undefined, current.token, "Missing preview role")).status, 403);
    assert.equal((await request("/api/v1/users", "POST", { name: "Denied", email: "denied@example.invalid" }, current.token, "Data Entry")).status, 403);
    assert.equal((await request(`/api/v1/users/${admin.id}`, "DELETE", undefined, current.token)).status, 409);
    assert.equal((await request(`/api/v1/users/${admin.id}`, "PUT", { role: "Data Entry" }, current.token)).status, 409);
    assert.equal((await request("/api/v1/users/not-a-uuid", "GET", undefined, current.token)).status, 400);
    const newUserResponse = await request("/api/v1/users", "POST", { name: "Original user", email: "user@example.invalid", role: "Data Entry" }, current.token);
    assert.equal(newUserResponse.status, 201);
    const createdUser = await newUserResponse.json();
    assert.ok(createdUser.initialPassword);
    const defaultRules = await (await request("/api/v1/rule-configurations", "GET", undefined, current.token)).json();
    assert.equal(createdUser.ruleConfigurationId, defaultRules.items[0].id);
    assert.equal((await request(`/api/v1/rule-configurations/${createdUser.ruleConfigurationId}`, "DELETE", undefined, current.token)).status, 409);
    const configurationResponse = await request("/api/v1/rule-configurations", "POST", { name: "Heavy", rules: [{ name: "Heavy", conditions: [{ field: "cargoLines.totalGrossWeightKg", operator: "gt", value: 10000 }] }] }, current.token);
    assert.equal(configurationResponse.status, 201);
    const configuration = await configurationResponse.json();
    const profileResponse = await request("/api/v1/field-visibility-profiles", "POST", { name: "Hidden", module: "booking", hiddenFields: ["notes"] }, current.token);
    assert.equal(profileResponse.status, 201);
    const profile = await profileResponse.json();
    assert.equal((await request(`/api/v1/users/${createdUser.id}`, "PUT", { ruleConfigurationId: configuration.id, bookingVisibilityProfileId: profile.id }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/rule-configuration`, "POST", { ruleConfigurationId: randomUUID() }, current.token)).status, 400);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/rule-configuration`, "POST", { ruleConfigurationId: configuration.id }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/field-visibility-profiles/${profile.id}`, "DELETE", undefined, current.token)).status, 409);
    assert.equal((await request(`/api/v1/rule-configurations/${configuration.id}`, "DELETE", undefined, current.token)).status, 409);
    const role = { name: "Test role", description: "Test", permissions: ["booking.view", "booking.create", "booking.validate", "booking.approve", "order.view"], modules: ["bookings", "tracking", "orders", "create", "approvals"] };
    assert.equal((await request("/api/v1/roles", "POST", role, current.token, "Data Entry")).status, 403);
    assert.equal((await request("/api/v1/roles", "POST", { ...role, name: "Invalid", modules: ["unknown"] }, current.token)).status, 400);
    assert.equal((await request("/api/v1/roles", "POST", role, current.token)).status, 201);
    assert.equal((await request("/api/v1/roles", "POST", role, current.token)).status, 409);
    assert.equal((await request("/api/v1/roles/Admin", "DELETE", undefined, current.token)).status, 409);
    assert.equal((await request(`/api/v1/users/${createdUser.id}`, "PUT", { role: role.name }, current.token)).status, 200);
    assert.equal((await request("/api/v1/roles/Test%20role", "DELETE", undefined, current.token)).status, 409);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-scope`, "POST", { bookingOrgs: ["TESTCO", "ACME"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-partners`, "POST", { shipperOrgs: ["ACME"], consigneeOrgs: ["TESTCO"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/order-scope`, "POST", { orderOrgs: ["ACME"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/tracking-scope`, "POST", { trackingOrgs: ["TESTCO"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/order-partners`, "POST", { supplierOrgs: ["ACME"], buyerOrgs: ["ACME"] }, current.token)).status, 200);
    assert.equal((await request("/api/v1/orgs/search?kind=cw&q=TESTCO", "GET", undefined, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-scope`, "POST", { bookingOrgs: ["UNKNOWN"] }, current.token)).status, 400);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-partners`, "POST", { shipperOrgs: ["LRG"], consigneeOrgs: [] }, current.token)).status, 400);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: ["tracking", "bookings"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: ["unknown"] }, current.token)).status, 400);
    assert.equal((await request("/api/v1/users", "POST", { name: "Duplicate", email: "USER@example.invalid" }, current.token)).status, 409);
    assert.equal((await request("/api/v1/users", "POST", { name: "Bad role", email: "bad@example.invalid", role: "Unknown" }, current.token)).status, 400);
    assert.equal((await request("/api/v1/users", "POST", { name: "Bad input", email: "bad@example.invalid", extra: true }, current.token)).status, 400);
    assert.equal((await request("/api/v1/users", "POST", { name: "Invalid assignment", email: "rollback@example.invalid", ruleConfigurationId: randomUUID() }, current.token)).status, 400);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.users WHERE email = 'rollback@example.invalid'`)).rows[0].count, 0);
    assert.equal((await request(`/api/v1/users/${createdUser.id}`, "PUT", { name: "Rollback", bookingVisibilityProfileId: randomUUID() }, current.token)).status, 400);
    assert.equal((await (await request(`/api/v1/users/${createdUser.id}`, "GET", undefined, current.token)).json()).user.name, "Original user");
    assert.equal((await request(`/api/v1/users/${randomUUID()}/reset-password`, "POST", {}, current.token)).status, 404);
    const edit = await request(`/api/v1/users/${createdUser.id}`, "PUT", { name: "Edited user", email: "edited@example.invalid" }, current.token);
    assert.equal(edit.status, 200);
    const initialUserLogin = await (await request("/api/auth/login", "POST", { email: "edited@example.invalid", password: createdUser.initialPassword })).json();
    assert.equal(initialUserLogin.mustChangePassword, true);
    assert.equal((await request("/api/v1/users", "GET", undefined, initialUserLogin.token)).status, 403);
    const changeUser = await request("/api/v1/auth/change-password", "POST", { currentPassword: createdUser.initialPassword, newPassword: "User-Password1" }, initialUserLogin.token);
    assert.equal(changeUser.status, 200);
    const userLogin = await (await request("/api/auth/login", "POST", { email: "edited@example.invalid", password: "User-Password1" })).json();
    assert.equal((await request("/api/v1/users", "GET", undefined, userLogin.token)).status, 403);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: [] }, userLogin.token)).status, 403);
    let userMe = await (await request("/api/v1/me", "GET", undefined, userLogin.token)).json();
    assert.deepEqual(userMe.fieldVisibility.booking, ["notes"]);
    assert.deepEqual(userMe.user.bookingOrgs, ["TESTCO", "ACME"]);
    assert.deepEqual(userMe.user.trackingOrgs, ["TESTCO"]);
    assert.deepEqual(userMe.modules, ["bookings", "tracking"]);
    assert.equal((await request(`/api/v1/bookings/${bookingIds[0]}`, "GET", undefined, userLogin.token)).status, 200);
    assert.equal((await request(`/api/v1/bookings/${bookingIds[1]}`, "GET", undefined, userLogin.token)).status, 403);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-scope`, "POST", { bookingOrgs: ["LRG"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/bookings/${bookingIds[0]}`, "GET", undefined, userLogin.token)).status, 403);
    assert.equal((await request(`/api/v1/bookings/${bookingIds[1]}`, "GET", undefined, userLogin.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-scope`, "POST", { bookingOrgs: ["TESTCO", "ACME"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/booking-partners`, "POST", { shipperOrgs: ["ACME"], consigneeOrgs: ["TESTCO"] }, current.token)).status, 200);
    assert.equal((await request("/api/v1/orders", "GET", undefined, userLogin.token)).status, 403);
    const tracking = await request("/api/v1/tracking/shipments", "GET", undefined, userLogin.token);
    assert.equal(tracking.status, 200);
    assert.deepEqual((await tracking.json()).records.map((record) => record["Shipment ID"]), ["TEST-ALLOWED"]);
    assert.equal((await request("/api/v1/tracking/lookup", "POST", { mode: "SEA", bol: "DENIED-BL" }, userLogin.token)).status, 403);
    const lookup = await request("/api/v1/tracking/lookup", "POST", { mode: "SEA", bol: "ALLOWED-BL" }, userLogin.token);
    assert.equal(lookup.status, 200);
    const trackingResult = await lookup.json();
    assert.equal(trackingResult.data.containers[0].container_number, "TESTU1234567");
    assert.equal(trackingResult.cached, false);
    const portLookup = await request("/api/v1/port-congestion/lookup", "POST", { ports: ["LKCMB"] }, userLogin.token);
    assert.equal(portLookup.status, 200);
    assert.equal((await portLookup.json()).ports.LKCMB.cached, false);
    assert.deepEqual((await (await request("/api/v1/port-congestion/history", "GET", undefined, userLogin.token)).json()).ports.sort(), ["AEDXB", "LKCMB"]);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/tracking-scope`, "POST", { trackingOrgs: [] }, current.token)).status, 200);
    assert.deepEqual((await (await request("/api/v1/tracking/shipments", "GET", undefined, userLogin.token)).json()).records, []);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/tracking-scope`, "POST", { trackingOrgs: ["TESTCO"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: ["bookings", "orders"] }, current.token)).status, 200);
    assert.equal((await request("/api/v1/tracking/shipments", "GET", undefined, userLogin.token)).status, 403);
    const scopedOrders = await (await request("/api/v1/orders", "GET", undefined, userLogin.token)).json();
    assert.ok(scopedOrders.items.every((order) => order.cwOrgCode === "ACME" || order.buyerCode === "ACME"));
    const orderRole = { ...role, permissions: [...role.permissions, "order.create", "order.import"] };
    assert.equal((await request("/api/v1/roles/Test%20role", "PUT", orderRole, current.token)).status, 200);
    const order = { orderNo: `access-${randomUUID()}`, orderDate: "2027-01-01", transportMode: "Air", supplierCode: "ACME", buyerCode: "LRG" };
    const savedOrder = await request("/api/v1/orders", "POST", order, userLogin.token);
    assert.equal(savedOrder.status, 201);
    const orderId = (await savedOrder.json()).id;
    assert.equal((await request(`/api/v1/orders/${orderId}`, "PUT", { supplierCode: "LRG", cwOrgCode: "LRG" }, userLogin.token)).status, 403);
    assert.equal((await request("/api/v1/orders", "POST", { ...order, supplierCode: "LRG" }, userLogin.token)).status, 403);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/order-scope`, "POST", { orderOrgs: [] }, current.token)).status, 200);
    assert.equal((await request("/api/v1/orders", "POST", order, userLogin.token)).status, 403);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/order-scope`, "POST", { orderOrgs: ["ACME"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/order-partners`, "POST", { supplierOrgs: ["ACME"], buyerOrgs: ["ACME"] }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/orders/${orderId}`, "GET", undefined, userLogin.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: ["bookings", "orders", "create", "approvals"] }, current.token)).status, 200);
    const heavy = await request("/api/v1/bookings", "POST", {
      shipperCode: "TESTCO", consigneeCode: "ACME", mode: "Ocean FCL", incotermCode: "FOB",
      cargoReadyDate: "2027-01-01", goodsDescription: "Isolated approval", cargoLines: [{ packages: 1, grossWeight: 12000, weightUnit: "KGS" }]
    }, userLogin.token);
    assert.equal(heavy.status, 201);
    const heavyId = (await heavy.json()).id;
    const validation = await request(`/api/v1/bookings/${heavyId}/validate`, "POST", {}, userLogin.token);
    assert.equal(validation.status, 200);
    assert.deepEqual((await validation.json()).requiresApproval, ["Heavy"]);
    assert.equal((await request(`/api/v1/orders/${orderId}/link-booking`, "POST", { bookingId: heavyId }, userLogin.token)).status, 200);
    assert.equal((await request(`/api/v1/bookings/${heavyId}/submit-approval`, "POST", {}, userLogin.token)).status, 200);
    const pending = await (await request(`/api/v1/bookings/${heavyId}`, "GET", undefined, userLogin.token)).json();
    assert.equal(pending.pendingApproval.status, "PENDING");
    assert.equal(pending.linkedOrders[0].id, orderId);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/rule-configuration`, "POST", { ruleConfigurationId: "" }, current.token)).status, 200);
    const noRules = await request("/api/v1/bookings", "POST", {
      shipperCode: "TESTCO", consigneeCode: "ACME", mode: "Ocean FCL", incotermCode: "FOB",
      cargoReadyDate: "2027-01-01", goodsDescription: "No approval assignment", cargoLines: [{ packages: 1, grossWeight: 12000, weightUnit: "KGS" }]
    }, userLogin.token);
    assert.equal(noRules.status, 201);
    const noRulesId = (await noRules.json()).id;
    const noRulesValidation = await request(`/api/v1/bookings/${noRulesId}/validate`, "POST", {}, userLogin.token);
    assert.equal(noRulesValidation.status, 200);
    assert.equal((await noRulesValidation.json()).requiresApproval, null);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/rule-configuration`, "POST", { ruleConfigurationId: configuration.id }, current.token)).status, 200);
    assert.equal((await request("/api/v1/roles/Test%20role", "PUT", role, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: [] }, current.token)).status, 200);
    const updatedRole = { ...role, permissions: ["admin.users"], modules: ["orders"] };
    assert.equal((await request("/api/v1/roles/Test%20role", "PUT", updatedRole, current.token)).status, 200);
    userMe = await (await request("/api/v1/me", "GET", undefined, userLogin.token)).json();
    assert.deepEqual(userMe.permissions, ["admin.users"]);
    assert.deepEqual(userMe.modules, []);
    assert.equal((await request("/api/v1/bookings", "GET", undefined, userLogin.token)).status, 403);
    assert.equal((await request("/api/v1/orders", "GET", undefined, userLogin.token)).status, 403);
    assert.equal((await request("/api/v1/users", "GET", undefined, userLogin.token)).status, 200);
    assert.equal((await request("/api/v1/roles/Test%20role", "PUT", role, current.token)).status, 200);
    assert.equal((await request("/api/v1/users", "GET", undefined, userLogin.token)).status, 403);
    assert.equal((await request(`/api/v1/users/${createdUser.id}/modules`, "POST", { modules: null }, current.token)).status, 200);
    assert.equal((await request(`/api/v1/users/${admin.id}`, "DELETE", undefined, userLogin.token)).status, 403);
    await pool.query(`ALTER SCHEMA ${bookingSchema} RENAME TO ${unavailableBookingSchema}`);
    bookingRenamed = true;
    assert.equal((await request("/api/ready", "GET")).status, 503);
    assert.equal((await request("/api/v1/bookings", "GET", undefined, current.token)).status, 500);
    assert.equal((await request("/api/v1/audit-logs", "GET", undefined, current.token)).status, 500);
    const failedTracking = await request("/api/v1/tracking/lookup", "POST", { mode: "SEA", bol: "ALLOWED-BL" }, userLogin.token);
    assert.equal(failedTracking.status, 503);
    assert.equal((await failedTracking.json()).code, "PROVIDER_CACHE_UNAVAILABLE");
    assert.equal((await request("/api/v1/port-congestion/lookup", "POST", { ports: ["LKCMB"] }, userLogin.token)).status, 503);
    assert.equal((await request("/api/v1/port-congestion/status", "GET", undefined, userLogin.token)).status, 503);
    await pool.query(`ALTER SCHEMA ${unavailableBookingSchema} RENAME TO ${bookingSchema}`);
    bookingRenamed = false;
    assert.equal((await request("/api/ready", "GET")).status, 200);
    await stop();
    await start();
    const cachedTracking = await request("/api/v1/tracking/lookup", "POST", { mode: "SEA", bol: "ALLOWED-BL" }, userLogin.token);
    assert.equal(cachedTracking.status, 200);
    assert.equal((await cachedTracking.json()).cached, true);
    const cachedPort = await request("/api/v1/port-congestion/lookup", "POST", { ports: ["LKCMB"] }, userLogin.token);
    assert.equal(cachedPort.status, 200);
    assert.equal((await cachedPort.json()).ports.LKCMB.cached, true);
    assert.equal((await request("/api/v1/me", "GET", undefined, current.token)).status, 200);
    const afterRestartAudit = await (await request("/api/v1/audit-logs", "GET", undefined, current.token)).json();
    for (const event of createdAudit.items) assert.ok(afterRestartAudit.items.some((persisted) => persisted.id === event.id && persisted.action === event.action && persisted.entityId === event.entityId));
    assert.equal((await request(`/api/v1/bookings/${bookingIds[0]}`, "GET", undefined, userLogin.token)).status, 200);
    assert.equal((await request(`/api/v1/bookings/${bookingIds[1]}`, "GET", undefined, userLogin.token)).status, 403);
    const afterRestart = await (await request(`/api/v1/bookings/${heavyId}`, "GET", undefined, userLogin.token)).json();
    assert.equal(afterRestart.status, "PENDING_APPROVAL");
    assert.equal(afterRestart.pendingApproval.id, pending.pendingApproval.id);
    assert.equal((await request(`/api/v1/orders/${orderId}`, "GET", undefined, userLogin.token)).status, 404);
    const savedLink = await pool.query(`SELECT booking_id FROM ${bookingSchema}.order_links WHERE order_id = $1`, [orderId]);
    assert.equal(savedLink.rows[0].booking_id, heavyId);
    assert.equal((await request(`/api/v1/approvals/${pending.pendingApproval.id}/approve`, "POST", {}, userLogin.token)).status, 200);
    assert.equal((await (await request(`/api/v1/bookings/${heavyId}`, "GET", undefined, userLogin.token)).json()).status, "APPROVED");
    const saved = await (await request(`/api/v1/users/${createdUser.id}`, "GET", undefined, current.token)).json();
    assert.equal(saved.user.name, "Edited user");
    assert.equal(saved.user.email, "edited@example.invalid");
    assert.deepEqual(saved.user.bookingOrgs, ["TESTCO", "ACME"]);
    assert.deepEqual(saved.user.bookingShipperOrgs, ["ACME"]);
    assert.deepEqual(saved.user.orderOrgs, ["ACME"]);
    assert.deepEqual(saved.user.orderSupplierOrgs, ["ACME"]);
    assert.equal(saved.user.ruleConfigurationId, configuration.id);
    assert.equal(saved.user.bookingVisibilityProfileId, profile.id);
    assert.equal(saved.user.modulesConfigured, false);
    const resetUser = await request(`/api/v1/users/${createdUser.id}/reset-password`, "POST", {}, current.token);
    assert.equal(resetUser.status, 200);
    const temporaryPassword = (await resetUser.json()).initialPassword;
    assert.equal((await request("/api/v1/me", "GET", undefined, userLogin.token)).status, 401);
    assert.equal((await request("/api/auth/login", "POST", { email: "edited@example.invalid", password: "User-Password1" })).status, 401);
    const afterReset = await (await request("/api/auth/login", "POST", { email: "edited@example.invalid", password: temporaryPassword })).json();
    assert.equal(afterReset.mustChangePassword, true);
    assert.equal((await request(`/api/v1/users/${createdUser.id}`, "DELETE", undefined, current.token)).status, 200);
    assert.equal((await request(`/api/v1/rule-configurations/${configuration.id}`, "DELETE", undefined, current.token)).status, 200);
    assert.equal((await request(`/api/v1/field-visibility-profiles/${profile.id}`, "DELETE", undefined, current.token)).status, 200);
    assert.equal((await request("/api/v1/roles/Test%20role", "DELETE", undefined, current.token)).status, 200);
    assert.equal((await request("/api/v1/me", "GET", undefined, afterReset.token)).status, 401);
    assert.equal((await request(`/api/v1/users/${createdUser.id}`, "GET", undefined, current.token)).status, 404);
    const resetResponse = await request(`/api/v1/users/${admin.id}/reset-password`, "POST", {}, current.token);
    assert.equal(resetResponse.status, 200);
    const reset = await resetResponse.json();
    assert.equal((await request("/api/v1/me", "GET", undefined, current.token)).status, 401);
    const resetLogin = await (await login(reset.initialPassword)).json();
    assert.equal(resetLogin.mustChangePassword, true);
    assert.equal((await request("/api/v1/orders", "GET", undefined, resetLogin.token)).status, 403);
    await pool.query(`ALTER SCHEMA ${schema} RENAME TO ${unavailableSchema}`);
    renamed = true;
    assert.equal((await login(reset.initialPassword)).status, 503);
    assert.equal((await request("/api/v1/me", "GET", undefined, resetLogin.token)).status, 503);
    assert.equal((await request("/api/v1/bookings", "GET", undefined, resetLogin.token)).status, 503);
    assert.equal((await request("/api/ready", "GET")).status, 503);
    await pool.query(`ALTER SCHEMA ${unavailableSchema} RENAME TO ${schema}`);
    renamed = false;
    assert.equal((await request("/api/v1/me", "GET", undefined, resetLogin.token)).status, 200);
  } finally {
    try {
      await stop();
      if (renamed) await pool.query(`ALTER SCHEMA ${unavailableSchema} RENAME TO ${schema}`);
      if (bookingRenamed) await pool.query(`ALTER SCHEMA ${unavailableBookingSchema} RENAME TO ${bookingSchema}`);
      if (bookingCreated) await pool.query(`DROP SCHEMA ${bookingSchema} CASCADE`);
      if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally { await pool.end(); }
  }
});
