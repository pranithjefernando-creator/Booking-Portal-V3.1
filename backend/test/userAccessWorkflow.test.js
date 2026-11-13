import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createUserAccessStore } from "../src/lib/userAccessStore.js";
import { createUserAccessSettingsStore, accessChecks } from "../src/lib/userAccessSettingsStore.js";
import { createUserAuthentication } from "../src/lib/userAuthentication.js";
import { createAccessConfigurationStore } from "../src/lib/accessConfigurationStore.js";

const secret = "workflow-test-only-signing-secret-not-for-production";

function scopedPool(pool, schema, failure) {
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  return {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const result = await client.query(translate(sql), params);
          if (failure?.matches(sql)) throw new Error("simulated database write failure");
          return result;
        },
        release: (error) => client.release(error)
      };
    }
  };
}

test("staged user workflow persists across processes and rolls back database failures", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_workflow_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const failure = { matches: () => false };
  const scoped = scopedPool(pool, schema, failure);
  const users = createUserAccessStore(scoped);
  const settings = createUserAccessSettingsStore(scoped);
  const auth = createUserAuthentication(scoped, { secret });
  const configurations = createAccessConfigurationStore(scoped);
  let created = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await pool.query(ddl);
    created = true;
    await pool.query(`INSERT INTO ${schema}.roles (name) VALUES ('Admin'), ('Data Entry')`);
    await pool.query(`INSERT INTO ${schema}.permissions (code, label) VALUES ('admin.users', 'Users'), ('booking.view', 'Bookings'), ('order.view', 'Orders')`);
    await pool.query(`INSERT INTO ${schema}.modules (code, label) VALUES ('bookings', 'Bookings'), ('orders', 'Orders'), ('tracking', 'Tracking')`);
    await pool.query(`INSERT INTO ${schema}.role_permissions VALUES ('Admin', 'admin.users')`);
    const role = { name: "Workflow role", description: "", permissions: ["booking.view", "order.view"], modules: ["bookings", "orders", "tracking"] };
    await settings.createRole(role);
    const admin = await users.create({ name: "Admin", email: "admin@example.invalid", role: "Admin" });
    const user = await users.create({ name: "User", email: "user@example.invalid", role: role.name });
    const salt = randomBytes(16);
    await pool.query(`INSERT INTO ${schema}.user_credentials (user_id, password_salt, password_hash, session_version, must_change, failed_attempts, locked_until) VALUES ($1, $2, $3, $4, false, 0, 0)`, [admin.id, salt, scryptSync("Test-Admin-Password1", salt, 64), randomUUID()]);
    const adminLogin = await auth.login(admin.email, "Test-Admin-Password1");
    assert.equal(adminLogin.status, "ok");
    const issued = await auth.resetPassword(adminLogin.token, user.id);
    assert.equal(issued.status, "ok");
    const first = await auth.login(user.email, issued.temporaryPassword);
    assert.equal(first.mustChangePassword, true);
    assert.equal((await auth.changePassword(first.token, issued.temporaryPassword, "Test-User-Password1")).status, "ok");
    assert.equal(await auth.authenticate(first.token), null);
    const login = await auth.login(user.email, "Test-User-Password1");
    assert.equal(login.status, "ok");
    await settings.setScopes(user.id, { bookingOrgs: ["BOOK"], orderOrgs: ["ORDER"], trackingOrgs: ["TRACK"] });
    await settings.setModules(user.id, ["bookings", "tracking"]);
    const config = await configurations.createRule({ name: "Approval", rules: [{ name: "Air", conditions: [{ field: "mode", operator: "eq", value: "Air" }] }] });
    const profile = await configurations.createProfile({ name: "Compact", module: "booking", hiddenFields: ["notes"] });
    await configurations.setAssignments(user.id, { ruleConfigurationId: config.id, bookingVisibilityProfileId: profile.id });
    let checks = accessChecks(await settings.getAccess(user.id));
    assert.equal(checks.hasPermission("booking.view"), true);
    assert.deepEqual(checks.modules, ["bookings", "tracking"]);
    assert.equal(checks.canSeeBooking({ cwOrgCode: "BOOK" }), true);
    assert.equal(checks.canSeeBooking({ cwOrgCode: "OTHER" }), false);
    assert.equal(checks.canSeeOrder({ buyerCode: "ORDER" }), true);
    assert.equal(checks.canSeeOrder({ buyerCode: "OTHER" }), false);
    assert.equal(checks.canSeeTracking({ "CW Org Code": "TRACK" }), true);
    assert.equal(checks.canSeeTracking({ "CW Org Code": "OTHER" }), false);
    assert.deepEqual(await configurations.evaluateUserApproval(user.id, { mode: "Air" }), ["Air"]);
    await settings.updateRole({ ...role, permissions: ["order.view"], modules: ["orders", "tracking"] });
    checks = accessChecks(await settings.getAccess(user.id));
    assert.equal(checks.hasPermission("booking.view"), false);
    assert.deepEqual(checks.modules, ["tracking"]);

    failure.matches = (sql) => sql.includes("DELETE FROM portal_access_v1.user_organization_scopes");
    await assert.rejects(settings.setScopes(user.id, { bookingOrgs: ["OTHER"] }), /simulated database write failure/);
    failure.matches = () => false;
    assert.deepEqual((await settings.getAccess(user.id)).user.bookingOrgs, ["BOOK"]);
    failure.matches = (sql) => sql.includes("UPDATE portal_access_v1.user_credentials SET password_salt");
    await assert.rejects(auth.changePassword(login.token, "Test-User-Password1", "Test-Changed-Password2"), /simulated database write failure/);
    failure.matches = () => false;
    assert.ok(await auth.authenticate(login.token));
    assert.equal((await auth.login(user.email, "Test-User-Password1")).status, "ok");
    assert.equal((await auth.login(user.email, "Test-Changed-Password2")).status, "invalid");

    const deadPool = createBookingPool();
    await deadPool.end();
    const dead = scopedPool(deadPool, schema);
    await assert.rejects(createUserAccessSettingsStore(dead).getAccess(user.id), /pool/i);
    await assert.rejects(createUserAuthentication(dead, { secret }).authenticate(login.token), /pool/i);
    await assert.rejects(createUserAuthentication(dead, { secret }).login(user.email, "Test-User-Password1"), /pool/i);
    assert.ok(await auth.authenticate(login.token));

    const script = `
      import {createBookingPool} from './backend/src/lib/bookingStore.js';
      import {createUserAuthentication} from './backend/src/lib/userAuthentication.js';
      import {createUserAccessSettingsStore,accessChecks} from './backend/src/lib/userAccessSettingsStore.js';
      import {createAccessConfigurationStore} from './backend/src/lib/accessConfigurationStore.js';
      const pool=createBookingPool(), schema=process.argv[1], id=process.argv[2];
      const scoped={query:(sql,p)=>pool.query(sql.replaceAll('portal_access_v1.',schema+'.'),p),
        async connect(){const c=await pool.connect();return {query:(sql,p)=>c.query(sql.replaceAll('portal_access_v1.',schema+'.'),p),release:e=>c.release(e)}}};
      try {const session=await createUserAuthentication(scoped,{secret:process.env.WORKFLOW_SECRET}).authenticate(process.env.WORKFLOW_TOKEN);
        const snapshot=await createUserAccessSettingsStore(scoped).getAccess(id), checks=accessChecks(snapshot);
        const config=await createAccessConfigurationStore(scoped).getUserConfiguration(id);
        console.log(JSON.stringify({session,booking:checks.canSeeBooking({cwOrgCode:'BOOK'}),other:checks.canSeeBooking({cwOrgCode:'OTHER'}),modules:checks.modules,config}));}
      finally {await pool.end()}
    `;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, schema, user.id], { env: { ...process.env, WORKFLOW_SECRET: secret, WORKFLOW_TOKEN: login.token } });
    const restored = JSON.parse(child.stdout);
    assert.equal(restored.session.user.id, user.id);
    assert.equal(restored.booking, true);
    assert.equal(restored.other, false);
    assert.deepEqual(restored.modules, ["tracking"]);
    assert.equal(restored.config.assignments.ruleConfigurationId, config.id);
    assert.deepEqual(restored.config.fieldVisibility.booking, ["notes"]);

    await assert.rejects(users.delete(admin.id), { code: "LAST_ADMIN" });
    const second = await users.create({ name: "Second admin", email: "admin2@example.invalid", role: "Admin" });
    const results = await Promise.allSettled([users.delete(admin.id), users.delete(second.id)]);
    assert.equal(results.filter((item) => item.status === "fulfilled" && item.value).length, 1);
    assert.equal(results.find((item) => item.status === "rejected").reason.code, "LAST_ADMIN");
    assert.equal(await users.delete(user.id), true);
    assert.equal(await auth.authenticate(login.token), null);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
