import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createUserAccessStore } from "../src/lib/userAccessStore.js";
import { accessChecks, createUserAccessSettingsStore } from "../src/lib/userAccessSettingsStore.js";
import { defaultBookingOrg, defaultOrderOrg } from "../src/db.js";

const execFileAsync = promisify(execFile);

test("saved roles, modules and scopes round-trip and drive staged access checks", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_settings_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  const scoped = {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
    }
  };
  const settings = createUserAccessSettingsStore(scoped);
  const users = createUserAccessStore(scoped);
  let created = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await pool.query(ddl);
    created = true;
    await settings.initializeCatalogs();
    const defaultRole = (await settings.listRoles()).find((role) => role.name === "Data Entry");
    assert.ok(defaultRole.permissions.includes("booking.view"));
    assert.ok(defaultRole.modules.includes("tracking"));
    const role = { name: "Test role", description: "Test", permissions: ["booking.view", "order.view"], modules: ["tracking", "orders", "bookings"] };
    assert.deepEqual(await settings.createRole(role), { ...role, builtin: false, permissions: ["booking.view", "order.view"] });
    const user = await users.create({ name: "Test user", email: "test@example.invalid", role: role.name });
    let snapshot = await settings.getAccess(user.id);
    assert.deepEqual(snapshot.user.modules, []);
    assert.equal(snapshot.user.modulesConfigured, false);
    assert.deepEqual(accessChecks(snapshot).modules, role.modules);
    assert.equal(accessChecks(snapshot).hasPermission("booking.view"), true);
    assert.equal(accessChecks(snapshot).hasPermission("booking.approve"), false);
    assert.equal(accessChecks(snapshot).canSeeBooking({ cwOrgCode: "ANY" }), true);
    assert.equal(accessChecks(snapshot).canSeeOrder({ cwOrgCode: "ANY" }), true);
    assert.equal(accessChecks(snapshot).canCreateOrder(), false);
    assert.equal(accessChecks(snapshot).canSeeTracking({ "CW Org Code": "ANY" }), false);

    snapshot = await settings.setScopes(user.id, {
      bookingOrgs: ["BOOK2", "BOOK1"], bookingShipperOrgs: ["BOOK1"], bookingConsigneeOrgs: ["BOOK2"],
      orderOrgs: ["ORDER2", "ORDER1"], orderSupplierOrgs: ["ORDER1"], orderBuyerOrgs: ["ORDER2"], trackingOrgs: ["TRACK1"]
    });
    assert.equal(defaultBookingOrg(snapshot.user), "BOOK2");
    assert.equal(defaultOrderOrg(snapshot.user), "ORDER2");
    assert.equal(accessChecks(snapshot).canSeeBooking({ cwOrgCode: "BOOK1" }), true);
    assert.equal(accessChecks(snapshot).canSeeBooking({ cwOrgCode: "OTHER" }), false);
    assert.equal(accessChecks(snapshot).canSeeOrder({ buyerCode: "ORDER1" }), true);
    assert.equal(accessChecks(snapshot).canSeeOrder({ buyerCode: "OTHER" }), false);
    assert.equal(accessChecks(snapshot).canCreateOrder(), true);
    assert.equal(accessChecks(snapshot).canSeeTracking({ "CW Org Code": "TRACK1" }), true);
    await Promise.all([
      settings.setScopes(user.id, { trackingOrgs: ["TRACK1", "TRACK2"] }),
      settings.setScopes(user.id, { orderBuyerOrgs: ["ORDER1"] })
    ]);
    snapshot = await settings.getAccess(user.id);
    assert.deepEqual(snapshot.user.trackingOrgs, ["TRACK1", "TRACK2"]);
    assert.deepEqual(snapshot.user.orderBuyerOrgs, ["ORDER1"]);
    snapshot = await settings.setModules(user.id, ["bookings", "tracking"]);
    assert.deepEqual(accessChecks(snapshot).modules, ["tracking", "bookings"]);
    snapshot = await settings.setModules(user.id, []);
    assert.deepEqual(accessChecks(snapshot).modules, []);
    assert.equal(accessChecks(snapshot).canSeeTracking({ "CW Org Code": "TRACK1" }), false);
    snapshot = await settings.setModules(user.id, null);
    assert.equal(snapshot.user.modulesConfigured, false);
    assert.deepEqual(accessChecks(snapshot).modules, role.modules);

    await assert.rejects(settings.setModules(user.id, ["not-a-module"]), { code: "23503" });
    await assert.rejects(settings.setScopes(user.id, { bookingShipperOrgs: ["OTHER"] }), /within bookingOrgs/);
    await assert.rejects(settings.setScopes(user.id, { trackingOrgs: ["TRACK1", "TRACK1"] }), /duplicates/);
    assert.deepEqual((await settings.getAccess(user.id)).user.trackingOrgs, ["TRACK1", "TRACK2"]);
    snapshot = await settings.setScopes(user.id, { bookingOrgs: ["BOOK1"] });
    assert.deepEqual(snapshot.user.bookingShipperOrgs, ["BOOK1"]);
    assert.deepEqual(snapshot.user.bookingConsigneeOrgs, []);
    snapshot = await settings.setScopes(user.id, { bookingOrgs: [], orderOrgs: [] });
    assert.equal(accessChecks(snapshot).canSeeBooking({ cwOrgCode: "ANY" }), true);
    assert.equal(accessChecks(snapshot).canSeeOrder({ buyerCode: "ANY" }), true);
    assert.equal(accessChecks(snapshot).canCreateOrder(), false);
    assert.deepEqual(snapshot.user.orderBuyerOrgs, []);

    await assert.rejects(settings.updateRole({ ...role, modules: ["invalid"] }), { code: "23503" });
    assert.deepEqual((await settings.getAccess(user.id)).role.modules, role.modules);
    const editedRole = { ...role, permissions: ["booking.approve"], modules: ["bookings"] };
    await settings.updateRole(editedRole);
    await settings.initializeCatalogs();
    snapshot = await settings.getAccess(user.id);
    assert.equal(accessChecks(snapshot).hasPermission("booking.view"), false);
    assert.equal(accessChecks(snapshot).hasPermission("booking.approve"), true);
    assert.deepEqual(accessChecks(snapshot).modules, ["bookings"]);
    await assert.rejects(settings.deleteRole(role.name), { code: "23503" });
    await assert.rejects(settings.updateRole({ ...role, name: "Admin" }), /cannot be changed/);
    await assert.rejects(settings.deleteRole("Admin"), /cannot be deleted/);
    assert.equal(await settings.getAccess(randomUUID()), null);
    assert.equal(await settings.setModules(randomUUID(), []), null);
    assert.equal(await settings.setScopes(randomUUID(), { trackingOrgs: [] }), null);
    assert.throws(() => accessChecks({ user: snapshot.user, role: { ...snapshot.role, name: "Other" } }), /matching user and role/);

    const script = `
      import { createBookingPool } from './backend/src/lib/bookingStore.js';
      import { createUserAccessSettingsStore } from './backend/src/lib/userAccessSettingsStore.js';
      const pool = createBookingPool(); const schema = process.argv[1];
      const scoped = { async connect() { const client = await pool.connect(); return {
        query: (sql, params) => client.query(sql.replaceAll('portal_access_v1.', schema + '.'), params),
        release: (error) => client.release(error) }; } };
      try { console.log(JSON.stringify(await createUserAccessSettingsStore(scoped).getAccess(process.argv[2]))); }
      finally { await pool.end(); }
    `;
    const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, schema, user.id]);
    assert.deepEqual(JSON.parse(child.stdout), snapshot);
    assert.equal(await users.delete(user.id), true);
    assert.equal(await settings.deleteRole(role.name), true);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
