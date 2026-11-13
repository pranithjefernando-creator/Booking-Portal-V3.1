import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { initializeProviderCacheSchema } from "../src/lib/providerCacheSchema.js";
import { createProviderCacheStore } from "../src/lib/providerCacheStore.js";
import { createProviderFetchLeaseStore } from "../src/lib/providerFetchCoordination.js";
import { listUncertainProviderFetches, releaseUncertainProviderFetch } from "../src/lib/providerFetchReview.js";

test("processes coordinate cache misses and require review for uncertain requests", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `provider_test_${randomUUID().replaceAll("-", "")}`;
  const translate = (sql) => sql.replaceAll("booking_portal_v4.", `${schema}.`);
  const scoped = {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
    }
  };
  const scope = { account: "account-a", environment: "sandbox", apiKey: "test-key" };
  const leases = createProviderFetchLeaseStore(scoped, () => scope);
  const cache = createProviderCacheStore(scoped, () => scope);
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
    await pool.query(`CREATE TABLE ${schema}.audit_events (
      id text PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), actor_id text, actor_name text NOT NULL,
      actor_role text NOT NULL, action text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL, before_data jsonb, after_data jsonb)`);

    const results = await Promise.all([child("tracking"), child("tracking"), child("port"), child("port")]);
    assert.ok(results.every((result) => !result.code), JSON.stringify(results));
    assert.deepEqual(results.slice(0, 2).map((result) => result.cached).sort(), [false, true]);
    assert.deepEqual(results.slice(2).map((result) => result.cached).sort(), [false, true]);
    assert.deepEqual((await pool.query(`SELECT kind, count(*)::int AS count FROM ${schema}.test_provider_calls GROUP BY kind ORDER BY kind`)).rows,
      [{ kind: "port", count: 1 }, { kind: "tracking", count: 1 }]);
    assert.equal((await pool.query(`SELECT monthly_count::int FROM ${schema}.provider_usage`)).rows[0].monthly_count, 2);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_fetch_leases`)).rows[0].count, 0);

    await pool.query(`DELETE FROM ${schema}.provider_tracking_cache`);
    await assert.rejects(child("tracking", "crash"), { code: 44 });
    const active = (await pool.query(`SELECT lease_id FROM ${schema}.provider_fetch_leases WHERE cache_kind = 'tracking'`)).rows[0];
    await assert.rejects(releaseUncertainProviderFetch(scoped, { id: active.lease_id, operator: "reviewer", notes: "Checked provider", workerStopped: true }), /not found/);
    await pool.query(`UPDATE ${schema}.provider_fetch_leases
      SET started_at = clock_timestamp() - interval '2 minutes', expires_at = clock_timestamp() - interval '1 minute'
      WHERE lease_id = $1`, [active.lease_id]);
    const blocked = await child("tracking");
    assert.equal(blocked.code, "PROVIDER_REQUEST_UNCERTAIN");
    assert.match(blocked.message, /may have been billed/);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'tracking'`)).rows[0].count, 2);
    assert.equal((await listUncertainProviderFetches(scoped))[0].id, active.lease_id);
    await assert.rejects(releaseUncertainProviderFetch(scoped, { id: active.lease_id, operator: "reviewer", notes: "Checked provider", workerStopped: false }), /worker has stopped/);
    await pool.query(`ALTER TABLE ${schema}.audit_events RENAME TO audit_unavailable`);
    await assert.rejects(releaseUncertainProviderFetch(scoped, { id: active.lease_id, operator: "reviewer", notes: "Checked provider", workerStopped: true }));
    assert.equal((await listUncertainProviderFetches(scoped))[0].id, active.lease_id);
    await pool.query(`ALTER TABLE ${schema}.audit_unavailable RENAME TO audit_events`);
    await releaseUncertainProviderFetch(scoped, { id: active.lease_id, operator: "reviewer", notes: "Checked provider and accepted retry cost", workerStopped: true });
    const audit = (await pool.query(`SELECT actor_name, action, entity_id, after_data FROM ${schema}.audit_events`)).rows[0];
    assert.equal(audit.actor_name, "reviewer");
    assert.equal(audit.action, "PROVIDER_FETCH_RETRY_APPROVED");
    assert.equal(audit.entity_id, active.lease_id);
    assert.match(audit.after_data.notes, /accepted retry cost/);
    assert.equal((await child("tracking")).cached, false);
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'tracking'`)).rows[0].count, 3);

    await pool.query(`DELETE FROM ${schema}.provider_tracking_cache`);
    const errors = await Promise.all([child("tracking", "not-found"), child("tracking", "not-found")]);
    assert.ok(errors.every((result) => result.code === "NOT_FOUND"));
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'tracking'`)).rows[0].count, 4);
    await pool.query(`DELETE FROM ${schema}.provider_tracking_cache`);
    assert.equal((await child("tracking", "body-timeout")).code, "PROVIDER_REQUEST_UNCERTAIN");
    assert.equal((await child("tracking")).code, "PROVIDER_REQUEST_UNCERTAIN");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'tracking'`)).rows[0].count, 5);

    await pool.query(`DELETE FROM ${schema}.provider_port_cache`);
    const timedOut = await child("port", "timeout");
    assert.equal(timedOut.code, "PROVIDER_REQUEST_UNCERTAIN");
    const blockedPort = await child("port");
    assert.equal(blockedPort.code, "PROVIDER_REQUEST_UNCERTAIN");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'port'`)).rows[0].count, 2);

    const late = await leases.claim("port", "LKCMB", 3000);
    assert.equal(late.owner, true);
    let writeStarted = false;
    await assert.rejects(leases.complete(late.id, async (client) => {
      writeStarted = true;
      await client.query("SELECT pg_sleep(3.2)");
      await cache.putPort("LKCMB", { unloco: "LKCMB", source: "live" }, Date.now(), 60000, client);
    }), { code: "PROVIDER_REQUEST_UNCERTAIN" });
    assert.equal(writeStarted, true);
    assert.equal(await cache.getPort("LKCMB"), null);
    await releaseUncertainProviderFetch(scoped, { id: late.id, operator: "reviewer", notes: "Late worker stopped", workerStopped: true });
    const replacement = await leases.claim("port", "LKCMB", 60000);
    await leases.complete(replacement.id, (client) => cache.putPort("LKCMB", { unloco: "LKCMB", source: "live", revision: 2 }, Date.now(), 60000, client));
    await assert.rejects(leases.complete(late.id, (client) => cache.putPort("LKCMB", { unloco: "LKCMB", source: "live", revision: 1 }, Date.now(), 60000, client)), { code: "PROVIDER_REQUEST_UNCERTAIN" });
    assert.equal((await cache.getPort("LKCMB")).result.revision, 2);

    const firstScope = await leases.claim("port", "AEDXB", 60000);
    scope.account = "account-b";
    const secondScope = await leases.claim("port", "AEDXB", 60000);
    scope.account = "account-a";
    scope.environment = "production";
    const thirdScope = await leases.claim("port", "AEDXB", 60000);
    assert.equal(firstScope.owner && secondScope.owner && thirdScope.owner, true);
    await leases.cancel(firstScope.id);
    await leases.cancel(secondScope.id);
    await leases.cancel(thirdScope.id);
    await pool.query(`ALTER TABLE ${schema}.provider_fetch_leases RENAME TO leases_unavailable`);
    await assert.rejects(leases.claim("port", "AEDXB", 60000), { code: "PROVIDER_COORDINATION_UNAVAILABLE" });
    assert.equal((await child("port")).code, "PROVIDER_COORDINATION_UNAVAILABLE");
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls WHERE kind = 'port'`)).rows[0].count, 2);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});

test("mock provider results, backoff and quota boundaries survive process restarts", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `provider_test_${randomUUID().replaceAll("-", "")}`;
  const script = fileURLToPath(new URL("./fixtures/providerCoordinationProcess.js", import.meta.url));
  const child = async (kind, behavior = "success", reference = "04445428036", overrides = {}) => {
    const { stdout } = await promisify(execFile)(process.execPath, [script, kind, behavior, reference], {
      env: { ...process.env, TEST_PROVIDER_SCHEMA: schema, TEST_PROVIDER_ACCOUNT: "account-a", TEST_RATE_LIMIT: "100", TEST_MONTHLY_QUOTA: "1000", ...overrides }
    });
    return JSON.parse(stdout.trim());
  };
  const calls = async () => (await pool.query(`SELECT count(*)::int AS count FROM ${schema}.test_provider_calls`)).rows[0].count;
  let created = false;
  try {
    await initializeProviderCacheSchema(pool, schema);
    created = true;
    await pool.query(`CREATE TABLE ${schema}.test_provider_calls (kind text NOT NULL)`);

    assert.equal((await child("tracking")).cached, false);
    assert.equal((await child("tracking", "timeout")).cached, true);
    assert.equal((await child("port")).cached, false);
    assert.equal((await child("port", "timeout")).cached, true);
    assert.equal(await calls(), 2);
    await pool.query(`UPDATE ${schema}.provider_tracking_cache SET fetched_at = clock_timestamp() - interval '2 minutes', expires_at = clock_timestamp() - interval '1 minute'`);
    await pool.query(`UPDATE ${schema}.provider_port_cache SET fetched_at = clock_timestamp() - interval '2 minutes', expires_at = clock_timestamp() - interval '1 minute'`);
    assert.equal((await child("tracking")).cached, false);
    assert.equal((await child("port")).cached, false);
    assert.equal(await calls(), 4);

    const missing = "04400000001";
    assert.equal((await child("tracking", "not-found", missing)).code, "NOT_FOUND");
    assert.equal((await child("tracking", "success", missing)).code, "NOT_FOUND");
    assert.equal(await calls(), 5);
    await pool.query(`UPDATE ${schema}.provider_tracking_cache SET fetched_at = clock_timestamp() - interval '2 minutes', expires_at = clock_timestamp() - interval '1 minute' WHERE error IS NOT NULL`);
    assert.equal((await child("tracking", "success", missing)).cached, false);
    assert.equal(await calls(), 6);

    const backoff = { TEST_PROVIDER_ACCOUNT: "backoff-account" };
    assert.equal((await child("tracking", "rate-limit", "04400000002", backoff)).code, "UPSTREAM_LIMIT");
    assert.equal((await child("tracking", "success", "04400000003", backoff)).code, "RATE_LIMIT_EXCEEDED");
    assert.equal(await calls(), 7);
    const blocked = (await pool.query(`SELECT blocked_until > clock_timestamp() + interval '100 seconds' AS active, monthly_count::int
      FROM ${schema}.provider_usage WHERE provider_account = 'backoff-account'`)).rows[0];
    assert.deepEqual(blocked, { active: true, monthly_count: 1 });
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second' WHERE provider_account = 'backoff-account'`);
    assert.equal((await child("tracking", "success", "04400000004", backoff)).cached, false);
    assert.equal(await calls(), 8);

    for (const [account, minuteLimit, monthlyQuota] of [["minute-account", "2", "10"], ["month-account", "10", "2"]]) {
      const options = { TEST_PROVIDER_ACCOUNT: account, TEST_RATE_LIMIT: minuteLimit, TEST_MONTHLY_QUOTA: monthlyQuota };
      const before = await calls();
      const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
        child("tracking", "success", `044${String(index + 10).padStart(8, "0")}`, options)));
      assert.equal(results.filter((result) => result.cached === false).length, 2, JSON.stringify(results));
      assert.equal(results.filter((result) => result.code === "RATE_LIMIT_EXCEEDED").length, 3, JSON.stringify(results));
      assert.equal(await calls(), before + 2);
      const usage = (await pool.query(`SELECT monthly_count::int,
        (SELECT count(*)::int FROM ${schema}.provider_request_events e WHERE e.provider_account = u.provider_account) AS events
        FROM ${schema}.provider_usage u WHERE provider_account = $1`, [account])).rows[0];
      assert.deepEqual(usage, { monthly_count: 2, events: 2 });
    }

    await pool.query(`UPDATE ${schema}.provider_request_events SET requested_at = clock_timestamp() - interval '61 seconds' WHERE provider_account = 'minute-account'`);
    assert.equal((await child("tracking", "success", "04400000020", { TEST_PROVIDER_ACCOUNT: "minute-account", TEST_RATE_LIMIT: "2", TEST_MONTHLY_QUOTA: "10" })).cached, false);
    assert.equal((await child("tracking", "success", "04400000020", { TEST_PROVIDER_ACCOUNT: "month-account", TEST_RATE_LIMIT: "10", TEST_MONTHLY_QUOTA: "2" })).code, "RATE_LIMIT_EXCEEDED");
    assert.equal(await calls(), 13);

    await pool.query(`ALTER TABLE ${schema}.provider_usage RENAME TO usage_unavailable`);
    assert.equal((await child("tracking", "success", "04400000030", { TEST_PROVIDER_ACCOUNT: "failure-account" })).code, "PROVIDER_QUOTA_UNAVAILABLE");
    assert.equal((await child("port", "success", "", { TEST_PROVIDER_ACCOUNT: "failure-account" })).code, "PROVIDER_QUOTA_UNAVAILABLE");
    assert.equal(await calls(), 13);
  } finally {
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
