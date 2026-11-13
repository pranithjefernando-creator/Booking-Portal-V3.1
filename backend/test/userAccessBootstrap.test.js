import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { bootstrapUserAccess } from "../src/lib/userAccessBootstrap.js";
import { createUserAuthentication } from "../src/lib/userAuthentication.js";

test("first administrator bootstrap is atomic and refuses repeats", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const scoped = {
    query: (sql, params) => pool.query(sql.replaceAll("portal_access_v1.", `${schema}.`), params),
    async connect() {
      const client = await pool.connect();
      return {
        query: (sql, params) => client.query(sql.replaceAll("portal_access_v1.", `${schema}.`), params),
        release: (error) => client.release(error)
      };
    }
  };
  let created = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await pool.query(ddl);
    created = true;
    await assert.rejects(bootstrapUserAccess(scoped, { name: "Test", email: "bad", password: "Test-Password1" }), /valid administrator email/);
    await assert.rejects(bootstrapUserAccess(scoped, { name: "Test", email: "admin@example.invalid", password: "short" }), /at least 8/);
    const attempts = await Promise.allSettled([
      bootstrapUserAccess(scoped, { name: "First", email: "first@example.invalid", password: "Test-Password1" }),
      bootstrapUserAccess(scoped, { name: "Second", email: "second@example.invalid", password: "Test-Password2" })
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.match(attempts.find((result) => result.status === "rejected").reason.message, /user records already exist/);
    const account = attempts.find((result) => result.status === "fulfilled").value;
    const password = account.name === "First" ? "Test-Password1" : "Test-Password2";
    const auth = createUserAuthentication(scoped, { secret: "test-only-signing-secret-of-at-least-32-bytes" });
    const login = await auth.login(account.email, password);
    assert.equal(login.status, "ok");
    assert.equal(login.mustChangePassword, true);
    assert.equal(login.user.role, "Admin");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.users`)).rows[0].n, 1);
    const stored = await pool.query(`SELECT password_salt, password_hash FROM ${schema}.user_credentials WHERE user_id = $1`, [account.id]);
    assert.equal(stored.rows[0].password_salt.length, 16);
    assert.equal(stored.rows[0].password_hash.length, 64);
    assert.equal(stored.rows[0].password_hash.includes(Buffer.from(password)), false);
    await assert.rejects(bootstrapUserAccess(scoped, { name: "Other", email: "other@example.invalid", password: "Test-Password1" }), /user records already exist/);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});

test("bootstrap refuses incomplete existing Admin grants and rolls back", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_bootstrap_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const scoped = {
    async connect() {
      const client = await pool.connect();
      return {
        query: (sql, params) => client.query(sql.replaceAll("portal_access_v1.", `${schema}.`), params),
        release: (error) => client.release(error)
      };
    }
  };
  let created = false;
  try {
    await pool.query((await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema));
    created = true;
    await pool.query(`INSERT INTO ${schema}.roles (name) VALUES ('Admin')`);
    await assert.rejects(bootstrapUserAccess(scoped, { name: "Admin", email: "admin@example.invalid", password: "Test-Password1" }), /missing required grants/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.users`)).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.permissions`)).rows[0].n, 0);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
