import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { initializeProviderCacheSchema } from "../src/lib/providerCacheSchema.js";

test("port retries persist, coordinate across processes, and fail closed on database errors", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `provider_test_${randomUUID().replaceAll("-", "")}`;
  const script = fileURLToPath(new URL("./fixtures/providerCoordinationProcess.js", import.meta.url));
  const child = async (kind, behavior = "success") => {
    const { stdout } = await promisify(execFile)(process.execPath, [script, kind, behavior], {
      env: { ...process.env, TEST_PROVIDER_SCHEMA: schema }
    });
    return JSON.parse(stdout.trim());
  };
  let created = false;
  try {
    await initializeProviderCacheSchema(pool, schema);
    created = true;
    await pool.query(`CREATE TABLE ${schema}.test_provider_calls (kind text NOT NULL)`);
    await pool.query(`INSERT INTO ${schema}.provider_usage (provider_account, provider_environment, month_start, blocked_until)
      VALUES ('account-a', 'sandbox', date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date, clock_timestamp() + interval '2 minutes')`);

    const limited = await child("port");
    assert.equal(limited.source, "rate-limited");
    const scheduled = (await pool.query(`SELECT r.cache_fetched_at = c.fetched_at AS same_cache,
      r.due_at > clock_timestamp() + interval '50 seconds' AS delayed
      FROM ${schema}.provider_port_retries r JOIN ${schema}.provider_port_cache c USING (provider_account, provider_environment, port_code)`)).rows[0];
    assert.deepEqual(scheduled, { same_cache: true, delayed: true });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 0);

    await pool.query(`UPDATE ${schema}.provider_port_retries SET due_at = clock_timestamp() - interval '1 second'`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second'`);
    assert.deepEqual(await Promise.all([child("retry"), child("retry")]), [{ complete: true }, { complete: true }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'retry'`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT monthly_count::int FROM ${schema}.provider_usage`)).rows[0].monthly_count, 1);
    assert.equal((await pool.query(`SELECT source FROM ${schema}.provider_port_cache`)).rows[0].source, "live");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_port_retries`)).rows[0].count, 0);

    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() + interval '2 minutes'`);
    assert.equal((await child("port")).source, "rate-limited");
    await pool.query(`UPDATE ${schema}.provider_port_retries SET due_at = clock_timestamp() - interval '1 second'`);
    await pool.query(`UPDATE ${schema}.provider_port_cache SET source = 'live', result = '{"unloco":"SGSIN","source":"live"}',
      fetched_at = clock_timestamp() - interval '2 hours', expires_at = clock_timestamp() - interval '1 hour'`);
    await child("retry");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_port_retries`)).rows[0].count, 0);

    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() + interval '2 minutes'`);
    assert.equal((await child("port")).source, "rate-limited");
    await pool.query(`UPDATE ${schema}.provider_port_retries SET due_at = clock_timestamp() - interval '1 second'`);
    await Promise.all([child("retry"), child("retry")]);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_port_retries`)).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT source FROM ${schema}.provider_port_cache`)).rows[0].source, "rate-limited");

    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    assert.equal((await child("port")).source, "rate-limited");
    await pool.query(`UPDATE ${schema}.provider_port_retries SET due_at = clock_timestamp() - interval '1 second'`);
    await pool.query(`ALTER TABLE ${schema}.provider_usage RENAME TO usage_unavailable`);
    await child("retry");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_port_retries`)).rows[0].count, 1);
    await pool.query(`ALTER TABLE ${schema}.usage_unavailable RENAME TO provider_usage`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second'`);
    await child("retry");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 2);
    assert.equal((await pool.query(`SELECT monthly_count::int FROM ${schema}.provider_usage`)).rows[0].monthly_count, 2);

    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() + interval '2 minutes'`);
    assert.equal((await child("port")).source, "rate-limited");
    await pool.query(`UPDATE ${schema}.provider_port_retries SET due_at = clock_timestamp() - interval '1 second'`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second'`);
    await child("retry", "timeout");
    assert.equal((await pool.query(`SELECT state FROM ${schema}.provider_fetch_leases WHERE cache_kind = 'port'`)).rows[0].state, "uncertain");
    await child("retry");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 3);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_port_retries`)).rows[0].count, 1);
    assert.equal((await pool.query(`SELECT monthly_count::int FROM ${schema}.provider_usage`)).rows[0].monthly_count, 3);

    await pool.query(`DELETE FROM ${schema}.provider_fetch_leases`);
    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() + interval '2 minutes'`);
    assert.equal((await child("port")).source, "rate-limited");
    await pool.query(`UPDATE ${schema}.provider_port_retries SET due_at = clock_timestamp() - interval '1 second'`);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second'`);
    const overlapping = await child("retry-overlap");
    assert.equal(overlapping.lookup.source, "rate-limited");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 4);

    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    await pool.query(`ALTER TABLE ${schema}.provider_port_cache RENAME TO cache_unavailable`);
    assert.equal((await child("port")).code, "PROVIDER_CACHE_UNAVAILABLE");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count, 4);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
