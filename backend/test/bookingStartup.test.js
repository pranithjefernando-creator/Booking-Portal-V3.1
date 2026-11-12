import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/lib/http.js";
import { bookingReadiness } from "../src/lib/bookingReadiness.js";
import { checkBookingReadiness, initializeBookingSchema } from "../src/lib/bookingSchema.js";
import { createBookingPool } from "../src/lib/bookingStore.js";

test("startup exits before listening when PostgreSQL is not configured or unavailable", async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  async function run(env) {
    const child = spawn(process.execPath, ["server.js"], { cwd, env: { ...process.env, ...env, PORT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "close");
    return { code, output };
  }
  const missing = await run({ PGHOST: "", PGDATABASE: "", PGUSER: "", PGPASSWORD: "" });
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /Booking PostgreSQL startup failed: Missing PostgreSQL configuration/);
  assert.doesNotMatch(missing.output, /SBMS API on/);
  const unavailable = await run({ PGHOST: "127.0.0.1", PGPORT: "1", PGDATABASE: "test", PGUSER: "test", PGPASSWORD: "test-password-not-for-output" });
  assert.notEqual(unavailable.code, 0);
  assert.match(unavailable.output, /Booking PostgreSQL startup failed/);
  assert.doesNotMatch(unavailable.output, /SBMS API on|test-password-not-for-output/);
});

test("schema initialization rolls back and releases its connection on incompatible schema", async () => {
  const statements = [];
  let released = false;
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("FROM pg_class c JOIN pg_namespace")) return { rows: [] };
      return { rows: [] };
    },
    release() { released = true; }
  };
  await assert.rejects(initializeBookingSchema({ connect: async () => client }), /Booking schema is incompatible/);
  assert.equal(statements[0], "BEGIN");
  assert.equal(statements.at(-1), "ROLLBACK");
  assert.ok(!statements.includes("COMMIT"));
  assert.equal(released, true);
});

test("readiness reports an outage and recovers when the database check succeeds", async () => {
  let available = true;
  const app = createApp();
  app.get("/api/ready", bookingReadiness(async () => { if (!available) throw new Error("simulated outage"); }));
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/ready`;
  try {
    let response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bookingDatabase, "ready");
    available = false;
    response = await fetch(url);
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()).sort(), ["bookingDatabase", "service", "status", "time"]);
    available = true;
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("idle PostgreSQL connection errors are handled without crashing", async () => {
  const pool = createBookingPool({ PGHOST: "localhost", PGDATABASE: "test", PGUSER: "test", PGPASSWORD: "test" });
  try { assert.doesNotThrow(() => pool.emit("error", new Error("simulated idle connection failure"))); }
  finally { await pool.end(); }
});

test("readiness uses PostgreSQL and recovers after a closed pool is replaced", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  let pool = createBookingPool();
  const app = createApp();
  app.get("/api/ready", bookingReadiness(() => checkBookingReadiness(pool)));
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/api/ready`;
  try {
    assert.equal((await fetch(url)).status, 200);
    await pool.end();
    assert.equal((await fetch(url)).status, 503);
    pool = createBookingPool();
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await pool.end();
  }
});

test("schema SQL creates an isolated schema and initialization is safe concurrently", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `booking_test_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const sql = (await readFile(new URL("../sql/booking-v3.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v3", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(sql);
    await client.query(sql);
    const result = await client.query("SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r'", [schema]);
    assert.equal(result.rows[0].count, 6);
    await client.query("ROLLBACK");
    started = false;
    await Promise.all([initializeBookingSchema(pool), initializeBookingSchema(pool)]);
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
