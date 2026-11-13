import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createUserAccessStore } from "../src/lib/userAccessStore.js";

const execFileAsync = promisify(execFile);

function scopedPool(pool, schema) {
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  return {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
    }
  };
}

test("user record transaction rolls back and releases on failure", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("INSERT INTO")) throw new Error("database unavailable");
    },
    release(error) { calls.push(error || "release"); }
  };
  const store = createUserAccessStore({ connect: async () => client });
  await assert.rejects(store.create({ name: "Test", email: "test@example.invalid" }), /database unavailable/);
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.deepEqual(calls.slice(-2), ["ROLLBACK", "release"]);
});

test("user record transaction discards a connection when rollback fails", async () => {
  const rollbackError = new Error("rollback failed");
  let released;
  const client = {
    async query(sql) {
      if (sql.includes("INSERT INTO")) throw new Error("write failed");
      if (sql === "ROLLBACK") throw rollbackError;
    },
    release(error) { released = error; }
  };
  await assert.rejects(createUserAccessStore({ connect: async () => client }).create({ name: "Test", email: "test@example.invalid" }), /write failed/);
  assert.equal(released, rollbackError);
});

test("staged PostgreSQL user CRUD persists and protects the last administrator", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const schema = `access_store_${randomUUID().replaceAll("-", "")}`;
  const pool = createBookingPool();
  const store = createUserAccessStore(scopedPool(pool, schema));
  let createdSchema = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await pool.query(ddl);
    createdSchema = true;
    await pool.query(`INSERT INTO ${schema}.roles (name) VALUES ('Admin'), ('Data Entry')`);
    await pool.query(`INSERT INTO ${schema}.modules (code, label) VALUES ('bookings', 'Bookings')`);
    const admin = await store.create({ name: " Admin ", email: " Admin@example.invalid ", role: "Admin" });
    const user = await store.create({ name: "User", email: "user@example.invalid" });
    assert.equal(admin.name, "Admin");
    assert.equal(admin.email, "Admin@example.invalid");
    assert.equal(user.role, "Data Entry");
    assert.equal(user.branchCode, "CMB");
    assert.equal(user.modulesConfigured, false);
    assert.equal((await store.list()).length, 2);
    assert.deepEqual(await store.get(user.id), user);
    assert.equal(await store.get(randomUUID()), null);
    assert.equal(await store.update(randomUUID(), { name: "Missing" }), null);
    assert.equal(await store.delete(randomUUID()), false);
    await assert.rejects(store.create({ name: "Duplicate", email: "USER@example.invalid" }), { code: "23505" });
    await assert.rejects(store.create({ name: "Invalid", email: "invalid" }), { code: "23514" });
    await assert.rejects(store.create({ name: "Invalid", email: "valid@example.invalid", role: "Missing" }), { code: "23503" });
    await assert.rejects(store.create({ name: "Invalid", email: "valid@example.invalid", modules: [] }), /Unsupported user field/);
    await assert.rejects(store.update(user.id, { id: randomUUID() }), /Unsupported user field/);
    await assert.rejects(store.update(user.id, { name: " " }), /Full name is required/);

    await pool.query(`UPDATE ${schema}.users SET modules_configured = true WHERE id = $1`, [user.id]);
    await pool.query(`INSERT INTO ${schema}.user_modules (user_id, module_code, position) VALUES ($1, 'bookings', 0)`, [user.id]);
    await pool.query(`INSERT INTO ${schema}.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, 'booking', 'TEST', 0)`, [user.id]);
    const updated = await store.update(user.id, { name: " Edited ", email: " edited@example.invalid ", branchCode: "DXB" });
    assert.equal(updated.name, "Edited");
    assert.equal(updated.email, "edited@example.invalid");
    assert.equal(updated.branchCode, "DXB");
    assert.equal(updated.modulesConfigured, true);
    assert.equal(updated.createdAt, user.createdAt);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.user_modules WHERE user_id = $1`, [user.id])).rows[0].n, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.user_organization_scopes WHERE user_id = $1`, [user.id])).rows[0].n, 1);
    await assert.rejects(store.update(user.id, { email: "admin@example.invalid" }), { code: "23505" });
    assert.deepEqual(await store.get(user.id), updated);
    await Promise.all([store.update(user.id, { name: "Concurrent" }), store.update(user.id, { branchCode: "SIN" })]);
    const concurrent = await store.get(user.id);
    assert.equal(concurrent.name, "Concurrent");
    assert.equal(concurrent.branchCode, "SIN");
    await assert.rejects(store.delete(admin.id), { code: "LAST_ADMIN" });
    await assert.rejects(store.update(admin.id, { role: "Data Entry" }), { code: "LAST_ADMIN" });

    const childScript = `
      import { createBookingPool } from './backend/src/lib/bookingStore.js';
      import { createUserAccessStore } from './backend/src/lib/userAccessStore.js';
      const pool = createBookingPool();
      const schema = process.argv[1];
      const scoped = { query: (sql, params) => pool.query(sql.replaceAll('portal_access_v1.', schema + '.'), params) };
      try { console.log(JSON.stringify(await createUserAccessStore(scoped).get(process.argv[2]))); }
      finally { await pool.end(); }
    `;
    const child = await execFileAsync(process.execPath, ["--input-type=module", "-e", childScript, schema, user.id]);
    assert.deepEqual(JSON.parse(child.stdout), concurrent);

    const otherAdmin = await store.create({ name: "Second admin", email: "admin2@example.invalid", role: "Admin" });
    const raced = await Promise.allSettled([store.delete(admin.id), store.update(otherAdmin.id, { role: "Data Entry" })]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = raced.find((result) => result.status === "rejected");
    assert.equal(rejected.reason.code, "LAST_ADMIN");
    assert.equal((await store.list()).filter((item) => item.role === "Admin").length, 1);
    const remaining = (await store.list()).find((item) => item.role === "Admin");
    const thirdAdmin = await store.create({ name: "Third admin", email: "admin3@example.invalid", role: "Admin" });
    const deletionRace = await Promise.allSettled([store.delete(remaining.id), store.delete(thirdAdmin.id)]);
    assert.equal(deletionRace.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(deletionRace.find((result) => result.status === "rejected").reason.code, "LAST_ADMIN");
    assert.equal((await store.list()).filter((item) => item.role === "Admin").length, 1);
    assert.equal(await store.delete(user.id), true);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.user_modules WHERE user_id = $1`, [user.id])).rows[0].n, 0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${schema}.user_organization_scopes WHERE user_id = $1`, [user.id])).rows[0].n, 0);
  } finally {
    try {
      if (createdSchema) await pool.query(`DROP SCHEMA ${schema} CASCADE`);
    } finally {
      await pool.end();
    }
  }
});
