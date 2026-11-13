import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createUserAccessStore } from "../src/lib/userAccessStore.js";
import { createAccessConfigurationStore, DEFAULT_APPROVAL_ID, initializeDefaultApproval } from "../src/lib/accessConfigurationStore.js";
import { userAccessTransaction } from "../src/lib/userAccessStore.js";

test("staged configurations persist, resolve and protect user assignments", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `config_test_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  const scoped = {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
    }
  };
  const store = createAccessConfigurationStore(scoped);
  const users = createUserAccessStore(scoped);
  let created = false;
  try {
    await pool.query((await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema));
    created = true;
    await pool.query(`INSERT INTO ${schema}.roles(name) VALUES ('Data Entry')`);
    const user = await users.create({ name: "Test", email: "test@example.invalid" });
    const other = await users.create({ name: "Other", email: "other@example.invalid" });
    const input = { name: " Heavy cargo ", rules: [{ name: "Heavy", conditions: [{ field: "cargoLines.totalGrossWeightKg", operator: "gt", value: "10000" }] }] };
    await assert.rejects(store.createRule({ name: "Bad", rules: [{ name: "Rule", conditions: [{ field: "unknown", operator: "eq", value: "x" }] }] }), /Invalid condition/);
    await assert.rejects(store.createProfile({ name: "Bad", module: "booking", hiddenFields: ["unknown"] }), /recognized optional/);
    const config = await store.createRule(input);
    const booking = await store.createProfile({ name: "Booking", module: "booking", hiddenFields: ["notes", "notes"] });
    const order = await store.createProfile({ name: "Order", module: "order", hiddenFields: ["orderNoSplit"] });
    assert.deepEqual(booking.hiddenFields, ["notes"]);
    assert.equal(config.rules[0].conditions[0].value, 10000);
    assert.equal((await store.listRules()).length, 1);
    assert.equal((await store.listProfiles()).length, 2);
    await userAccessTransaction(scoped, initializeDefaultApproval);
    const heavyOcean = { mode: "Ocean FCL", cargoLines: [{ grossWeight: 10001, weightUnit: "KGS" }] };
    assert.deepEqual(await store.evaluateBookingApproval(heavyOcean), ["Ocean FCL gross weight > 10,000 KGS"]);
    assert.equal(await store.evaluateBookingApproval({ ...heavyOcean, cargoLines: [{ grossWeight: 10000 }] }), null);
    assert.equal(await store.evaluateBookingApproval({ ...heavyOcean, mode: "Air" }), null);
    assert.deepEqual(await store.evaluateBookingApproval({ ...heavyOcean, cargoLines: [{ grossWeight: 22050, weightUnit: "LBS" }] }), ["Ocean FCL gross weight > 10,000 KGS"]);
    assert.equal(await store.evaluateBookingApproval({ ...heavyOcean, createdByUserId: user.id }), null);
    await assert.rejects(store.deleteRule(DEFAULT_APPROVAL_ID), { code: "DEFAULT_RULE" });
    const savedDefault = (await store.listRules()).find((item) => item.id === DEFAULT_APPROVAL_ID);
    await store.updateRule(DEFAULT_APPROVAL_ID, { ...savedDefault, name: "Edited default" });
    await userAccessTransaction(scoped, initializeDefaultApproval);
    assert.equal((await store.listRules()).find((item) => item.id === DEFAULT_APPROVAL_ID).name, "Edited default");
    assert.equal(await store.setAssignments(user.id, { ruleConfigurationId: config.id, bookingVisibilityProfileId: booking.id, orderVisibilityProfileId: order.id }), true);
    assert.deepEqual(await store.evaluateBookingApproval({ ...heavyOcean, createdByUserId: user.id }), ["Heavy"]);
    assert.deepEqual(await store.evaluateBookingApproval({ ...heavyOcean, createdBy: user.name }), ["Heavy"]);
    await store.setAssignments(other.id, { ruleConfigurationId: config.id, bookingVisibilityProfileId: booking.id });
    await users.delete(other.id);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.user_rule_assignments WHERE user_id = $1`, [other.id])).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.user_visibility_assignments WHERE user_id = $1`, [other.id])).rows[0].count, 0);
    let saved = await store.getUserConfiguration(user.id);
    assert.deepEqual(saved.fieldVisibility, { booking: ["notes"], order: ["orderNoSplit"] });
    assert.deepEqual(await store.evaluateUserApproval(user.id, { cargoLines: [{ grossWeight: 11000, weightUnit: "KGS" }] }), ["Heavy"]);
    assert.equal(await store.evaluateUserApproval(user.id, { cargoLines: [{ grossWeight: 10 }] }), null);
    await assert.rejects(store.deleteRule(config.id), { code: "23503" });
    await assert.rejects(store.deleteProfile(booking.id), { code: "23503" });
    await assert.rejects(store.updateProfile(booking.id, { name: "Move", module: "order", hiddenFields: [] }), { code: "23503" });
    await assert.rejects(store.setAssignments(user.id, { ruleConfigurationId: "", bookingVisibilityProfileId: order.id }), { code: "23503" });
    assert.equal((await store.getUserConfiguration(user.id)).assignments.ruleConfigurationId, config.id);
    const edited = await store.updateRule(config.id, { ...input, enabled: false });
    assert.equal(edited.createdAt, config.createdAt);
    assert.equal(await store.evaluateUserApproval(user.id, { cargoLines: [{ grossWeight: 11000 }] }), null);
    await store.updateProfile(booking.id, { name: "Edited", module: "booking", hiddenFields: ["freightTerms"] });
    await Promise.all([
      store.setAssignments(user.id, { bookingVisibilityProfileId: "" }),
      store.setAssignments(user.id, { orderVisibilityProfileId: "" })
    ]);
    saved = await store.getUserConfiguration(user.id);
    assert.deepEqual(saved.fieldVisibility, { booking: [], order: [] });
    assert.equal(saved.assignments.ruleConfigurationId, config.id);

    const script = `
      import {createBookingPool} from './backend/src/lib/bookingStore.js';
      import {createAccessConfigurationStore} from './backend/src/lib/accessConfigurationStore.js';
      const pool=createBookingPool(), schema=process.argv[1];
      const scoped={async connect(){const c=await pool.connect(); return {query:(sql,p)=>c.query(sql.replaceAll('portal_access_v1.',schema+'.'),p),release:(e)=>c.release(e)}}};
      try { console.log(JSON.stringify(await createAccessConfigurationStore(scoped).getUserConfiguration(process.argv[2]))); } finally {await pool.end()}
    `;
    const child = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, schema, user.id]);
    assert.deepEqual(JSON.parse(child.stdout), saved);
    assert.equal(await store.setAssignments(randomUUID(), { ruleConfigurationId: config.id }), false);
    assert.equal(await store.getUserConfiguration(randomUUID()), null);
    assert.equal(await store.updateRule(randomUUID(), input), null);
    assert.equal(await store.updateProfile(randomUUID(), { name: "Missing", module: "booking", hiddenFields: [] }), null);
    await store.setAssignments(user.id, { ruleConfigurationId: null });
    assert.equal(await store.deleteRule(config.id), true);
    assert.equal(await store.deleteProfile(booking.id), true);
    assert.equal(await store.deleteProfile(order.id), true);
    assert.equal(await store.deleteProfile(order.id), false);
    await users.delete(user.id);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
