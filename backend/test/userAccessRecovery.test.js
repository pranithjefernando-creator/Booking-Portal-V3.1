import assert from "node:assert/strict";
import { randomUUID, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { bootstrapUserAccess } from "../src/lib/userAccessBootstrap.js";
import { recoverAdministratorPassword } from "../src/lib/userAccessRecovery.js";
import { createUserAuthentication } from "../src/lib/userAuthentication.js";

test("local administrator recovery is scoped, transactional and revokes sessions", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_recovery_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  let failUpdate = false;
  const scoped = {
    query: (sql, params) => pool.query(sql.replaceAll("portal_access_v1.", `${schema}.`), params),
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          const result = await client.query(sql.replaceAll("portal_access_v1.", `${schema}.`), params);
          if (failUpdate && sql.includes("UPDATE portal_access_v1.user_credentials AS c")) throw new Error("simulated write failure");
          return result;
        },
        release: (error) => client.release(error)
      };
    }
  };
  let created = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await pool.query(ddl);
    created = true;
    const admin = await bootstrapUserAccess(scoped, { name: "Admin", email: "admin@example.invalid", password: "Initial-Password1" });
    const userId = randomUUID();
    const salt = Buffer.alloc(16, 1);
    await pool.query(`INSERT INTO ${schema}.users (id, name, email, role_name) VALUES ($1, 'User', 'user@example.invalid', 'Data Entry')`, [userId]);
    await pool.query(`INSERT INTO ${schema}.user_credentials (user_id, password_salt, password_hash, session_version, must_change, failed_attempts, locked_until) VALUES ($1, $2, $3, $4, false, 0, 0)`, [userId, salt, scryptSync("User-Password1", salt, 64), randomUUID()]);
    const auth = createUserAuthentication(scoped, { secret: "test-only-signing-secret-of-at-least-32-bytes" });
    const previous = await auth.login(admin.email, "Initial-Password1");
    assert.equal(previous.status, "ok");
    await pool.query(`UPDATE ${schema}.user_credentials SET failed_attempts = 0, locked_until = $2 WHERE user_id = $1`, [admin.id, Date.now() + 600000]);

    await assert.rejects(recoverAdministratorPassword(scoped, { email: admin.email, password: "short" }), /at least 8/);
    await assert.rejects(recoverAdministratorPassword(scoped, { email: "user@example.invalid", password: "Recovery-Password2" }), /Administrator account with credentials not found/);
    await assert.rejects(recoverAdministratorPassword(scoped, { email: "missing@example.invalid", password: "Recovery-Password2" }), /Administrator account with credentials not found/);
    failUpdate = true;
    await assert.rejects(recoverAdministratorPassword(scoped, { email: admin.email, password: "Recovery-Password2" }), /simulated write failure/);
    failUpdate = false;
    assert.ok(await auth.authenticate(previous.token));
    assert.equal((await auth.login(admin.email, "Initial-Password1")).status, "locked");

    await recoverAdministratorPassword(scoped, { email: ` ${admin.email.toUpperCase()} `, password: "Recovery-Password2" });
    assert.equal(await auth.authenticate(previous.token), null);
    assert.equal((await auth.login(admin.email, "Initial-Password1")).status, "invalid");
    const recovered = await auth.login(admin.email, "Recovery-Password2");
    assert.equal(recovered.status, "ok");
    assert.equal(recovered.mustChangePassword, true);
    assert.equal((await auth.login("user@example.invalid", "User-Password1")).status, "ok");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.users`)).rows[0].n, 2);
    const state = await pool.query(`SELECT failed_attempts, locked_until FROM ${schema}.user_credentials WHERE user_id = $1`, [admin.id]);
    assert.equal(state.rows[0].failed_attempts, 0);
    assert.equal(Number(state.rows[0].locked_until), 0);
    assert.equal((await auth.changePassword(recovered.token, "Recovery-Password2", "Final-Password3")).status, "ok");
    assert.equal(await auth.authenticate(recovered.token), null);
    assert.equal((await auth.login(admin.email, "Final-Password3")).mustChangePassword, false);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
