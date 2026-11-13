import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { initializeUserAccessSchema, verifyUserAccessSchema } from "../src/lib/userAccessSchema.js";

test("initializer rolls back failed DDL and releases the connection", async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes("CREATE SCHEMA")) throw new Error("DDL denied");
    },
    release(error) { calls.push(error || "release"); }
  };
  await assert.rejects(initializeUserAccessSchema({ connect: async () => client }), /DDL denied/);
  assert.equal(calls[0], "BEGIN");
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.equal(calls.at(-2), "ROLLBACK");
  assert.equal(calls.at(-1), "release");
});

test("initializer discards the connection if rollback fails", async () => {
  const rollbackError = new Error("rollback failed");
  let released;
  const client = {
    async query(sql) {
      if (sql.includes("CREATE SCHEMA")) throw new Error("DDL denied");
      if (sql === "ROLLBACK") throw rollbackError;
    },
    release(error) { released = error; }
  };
  await assert.rejects(initializeUserAccessSchema({ connect: async () => client }), /DDL denied/);
  assert.equal(released, rollbackError);
});

test("verifier checks schema structure, privileges and idempotent DDL", { skip: process.env.BOOKING_DB_TEST !== "1" }, async (t) => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `access_verify_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const ddl = (await readFile(new URL("../sql/user-access-v1.sql", import.meta.url), "utf8")).replaceAll("portal_access_v1", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(ddl);
    await client.query(ddl);
    await verifyUserAccessSchema(client, schema);

    async function rejectsAlteration(name, alteration, pattern) {
      await t.test(name, async () => {
        await client.query("SAVEPOINT alteration");
        try {
          await client.query(alteration);
          await assert.rejects(verifyUserAccessSchema(client, schema), pattern);
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT alteration");
        }
      });

    }

    await rejectsAlteration("wrong column type", `ALTER TABLE ${schema}.roles ALTER COLUMN description TYPE varchar(100)`, /roles\.description/);
    await rejectsAlteration("wrong default", `ALTER TABLE ${schema}.users ALTER COLUMN branch_code SET DEFAULT 'OTHER'`, /invalid default/);
    await rejectsAlteration("unexpected column", `ALTER TABLE ${schema}.roles ADD COLUMN extra text`, /unexpected column/);
    await rejectsAlteration("missing check", `ALTER TABLE ${schema}.users DROP CONSTRAINT users_email_check`, /missing check/);
    await rejectsAlteration("missing foreign key", `ALTER TABLE ${schema}.users DROP CONSTRAINT users_role_name_fkey`, /missing relationship/);
    await rejectsAlteration("missing ordered uniqueness", `ALTER TABLE ${schema}.role_modules DROP CONSTRAINT role_modules_role_name_position_key`, /missing key/);
    await rejectsAlteration("unexpected check", `ALTER TABLE ${schema}.users ADD CHECK (length(name) > 10)`, /unexpected constraints/);
    await rejectsAlteration("missing email index", `DROP INDEX ${schema}.users_email_unique_idx`, /unique email index/);
    await rejectsAlteration("partial email index", `DROP INDEX ${schema}.users_email_unique_idx; CREATE UNIQUE INDEX users_email_unique_idx ON ${schema}.users (lower(email)) WHERE email <> ''`, /unique email index/);
    await rejectsAlteration("incorrect email index", `DROP INDEX ${schema}.users_email_unique_idx; CREATE UNIQUE INDEX users_email_unique_idx ON ${schema}.users (email)`, /unique email index/);
    await rejectsAlteration("row-level security", `ALTER TABLE ${schema}.user_organization_scopes ENABLE ROW LEVEL SECURITY`, /row security enabled on user_organization_scopes/);

    await t.test("denied schema usage", async () => {
      const proxy = { query: (sql, params) => sql.includes("has_schema_privilege") ? Promise.resolve({ rows: [{ allowed: false }] }) : client.query(sql, params) };
      await assert.rejects(verifyUserAccessSchema(proxy, schema), /lacks schema USAGE/);
    });
    await t.test("denied table privilege", async () => {
      const proxy = { query: async (sql, params) => {
        const result = await client.query(sql, params);
        if (sql.includes("has_table_privilege")) result.rows.find((row) => row.table_name === "users" && row.privilege === "UPDATE").allowed = false;
        return result;
      } };
      await assert.rejects(verifyUserAccessSchema(proxy, schema), /lacks UPDATE on users/);
    });
    await assert.rejects(verifyUserAccessSchema(client, "bad;name"), /Invalid user access schema name/);
    await client.query("ROLLBACK");
    started = false;
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test("initializer rolls back DDL when schema verification fails", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `access_rollback_${randomUUID().replaceAll("-", "")}`;
  const wrappedPool = {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, params) {
          let translated = sql.replaceAll("portal_access_v1", schema);
          if (sql.includes("CREATE SCHEMA")) translated += `\nALTER TABLE ${schema}.users DROP CONSTRAINT users_email_check;`;
          if (sql === "COMMIT") translated = "ROLLBACK";
          const result = await client.query(translated, params?.map((value) => value === "portal_access_v1" ? schema : value));
          for (const row of result.rows || []) {
            if (row.target_schema === schema) row.target_schema = "portal_access_v1";
          }
          return result;
        },
        release(error) { client.release(error); }
      };
    }
  };
  try {
    await assert.rejects(initializeUserAccessSchema(wrappedPool), /missing check/);
    const result = await pool.query("SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS exists", [schema]);
    assert.equal(result.rows[0].exists, false);
  } finally {
    await pool.end();
  }
});
