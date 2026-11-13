import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { checkProviderCacheReadiness, initializeProviderCacheSchema, verifyProviderCacheSchema } from "../src/lib/providerCacheSchema.js";
import { cleanupExpiredProviderCache } from "../src/lib/providerCacheCleanup.js";

test("provider cache schema isolates accounts and environments and validates stored records", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const client = await pool.connect();
  const schema = `provider_test_${randomUUID().replaceAll("-", "")}`;
  let started = false;
  try {
    const ddl = (await readFile(new URL("../sql/provider-cache-v1.sql", import.meta.url), "utf8")).replaceAll("booking_portal_v4", schema);
    await client.query("BEGIN");
    started = true;
    await client.query(ddl);
    await client.query(ddl);
    async function rejects(sql, params, code) {
      await client.query("SAVEPOINT invalid_record");
      await assert.rejects(client.query(sql, params), { code });
      await client.query("ROLLBACK TO SAVEPOINT invalid_record");
    }

    const trackingInsert = `INSERT INTO ${schema}.provider_tracking_cache
      (provider_account, provider_environment, request_key, result, error, fetched_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, now(), now() + interval '1 minute')`;
    await client.query(trackingInsert, ["account-a", "live", "request", { data: {} }, null]);
    await client.query(trackingInsert, ["account-a", "sandbox", "request", null, { message: "Unavailable", status: 502 }]);
    await client.query(trackingInsert, ["account-b", "live", "request", { data: {} }, null]);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.provider_tracking_cache`)).rows[0].count, 3);
    await rejects(trackingInsert, ["account-a", "live", "request", { data: {} }, null], "23505");
    await rejects(trackingInsert, ["account-a", "live", "none", null, null], "23514");
    await rejects(trackingInsert, ["account-a", "live", "both", {}, {}], "23514");
    await rejects(trackingInsert, ["account-a", "live", "bad", "[]", null], "23514");
    await rejects(trackingInsert, ["account-a ", "live", "request", {}, null], "23514");
    await rejects(`INSERT INTO ${schema}.provider_tracking_cache
      (provider_account, provider_environment, request_key, result, fetched_at, expires_at)
      VALUES ('account-a', 'live', 'expired', '{}', now(), now())`, [], "23514");

    const portInsert = `INSERT INTO ${schema}.provider_port_cache
      (provider_account, provider_environment, port_code, result, source, fetched_at, expires_at)
      VALUES ($1, $2, $3, '{}', $4, now(), now() + interval '1 hour')`;
    await client.query(portInsert, ["account-a", "live", "SGSIN", "live"]);
    await client.query(portInsert, ["account-a", "sandbox", "SGSIN", "mock"]);
    await rejects(portInsert, ["account-a", "live", "sgsin", "live"], "23514");
    await rejects(portInsert, ["account-a", "live", "SGSIN", "live"], "23505");

    await client.query(`INSERT INTO ${schema}.provider_usage (provider_account, provider_environment, month_start, monthly_count, blocked_until)
      VALUES ('account-a', 'live', '2026-11-01', 5, '2026-11-02T00:00:00Z'),
             ('account-a', 'sandbox', '2026-11-01', 0, NULL)`);
    const usage = await client.query(`SELECT monthly_count::int, blocked_until FROM ${schema}.provider_usage
      WHERE provider_account = 'account-a' AND provider_environment = 'live'`);
    assert.equal(usage.rows[0].monthly_count, 5);
    assert.equal(usage.rows[0].blocked_until.toISOString(), "2026-11-02T00:00:00.000Z");
    await rejects(`INSERT INTO ${schema}.provider_usage (provider_account, provider_environment, month_start, monthly_count)
      VALUES ('account-b', 'live', '2026-11-01', -1)`, [], "23514");
    await rejects(`INSERT INTO ${schema}.provider_usage (provider_account, provider_environment, month_start)
      VALUES ('account-b', 'live', '2026-11-02')`, [], "23514");
    const eventInsert = `INSERT INTO ${schema}.provider_request_events (provider_account, provider_environment, request_id, requested_at)
      VALUES ($1, $2, $3, '2026-11-02T00:00:00Z')`;
    await client.query(eventInsert, ["account-a", "live", "request-1"]);
    await client.query(eventInsert, ["account-a", "live", "request-2"]);
    await client.query(eventInsert, ["account-a", "sandbox", "request-1"]);
    await rejects(eventInsert, ["account-a", "live", "request-1"], "23505");
    await rejects(eventInsert, ["account-b", "live", "request-1"], "23503");
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${schema}.provider_request_events WHERE provider_account = 'account-a' AND provider_environment = 'live'`)).rows[0].count, 2);

    const leaseInsert = `INSERT INTO ${schema}.provider_fetch_leases
      (provider_account, provider_environment, cache_kind, cache_key, lease_id, state, started_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, now(), now() + interval '1 minute')`;
    const leaseId = randomUUID();
    await client.query(leaseInsert, ["account-a", "live", "tracking", "request", leaseId, "active"]);
    await rejects(leaseInsert, ["account-a", "live", "tracking", "request", randomUUID(), "active"], "23505");
    await rejects(leaseInsert, ["account-a", "sandbox", "tracking", "request", leaseId, "active"], "23505");
    await rejects(leaseInsert, ["account-a", "live", "invalid", "request", randomUUID(), "active"], "23514");
    await rejects(leaseInsert, ["account-a", "live", "port", "request", randomUUID(), "invalid"], "23514");

    const indexes = (await client.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1", [schema])).rows;
    for (const [name, columns] of [
      ["provider_tracking_cache_expiry_idx", "(expires_at)"],
      ["provider_port_cache_expiry_idx", "(expires_at)"],
      ["provider_request_events_window_idx", "(provider_account, provider_environment, requested_at)"],
      ["provider_request_events_expiry_idx", "(requested_at)"],
      ["provider_fetch_leases_expiry_idx", "(expires_at)"],
      ["provider_port_retries_due_idx", "(provider_account, provider_environment, due_at)"]
    ]) assert.ok(indexes.some((index) => index.indexname === name && index.indexdef.includes(columns)), `Missing index ${name}`);
  } finally {
    if (started) await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});

test("provider schema initialization verifies compatibility and cleanup preserves active quota state", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `provider_test_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  try {
    await initializeProviderCacheSchema(pool, schema);
    created = true;
    await initializeProviderCacheSchema(pool, schema);
    await verifyProviderCacheSchema(pool, schema);
    await checkProviderCacheReadiness(pool, schema);

    await pool.query(`INSERT INTO ${schema}.provider_usage (provider_account, provider_environment, month_start, monthly_count, blocked_until)
      VALUES ('account', 'live', '2026-11-01', 9, now() + interval '1 hour')`);
    await pool.query(`INSERT INTO ${schema}.provider_tracking_cache (provider_account, provider_environment, request_key, result, fetched_at, expires_at)
      SELECT 'account', 'live', 'expired-' || n, '{}', now() - interval '2 hours', now() - interval '1 hour' FROM generate_series(1, 1001) AS n`);
    await pool.query(`INSERT INTO ${schema}.provider_tracking_cache (provider_account, provider_environment, request_key, result, fetched_at, expires_at)
      VALUES ('account', 'live', 'fresh', '{}', now(), now() + interval '1 hour')`);
    await pool.query(`INSERT INTO ${schema}.provider_port_cache (provider_account, provider_environment, port_code, result, source, fetched_at, expires_at)
      VALUES ('account', 'live', 'SGSIN', '{}', 'live', now() - interval '2 hours', now() - interval '1 hour'),
             ('account', 'live', 'LKCMB', '{}', 'live', now(), now() + interval '1 hour')`);
    await pool.query(`INSERT INTO ${schema}.provider_request_events (provider_account, provider_environment, request_id, requested_at)
      VALUES ('account', 'live', 'old', now() - interval '2 minutes'),
             ('account', 'live', 'recent', now() + interval '1 minute')`);
    assert.deepEqual(await cleanupExpiredProviderCache(pool, schema), {
      provider_tracking_cache: 1000, provider_port_cache: 1, provider_request_events: 1
    });
    assert.deepEqual(await cleanupExpiredProviderCache(pool, schema), {
      provider_tracking_cache: 1, provider_port_cache: 0, provider_request_events: 0
    });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_tracking_cache`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_port_cache`)).rows[0].count, 1);
    assert.deepEqual((await pool.query(`SELECT request_id FROM ${schema}.provider_request_events`)).rows.map((row) => row.request_id), ["recent"]);
    const usage = (await pool.query(`SELECT monthly_count::int, blocked_until > now() AS blocked FROM ${schema}.provider_usage`)).rows[0];
    assert.deepEqual(usage, { monthly_count: 9, blocked: true });

    await pool.query(`INSERT INTO ${schema}.provider_tracking_cache (provider_account, provider_environment, request_key, result, fetched_at, expires_at)
      VALUES ('account', 'live', 'rollback', '{}', now() - interval '2 hours', now() - interval '1 hour')`);
    await pool.query(`ALTER TABLE ${schema}.provider_port_cache RENAME TO provider_port_cache_unavailable`);
    try {
      await assert.rejects(checkProviderCacheReadiness(pool, schema), /missing table provider_port_cache/);
      await assert.rejects(cleanupExpiredProviderCache(pool, schema), { code: "42P01" });
      assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_tracking_cache WHERE request_key = 'rollback'`)).rows[0].count, 1);
    } finally {
      await pool.query(`ALTER TABLE ${schema}.provider_port_cache_unavailable RENAME TO provider_port_cache`);
    }

    const deniedClient = {
      async query(sql, params) {
        const result = await pool.query(sql, params);
        if (sql.includes("has_table_privilege")) {
          assert.deepEqual(result.rows.map((row) => `${row.table_name}:${row.privilege}`).sort(), [
            "provider_port_cache:DELETE", "provider_port_cache:INSERT", "provider_port_cache:SELECT", "provider_port_cache:UPDATE",
            "provider_request_events:DELETE", "provider_request_events:INSERT", "provider_request_events:SELECT",
            "provider_fetch_leases:DELETE", "provider_fetch_leases:INSERT", "provider_fetch_leases:SELECT", "provider_fetch_leases:UPDATE",
            "provider_port_retries:DELETE", "provider_port_retries:INSERT", "provider_port_retries:SELECT", "provider_port_retries:UPDATE",
            "provider_tracking_cache:DELETE", "provider_tracking_cache:INSERT", "provider_tracking_cache:SELECT", "provider_tracking_cache:UPDATE",
            "provider_usage:INSERT", "provider_usage:SELECT", "provider_usage:UPDATE"
          ].sort());
          const entry = result.rows.find((row) => row.table_name === "provider_request_events" && row.privilege === "DELETE");
          assert.ok(entry);
          entry.allowed = false;
        }
        return result;
      }
    };
    await assert.rejects(verifyProviderCacheSchema(deniedClient, schema), /lacks DELETE on provider_request_events/);
    await pool.query(`ALTER TABLE ${schema}.provider_usage ENABLE ROW LEVEL SECURITY`);
    await assert.rejects(verifyProviderCacheSchema(pool, schema), /row security enabled on provider_usage/);
    await assert.rejects(checkProviderCacheReadiness(pool, schema), /row security enabled on provider_usage/);
    await pool.query(`ALTER TABLE ${schema}.provider_usage DISABLE ROW LEVEL SECURITY`);
    await pool.query(`DROP INDEX ${schema}.provider_request_events_window_idx`);
    await pool.query(`CREATE INDEX provider_request_events_window_idx ON ${schema}.provider_request_events (requested_at)`);
    await assert.rejects(verifyProviderCacheSchema(pool, schema), /invalid index provider_request_events_window_idx/);
    await pool.query(`DROP INDEX ${schema}.provider_port_cache_expiry_idx`);
    await assert.rejects(initializeProviderCacheSchema(pool, schema), /invalid index provider_request_events_window_idx/);
    assert.equal((await pool.query("SELECT to_regclass($1) AS index_name", [`${schema}.provider_port_cache_expiry_idx`])).rows[0].index_name, null);
    await pool.query(`DROP INDEX ${schema}.provider_request_events_window_idx`);
    await initializeProviderCacheSchema(pool, schema);
    await verifyProviderCacheSchema(pool, schema);
    assert.equal((await pool.query(`SELECT monthly_count::int FROM ${schema}.provider_usage`)).rows[0].monthly_count, 9);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
