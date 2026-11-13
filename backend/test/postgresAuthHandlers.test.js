import assert from "node:assert/strict";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApp, Router } from "../src/lib/http.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createUserAuthentication } from "../src/lib/userAuthentication.js";
import { createUserAccessSettingsStore } from "../src/lib/userAccessSettingsStore.js";
import { createPostgresAuthHandlers } from "../src/lib/postgresAuthHandlers.js";
import { canSeeBooking } from "../src/db.js";

test("PostgreSQL authentication adapter enforces password changes and fails closed", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_http_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  let unavailable = false;
  let changeScopeDuringAuthentication = false;
  const translated = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  const scoped = {
    query(sql, params) {
      if (unavailable) throw Object.assign(new Error("simulated database outage"), { code: "ECONNREFUSED" });
      return pool.query(translated(sql), params);
    },
    async connect() {
      if (unavailable) throw Object.assign(new Error("simulated database outage"), { code: "ECONNREFUSED" });
      const client = await pool.connect();
      return { query: async (sql, params) => {
        const result = await client.query(translated(sql), params?.map((value) => value === "portal_access_v1" ? schema : value));
        if (changeScopeDuringAuthentication && sql.includes("c.session_version::text")) {
          changeScopeDuringAuthentication = false;
          await pool.query(`UPDATE ${schema}.user_organization_scopes SET organization_code = 'OTHER' WHERE user_id = $1`, [params[0]]);
        }
        return result;
      }, release: (error) => client.release(error) };
    }
  };
  let created = false;
  let server;
  try {
    await pool.query((await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema));
    created = true;
    await pool.query(`INSERT INTO ${schema}.roles(name) VALUES ('Data Entry')`);
    await pool.query(`INSERT INTO ${schema}.permissions(code,label) VALUES ('booking.view','Bookings')`);
    await pool.query(`INSERT INTO ${schema}.role_permissions VALUES ('Data Entry','booking.view')`);
    const id = randomUUID();
    const salt = randomBytes(16);
    await pool.query(`INSERT INTO ${schema}.users(id,name,email,role_name) VALUES($1,'Test','user@example.invalid','Data Entry')`, [id]);
    await pool.query(`INSERT INTO ${schema}.user_credentials VALUES($1,$2,$3,$4,true,0,0)`, [id, salt, scryptSync("Temporary-Password1", salt, 64), randomUUID()]);
    await pool.query(`INSERT INTO ${schema}.user_organization_scopes VALUES($1,'booking','ALLOWED',0)`, [id]);
    const auth = createUserAuthentication(scoped, { secret: "test-secret-with-more-than-thirty-two-bytes" });
    const handlers = createPostgresAuthHandlers(auth, createUserAccessSettingsStore(scoped));
    const app = createApp();
    app.post("/api/auth/login", handlers.login);
    const api = Router();
    api.use(handlers.middleware);
    api.get("/me", (req, res) => res.json({ user: req.user, mustChangePassword: req.mustChangePassword }));
    api.post("/auth/change-password", handlers.changePassword);
    api.get("/test", (req, res) => res.json({ allowed: req.accessRole.permissions.includes("booking.view") && canSeeBooking(req.user, { cwOrgCode: "ALLOWED" }), denied: canSeeBooking(req.user, { cwOrgCode: "OTHER" }) }));
    app.use("/api/v1", api);
    server = app.listen(0);
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (path, method, body, token) => fetch(base + path, {
      method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    assert.equal((await request("/api/auth/login", "POST", {})).status, 400);
    assert.equal((await request("/api/auth/login", "POST", { email: "user@example.invalid", password: "wrong" })).status, 401);
    const login = await (await request("/api/auth/login", "POST", { email: "user@example.invalid", password: "Temporary-Password1" })).json();
    assert.equal(login.mustChangePassword, true);
    assert.equal((await request("/api/v1/me", "GET", undefined, login.token)).status, 200);
    assert.equal((await request("/api/v1/test", "GET", undefined, login.token)).status, 403);
    assert.equal((await request("/api/v1/auth/change-password", "POST", { currentPassword: "Temporary-Password1", newPassword: "short" }, login.token)).status, 400);
    const changed = await request("/api/v1/auth/change-password", "POST", { currentPassword: "Temporary-Password1", newPassword: "New-Password1" }, login.token);
    assert.deepEqual(await changed.json(), { ok: true, reauthenticate: true });
    assert.equal((await request("/api/v1/me", "GET", undefined, login.token)).status, 401);
    const next = await (await request("/api/auth/login", "POST", { email: "user@example.invalid", password: "New-Password1" })).json();
    assert.deepEqual(await (await request("/api/v1/test", "GET", undefined, next.token)).json(), { allowed: true, denied: false });
    changeScopeDuringAuthentication = true;
    assert.deepEqual(await (await request("/api/v1/test", "GET", undefined, next.token)).json(), { allowed: true, denied: false });
    assert.deepEqual(await (await request("/api/v1/test", "GET", undefined, next.token)).json(), { allowed: false, denied: true });
    await pool.query(`ALTER TABLE ${schema}.user_organization_scopes ENABLE ROW LEVEL SECURITY`);
    assert.equal((await request("/api/v1/test", "GET", undefined, next.token)).status, 503);
    await pool.query(`ALTER TABLE ${schema}.user_organization_scopes DISABLE ROW LEVEL SECURITY`);
    unavailable = true;
    const failed = await request("/api/v1/test", "GET", undefined, next.token);
    assert.equal(failed.status, 503);
    assert.equal(failed.headers.get("cache-control"), "no-store");
    assert.match((await failed.json()).error, /temporarily unavailable/);
    unavailable = false;
    assert.deepEqual(await (await request("/api/v1/test", "GET", undefined, next.token)).json(), { allowed: false, denied: true });
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally { await pool.end(); }
  }
});
