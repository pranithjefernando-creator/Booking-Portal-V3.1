import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { DEFAULT_APPROVAL_ID } from "../src/lib/accessConfigurationStore.js";
import { verifyUserAccessRuntime } from "../src/lib/userAccessReadiness.js";
import { accessDatabaseOperation } from "../src/lib/accessErrors.js";

test("access failures are classified without hiding programming or validation errors", async () => {
  const unavailable = Object.assign(new Error("connection failed"), { code: "ECONNREFUSED" });
  await assert.rejects(accessDatabaseOperation(() => { throw unavailable; }), (error) => error.code === "ACCESS_UNAVAILABLE" && error.cause === unavailable);
  const invalid = Object.assign(new Error("foreign key"), { code: "23503" });
  await assert.rejects(accessDatabaseOperation(() => { throw invalid; }), (error) => error === invalid);
  const bug = new Error("unexpected programming error");
  await assert.rejects(accessDatabaseOperation(() => { throw bug; }), (error) => error === bug);
});

test("runtime readiness checks all tables and the saved default without changing data", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `access_ready_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    await client.query((await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema));
    await assert.rejects(verifyUserAccessRuntime(client, schema), /Default approval configuration is missing/);
    await client.query(`INSERT INTO ${schema}.approval_rule_configurations (id, name, enabled, rules) VALUES ($1, 'Edited default', false, '[]'::jsonb)`, [DEFAULT_APPROVAL_ID]);
    await verifyUserAccessRuntime(client, schema);
    const saved = await client.query(`SELECT name, enabled, rules FROM ${schema}.approval_rule_configurations WHERE id = $1`, [DEFAULT_APPROVAL_ID]);
    assert.deepEqual(saved.rows[0], { name: "Edited default", enabled: false, rules: [] });
    await client.query(`UPDATE ${schema}.approval_rule_configurations SET rules = '[{"name":"broken","conditions":[]}]'::jsonb WHERE id = $1`, [DEFAULT_APPROVAL_ID]);
    await assert.rejects(verifyUserAccessRuntime(client, schema), /Default approval configuration is invalid/);
    await assert.rejects(verifyUserAccessRuntime(client, "invalid;schema"), /Invalid user access schema/);
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
