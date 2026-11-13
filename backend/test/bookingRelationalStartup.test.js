import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import net from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRelationalBookingReadiness, initializeRelationalBookingSchema, verifyRelationalBookingSchema } from "../src/lib/bookingRelationalSchema.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { bookingReadiness } from "../src/lib/bookingReadiness.js";
import { createApp } from "../src/lib/http.js";

test("v4 initialization rolls back and releases its connection on incompatible schema", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      return { rows: [] };
    },
    release() { released = true; }
  };
  await assert.rejects(initializeRelationalBookingSchema({ connect: async () => client }), /Relational booking schema is incompatible/);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
  assert.ok(released);
});

test("v4 audit schema verification checks columns, key, index and privileges", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const ddl = (await readFile(new URL("../sql/booking-v4.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(ddl);
    await client.query(ddl);
    await verifyRelationalBookingSchema(client, schema);
    await checkRelationalBookingReadiness(client, schema);

    for (const [statement, error] of [
      [`ALTER TABLE ${schema}.audit_events ALTER COLUMN action DROP NOT NULL`, /audit_events\.action must be text NOT NULL/],
      [`ALTER TABLE ${schema}.audit_events ALTER COLUMN occurred_at DROP DEFAULT`, /audit_events\.occurred_at must default to now/],
      [`ALTER TABLE ${schema}.audit_events DROP CONSTRAINT audit_events_pkey`, /missing key on audit_events/],
      [`DROP INDEX ${schema}.audit_events_newest_idx`, /audit_events newest-first index is missing or invalid/]
    ]) {
      await client.query("SAVEPOINT invalid_audit");
      await client.query(statement);
      await assert.rejects(verifyRelationalBookingSchema(client, schema), error);
      await client.query("ROLLBACK TO SAVEPOINT invalid_audit");
    }

    await client.query("SAVEPOINT wrong_index");
    await client.query(`DROP INDEX ${schema}.audit_events_newest_idx`);
    await client.query(`CREATE INDEX audit_events_newest_idx ON ${schema}.audit_events (occurred_at ASC, id DESC)`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /audit_events newest-first index is missing or invalid/);
    await client.query("ROLLBACK TO SAVEPOINT wrong_index");

    await client.query("SAVEPOINT missing_audit_column");
    await client.query(`ALTER TABLE ${schema}.audit_events DROP COLUMN after_data`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /audit_events\.after_data/);
    await assert.rejects(checkRelationalBookingReadiness(client, schema), { code: "42703" });
    await client.query("ROLLBACK TO SAVEPOINT missing_audit_column");

    for (const privilege of ["SELECT", "INSERT"]) {
      const deniedClient = {
        async query(sql, params) {
          const result = await client.query(sql, params);
          if (sql.includes("has_table_privilege")) {
            const entry = result.rows.find((row) => row.table_name === "audit_events" && row.privilege === privilege);
            assert.ok(entry, `audit ${privilege} must be checked`);
            entry.allowed = false;
          }
          return result;
        }
      };
      await assert.rejects(verifyRelationalBookingSchema(deniedClient, schema), new RegExp(`lacks ${privilege} on audit_events`));
    }
    await verifyRelationalBookingSchema(client, schema);
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test("v4 schema verification detects incompatible columns, constraints and sequence", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const ddl = (await readFile(new URL("../sql/booking-v4.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(ddl);
    await client.query(ddl);
    await verifyRelationalBookingSchema(client, schema);
    await checkRelationalBookingReadiness(client, schema);
    await client.query("SAVEPOINT broken_column");
    await client.query(`ALTER TABLE ${schema}.bookings ALTER COLUMN mode TYPE integer USING NULL`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /bookings\.mode must be text nullable/);
    await client.query("ROLLBACK TO SAVEPOINT broken_column");
    await client.query("SAVEPOINT extra_column");
    await client.query(`ALTER TABLE ${schema}.bookings ADD COLUMN unexpected text NOT NULL`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /unexpected required column bookings\.unexpected/);
    await client.query("ROLLBACK TO SAVEPOINT extra_column");
    await client.query("SAVEPOINT missing_column");
    await client.query(`ALTER TABLE ${schema}.booking_documents DROP COLUMN uploaded_by`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /booking_documents\.uploaded_by/);
    await assert.rejects(checkRelationalBookingReadiness(client, schema), { code: "42703" });
    await client.query("ROLLBACK TO SAVEPOINT missing_column");
    await client.query("SAVEPOINT broken_constraint");
    await client.query(`ALTER TABLE ${schema}.booking_documents DROP CONSTRAINT booking_documents_check`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /missing check on booking_documents/);
    await client.query("ROLLBACK TO SAVEPOINT broken_constraint");
    await client.query("SAVEPOINT broken_fk");
    await client.query(`ALTER TABLE ${schema}.booking_parties DROP CONSTRAINT booking_parties_booking_id_fkey`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /missing booking relationship on booking_parties/);
    await client.query("ROLLBACK TO SAVEPOINT broken_fk");
    await client.query("SAVEPOINT broken_sequence");
    await client.query(`DROP SEQUENCE ${schema}.booking_reference_seq`);
    await assert.rejects(verifyRelationalBookingSchema(client, schema), /reference sequence is missing/);
    await client.query("ROLLBACK TO SAVEPOINT broken_sequence");
    const deniedClient = {
      async query(sql, params) {
        const result = await client.query(sql, params);
        if (sql.includes("has_table_privilege")) result.rows[0].allowed = false;
        return result;
      }
    };
    await assert.rejects(verifyRelationalBookingSchema(deniedClient, schema), /database role lacks/);
    await verifyRelationalBookingSchema(client, schema);
    await client.query("ROLLBACK");
    started = false;
    await Promise.all([initializeRelationalBookingSchema(pool), initializeRelationalBookingSchema(pool)]);
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test("backend fails before listening when v4 initialization fails", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/failRelationalSchemaLoader.js", import.meta.url).href, "server.js"], { cwd, env: { ...process.env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  assert.notEqual(code, 0);
  assert.match(output, /Booking PostgreSQL startup failed: simulated incompatible v4 schema/);
  assert.doesNotMatch(output, /SBMS API on/);
});

test("v4 readiness reports missing schema and recovers", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  let schema = "booking_portal_v4";
  const app = createApp();
  app.get("/ready", bookingReadiness(() => checkRelationalBookingReadiness(pool, schema)));
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/ready`;
  try {
    assert.equal((await fetch(url)).status, 200);
    schema = `booking_missing_${randomUUID().replaceAll("-", "")}`;
    assert.equal((await fetch(url)).status, 503);
    schema = "booking_portal_v4";
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});

test("backend readiness checks the active v4 schema", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/failRelationalSchemaLoader.js", import.meta.url).href, "server.js"], { cwd, env: { ...process.env, PORT: String(port), TEST_V4_READY_FAILURE: "1" }, stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    let response;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null) throw new Error(`Backend exited: ${errors}`);
      try { response = await fetch(`http://127.0.0.1:${port}/api/ready`); break; }
      catch { await sleep(100); }
    }
    assert.ok(response, "Backend did not start");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).bookingDatabase, "unavailable");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
