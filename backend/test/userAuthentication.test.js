import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createUserAccessStore } from "../src/lib/userAccessStore.js";
import { createUserAccessSettingsStore } from "../src/lib/userAccessSettingsStore.js";
import { createUserAuthentication } from "../src/lib/userAuthentication.js";
import { createAccessConfigurationStore } from "../src/lib/accessConfigurationStore.js";

const execFileAsync = promisify(execFile);
const secret = "test-only-signing-secret-of-at-least-32-bytes";

test("authentication requires a stable, sufficiently long secret", () => {
  assert.throws(() => createUserAuthentication({}, { secret: "short" }), /at least 32 bytes/);
  assert.throws(() => createUserAuthentication({}, { secret, tokenTtlMs: 0 }), /lifetime/);
});

test("PostgreSQL authentication, password changes, resets and restart", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_auth_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  const scoped = {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
    }
  };
  const users = createUserAccessStore(scoped);
  const auth = createUserAuthentication(scoped, { secret });
  const configurations = createAccessConfigurationStore(scoped);
  let created = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await pool.query(ddl);
    created = true;
    await createUserAccessSettingsStore(scoped).initializeCatalogs();
    const admin = await users.create({ name: "Admin", email: "admin@example.invalid", role: "Admin" });
    const user = await users.create({ name: "User", email: "user@example.invalid" });
    const salt = randomBytes(16);
    await pool.query(`INSERT INTO ${schema}.user_credentials (user_id, password_salt, password_hash, session_version, must_change, failed_attempts, locked_until) VALUES ($1, $2, $3, $4, false, 0, 0)`, [admin.id, salt, scryptSync("Admin-Password1", salt, 64), randomUUID()]);
    assert.equal((await auth.login("missing@example.invalid", "Invalid-Password1")).status, "invalid");
    const adminLogin = await auth.login("ADMIN@example.invalid", "Admin-Password1");
    assert.equal(adminLogin.status, "ok");
    const bookingProfile = await configurations.createProfile({ name: "Booking", module: "booking", hiddenFields: ["notes"] });
    const orderProfile = await configurations.createProfile({ name: "Order", module: "order", hiddenFields: ["orderNoSplit"] });
    const newAccount = await auth.createUser(adminLogin.token, { name: " Created ", email: "created@example.invalid", bookingVisibilityProfileId: bookingProfile.id });
    assert.equal(newAccount.status, "ok");
    assert.equal(newAccount.user.name, "Created");
    assert.equal((await configurations.getUserConfiguration(newAccount.user.id)).assignments.bookingVisibilityProfileId, bookingProfile.id);
    const createdLogin = await auth.login(newAccount.user.email, newAccount.temporaryPassword);
    assert.equal(createdLogin.status, "ok");
    assert.equal(createdLogin.mustChangePassword, true);
    assert.deepEqual(await auth.createUser(createdLogin.token, { name: "Forbidden", email: "forbidden@example.invalid" }), { status: "unauthorized" });
    await assert.rejects(auth.createUser(adminLogin.token, { name: "Rollback", email: "rollback@example.invalid", ruleConfigurationId: randomUUID() }), { code: "23503" });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.users WHERE email = $1`, ["rollback@example.invalid"])).rows[0].n, 0);
    await assert.rejects(auth.createUser(adminLogin.token, { name: "Duplicate", email: "CREATED@example.invalid" }), { code: "23505" });
    await assert.rejects(auth.createUser(adminLogin.token, { name: "Wrong profile", email: "profile@example.invalid", bookingVisibilityProfileId: orderProfile.id }), { code: "23503" });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.users WHERE email = $1`, ["profile@example.invalid"])).rows[0].n, 0);
    const failingPool = {
      async connect() {
        const client = await scoped.connect();
        return {
          query(sql, params) {
            if (sql.startsWith("INSERT INTO portal_access_v1.user_credentials")) throw new Error("simulated credential write failure");
            return client.query(sql, params);
          },
          release: (error) => client.release(error)
        };
      }
    };
    const failingAuth = createUserAuthentication(failingPool, { secret });
    await assert.rejects(failingAuth.createUser(adminLogin.token, { name: "Failed", email: "failed@example.invalid", bookingVisibilityProfileId: bookingProfile.id }), /simulated credential write failure/);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.users WHERE email = $1`, ["failed@example.invalid"])).rows[0].n, 0);
    await assert.rejects(auth.updateUser(adminLogin.token, newAccount.user.id, { name: "Should roll back", bookingVisibilityProfileId: orderProfile.id }), { code: "23503" });
    assert.equal((await users.get(newAccount.user.id)).name, "Created");
    assert.equal((await configurations.getUserConfiguration(newAccount.user.id)).assignments.bookingVisibilityProfileId, bookingProfile.id);
    const edited = await auth.updateUser(adminLogin.token, newAccount.user.id, { name: "Edited", bookingVisibilityProfileId: null, orderVisibilityProfileId: orderProfile.id });
    assert.equal(edited.user.name, "Edited");
    assert.equal((await configurations.getUserConfiguration(newAccount.user.id)).assignments.orderVisibilityProfileId, orderProfile.id);
    assert.equal((await auth.updateUser(createdLogin.token, newAccount.user.id, { name: "Forbidden" })).status, "unauthorized");
    await assert.rejects(auth.updateUser(adminLogin.token, admin.id, { role: "Data Entry" }), { code: "LAST_ADMIN" });
    assert.equal((await auth.updateUser(adminLogin.token, randomUUID(), { name: "Missing" })).status, "not_found");
    assert.equal(await users.delete(newAccount.user.id), true);
    const reset = await auth.resetPassword(adminLogin.token, user.id);
    assert.equal(reset.status, "ok");
    const stored = await pool.query(`SELECT password_salt, password_hash, must_change FROM ${schema}.user_credentials WHERE user_id = $1`, [user.id]);
    assert.equal(stored.rows[0].password_salt.length, 16);
    assert.equal(stored.rows[0].password_hash.length, 64);
    assert.equal(stored.rows[0].password_hash.includes(Buffer.from(reset.temporaryPassword)), false);
    assert.equal(stored.rows[0].must_change, true);
    assert.equal(Object.hasOwn(await users.get(user.id), "password_hash"), false);
    const first = await auth.login(user.email, reset.temporaryPassword);
    assert.equal(first.mustChangePassword, true);
    assert.equal((await auth.resetPassword(first.token, user.id)).status, "unauthorized");
    assert.equal((await auth.changePassword(first.token, "incorrect", "New-Password1")).status, "incorrect");
    await assert.rejects(auth.changePassword(first.token, reset.temporaryPassword, "short"), /at least 8/);
    assert.equal((await auth.changePassword(first.token, reset.temporaryPassword, "New-Password1")).status, "ok");
    assert.equal(await auth.authenticate(first.token), null);
    assert.equal((await auth.login(user.email, reset.temporaryPassword)).status, "invalid");
    const login = await auth.login(user.email, "New-Password1");
    assert.equal(login.mustChangePassword, false);
    assert.equal((await auth.resetPassword(login.token, admin.id)).status, "forbidden");
    assert.equal((await auth.createUser(login.token, { name: "Forbidden", email: "forbidden@example.invalid" })).status, "forbidden");
    assert.equal((await auth.updateUser(login.token, admin.id, { name: "Forbidden" })).status, "forbidden");
    assert.equal(await auth.authenticate(`${login.token}x`), null);
    const shortAuth = createUserAuthentication(scoped, { secret, tokenTtlMs: 1 });
    const expiring = await shortAuth.login(user.email, "New-Password1");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await shortAuth.authenticate(expiring.token), null);

    const script = `
      import {createBookingPool} from './backend/src/lib/bookingStore.js';
      import {createUserAuthentication} from './backend/src/lib/userAuthentication.js';
      const pool = createBookingPool(), schema = process.argv[1];
      const scoped = {query: (sql, params) => pool.query(sql.replaceAll('portal_access_v1.', schema + '.'), params)};
      try { console.log(JSON.stringify(await createUserAuthentication(scoped, {secret: process.env.TEST_AUTH_SECRET}).authenticate(process.env.TEST_AUTH_TOKEN))); }
      finally {await pool.end()}
    `;
    const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, schema], { env: { ...process.env, TEST_AUTH_SECRET: secret, TEST_AUTH_TOKEN: login.token } });
    assert.equal(JSON.parse(child.stdout).user.id, user.id);
    const resetAgain = await auth.resetPassword(adminLogin.token, user.id);
    assert.equal(await auth.authenticate(login.token), null);
    assert.equal((await auth.login(user.email, "New-Password1")).status, "invalid");
    for (let i = 0; i < 4; i++) assert.equal((await auth.login(user.email, "Wrong-Password1")).status, "invalid");
    assert.equal((await auth.login(user.email, resetAgain.temporaryPassword)).status, "locked");
    const resetLocked = await auth.resetPassword(adminLogin.token, user.id);
    const lockedLogin = await auth.login(user.email, resetLocked.temporaryPassword);
    assert.equal(lockedLogin.status, "ok");
    const concurrent = await Promise.all([
      auth.changePassword(lockedLogin.token, resetLocked.temporaryPassword, "Concurrent-Password1"),
      auth.changePassword(lockedLogin.token, resetLocked.temporaryPassword, "Concurrent-Password2")
    ]);
    assert.deepEqual(concurrent.map((item) => item.status).sort(), ["ok", "unauthorized"]);
    assert.equal((await auth.resetPassword(adminLogin.token, randomUUID())).status, "not_found");
    const lastLogin = await auth.login(user.email, "Concurrent-Password1");
    const otherLogin = lastLogin.status === "ok" ? lastLogin : await auth.login(user.email, "Concurrent-Password2");
    assert.equal(await users.delete(user.id), true);
    assert.equal(await auth.authenticate(otherLogin.token), null);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.user_credentials WHERE user_id = $1`, [user.id])).rows[0].n, 0);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
