import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { defaultRoles, MODULES, PERMISSIONS } from "../src/rbac.js";

test("user access schema models users, roles and ordered scopes with relational constraints", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `access_test_${randomUUID().replaceAll("-", "")}`;
  const user = randomUUID();
  const other = randomUUID();
  let started = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(ddl);
    await client.query(ddl);
    for (const [code, label] of Object.entries(PERMISSIONS)) await client.query(`INSERT INTO ${schema}.permissions (code, label) VALUES ($1, $2)`, [code, label]);
    for (const [code, label] of Object.entries(MODULES)) await client.query(`INSERT INTO ${schema}.modules (code, label) VALUES ($1, $2)`, [code, label]);
    for (const [name, role] of Object.entries(defaultRoles())) {
      await client.query(`INSERT INTO ${schema}.roles (name, description, builtin) VALUES ($1, $2, $3)`, [name, role.description, role.builtin]);
      for (const code of role.permissions) await client.query(`INSERT INTO ${schema}.role_permissions (role_name, permission_code) VALUES ($1, $2)`, [name, code]);
      for (const [position, code] of role.modules.entries()) await client.query(`INSERT INTO ${schema}.role_modules (role_name, module_code, position) VALUES ($1, $2, $3)`, [name, code, position]);
    }
    await client.query(`INSERT INTO ${schema}.users (id, name, email, role_name) VALUES ($1, $2, $3, $4)`, [user, "Test user", "User@example.invalid", "Manager"]);
    await client.query(`INSERT INTO ${schema}.user_modules (user_id, module_code, position) VALUES ($1, 'orders', 0), ($1, 'bookings', 1)`, [user]);
    const scopes = ["booking", "booking_shipper", "booking_consignee", "order", "order_supplier", "order_buyer", "tracking"];
    for (const scope of scopes) await client.query(`INSERT INTO ${schema}.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, $2, $3, 0)`, [user, scope, scope === "tracking" ? "tracking:party:123" : "TESTCO"]);
    await client.query(`INSERT INTO ${schema}.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, 'booking', 'SECOND', 1)`, [user]);
    const saved = await client.query(`SELECT id, email, role_name, modules_configured FROM ${schema}.users WHERE id = $1`, [user]);
    assert.deepEqual(saved.rows[0], { id: user, email: "User@example.invalid", role_name: "Manager", modules_configured: false });
    const order = await client.query(`SELECT organization_code FROM ${schema}.user_organization_scopes WHERE user_id = $1 AND scope_type = 'booking' ORDER BY position`, [user]);
    assert.deepEqual(order.rows.map((row) => row.organization_code), ["TESTCO", "SECOND"]);
    await client.query(`UPDATE ${schema}.users SET modules_configured = true WHERE id = $1`, [user]);
    await client.query(`DELETE FROM ${schema}.user_modules WHERE user_id = $1`, [user]);
    assert.equal((await client.query(`SELECT modules_configured FROM ${schema}.users WHERE id = $1`, [user])).rows[0].modules_configured, true);

    async function rejects(sql, params, code) {
      await client.query("SAVEPOINT expected_failure");
      await assert.rejects(client.query(sql, params), { code });
      await client.query("ROLLBACK TO SAVEPOINT expected_failure");
    }
    await rejects(`INSERT INTO ${schema}.users (id, name, email, role_name) VALUES ($1, 'Duplicate', 'user@EXAMPLE.invalid', 'Manager')`, [other], "23505");
    await rejects(`INSERT INTO ${schema}.users (id, name, email, role_name) VALUES ($1, 'Bad', ' not-an-email ', 'Manager')`, [other], "23514");
    await rejects(`INSERT INTO ${schema}.users (id, name, email, role_name) VALUES ($1, 'Bad', 'other@example.invalid', 'Missing')`, [other], "23503");
    await rejects(`INSERT INTO ${schema}.users (id, name, email, role_name) VALUES ('not-a-uuid', 'Bad', 'other@example.invalid', 'Manager')`, [], "22P02");
    await rejects(`INSERT INTO ${schema}.role_permissions (role_name, permission_code) VALUES ('Manager', 'unknown')`, [], "23503");
    await rejects(`INSERT INTO ${schema}.user_modules (user_id, module_code, position) VALUES ($1, 'unknown', 0)`, [user], "23503");
    await rejects(`INSERT INTO ${schema}.user_modules (user_id, module_code, position) VALUES ($1, 'orders', 0)`, [other], "23503");
    await rejects(`INSERT INTO ${schema}.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, 'invalid', 'TEST', 0)`, [user], "23514");
    await rejects(`INSERT INTO ${schema}.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, 'booking', 'TESTCO', 2)`, [user], "23505");
    await rejects(`INSERT INTO ${schema}.user_organization_scopes (user_id, scope_type, organization_code, position) VALUES ($1, 'booking', 'THIRD', 0)`, [user], "23505");
    await rejects(`DELETE FROM ${schema}.roles WHERE name = 'Manager'`, [], "23503");
    await client.query(`INSERT INTO ${schema}.user_modules (user_id, module_code, position) VALUES ($1, 'orders', 0)`, [user]);
    await client.query(`DELETE FROM ${schema}.users WHERE id = $1`, [user]);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.user_organization_scopes WHERE user_id = $1`, [user])).rows[0].count, 0);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.user_modules WHERE user_id = $1`, [user])).rows[0].count, 0);
    await client.query("ROLLBACK");
    started = false;
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
