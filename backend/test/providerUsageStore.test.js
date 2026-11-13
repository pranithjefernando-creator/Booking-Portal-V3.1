import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { initializeProviderCacheSchema } from "../src/lib/providerCacheSchema.js";
import { createProviderUsageStore, providerUsageStore } from "../src/lib/providerUsageStore.js";
import { providerCacheStore } from "../src/lib/providerCacheStore.js";
import { memoryProviderCacheStore } from "./fixtures/memoryProviderCacheStore.js";
import { config } from "../src/lib/config.js";
import { panvayaRequest } from "../src/lib/panvayaClient.js";
import { getTracking, trackingIdentity } from "../src/lib/trackingCache.js";
import { getPortCongestion } from "../src/lib/portCongestionCache.js";
import { providerFetchLeaseStore } from "../src/lib/providerFetchCoordination.js";
import { memoryProviderFetchLeaseStore } from "./fixtures/memoryProviderFetchLeaseStore.js";
import { providerPortRetryStore } from "../src/lib/providerPortRetryStore.js";
import { memoryProviderPortRetryStore } from "./fixtures/memoryProviderPortRetryStore.js";

test("quota reservations and provider backoff are atomic and durable", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
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
  const storeA = createProviderUsageStore(scoped, () => scope);
  const storeB = createProviderUsageStore(scoped, () => scope);
  const originalUsage = { ...providerUsageStore };
  const originalCache = { ...providerCacheStore };
  const originalLeases = { ...providerFetchLeaseStore };
  const originalRetries = { ...providerPortRetryStore };
  const settings = { ...config.freightPulse };
  const originalFetch = globalThis.fetch;
  let created = false;
  try {
    await initializeProviderCacheSchema(pool, schema);
    created = true;
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      (index % 2 ? storeA : storeB).reserve(3, 100)));
    assert.equal(attempts.filter(Boolean).length, 3);
    assert.deepEqual(await storeB.stats(), { callsThisMonth: 3, callsLastMinute: 3 });
    assert.equal((await pool.query(`SELECT count(*)::int AS count FROM ${schema}.provider_request_events`)).rows[0].count, 3);
    await pool.query(`UPDATE ${schema}.provider_request_events SET requested_at = clock_timestamp() - interval '61 seconds'`);
    assert.deepEqual(await storeA.stats(), { callsThisMonth: 3, callsLastMinute: 0 });
    assert.equal(await storeB.reserve(10, 3), null);

    scope.account = "account-b";
    assert.ok(await storeA.reserve(3, 3));
    scope.account = "account-a";
    scope.environment = "production";
    assert.deepEqual(await storeA.stats(), { callsThisMonth: 0, callsLastMinute: 0 });
    assert.ok(await storeB.reserve(3, 3));
    scope.environment = "sandbox";
    assert.deepEqual(await storeB.stats(), { callsThisMonth: 3, callsLastMinute: 0 });

    await pool.query(`UPDATE ${schema}.provider_usage
      SET month_start = (date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - interval '1 month')::date, monthly_count = 99
      WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`);
    assert.deepEqual(await storeA.stats(), { callsThisMonth: 0, callsLastMinute: 0 });
    assert.ok(await storeA.reserve(3, 3));
    assert.deepEqual(await storeB.stats(), { callsThisMonth: 1, callsLastMinute: 1 });
    const storedMonth = (await pool.query(`SELECT month_start = date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date AS current
      FROM ${schema}.provider_usage WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`)).rows[0];
    assert.equal(storedMonth.current, true);

    Object.assign(providerUsageStore, storeA);
    Object.assign(providerCacheStore, memoryProviderCacheStore());
    Object.assign(providerFetchLeaseStore, memoryProviderFetchLeaseStore());
    Object.assign(providerPortRetryStore, memoryProviderPortRetryStore());
    Object.assign(config.freightPulse, { apiKey: "test-key", mode: "live", baseUrl: "https://api.panvaya.com/api/v1", rateLimitPerMin: 100, monthlyQuota: 100 });
    let calls = 0;
    scope.account = "concurrent-calls";
    config.freightPulse.rateLimitPerMin = 3;
    globalThis.fetch = async () => { calls++; return new Response("{}"); };
    const requests = await Promise.allSettled(Array.from({ length: 10 }, () => panvayaRequest("/track/air", {})));
    assert.equal(requests.filter((result) => result.status === "fulfilled").length, 3);
    assert.equal(requests.filter((result) => result.status === "rejected" && result.reason.code === "RATE_LIMIT_EXCEEDED").length, 7);
    assert.equal(calls, 3);
    assert.deepEqual(await storeB.stats(), { callsThisMonth: 3, callsLastMinute: 3 });
    scope.account = "account-a";
    config.freightPulse.rateLimitPerMin = 100;
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ code: "UPSTREAM_LIMIT", detail: "Slow down" }] }), { status: 429, headers: { "Retry-After": "120" } });
    };
    await assert.rejects(panvayaRequest("/track/air", {}), { status: 429, code: "UPSTREAM_LIMIT" });
    assert.equal(calls, 1);
    await assert.rejects(panvayaRequest("/track/air", {}), { status: 429, code: "RATE_LIMIT_EXCEEDED" });
    assert.equal(calls, 1);
    const beforeRow = (await pool.query(`SELECT blocked_until, blocked_until > clock_timestamp() + interval '110 seconds' AS sufficiently_blocked FROM ${schema}.provider_usage
      WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`)).rows[0];
    assert.equal(beforeRow.sufficiently_blocked, true);
    const before = beforeRow.blocked_until;
    await storeB.recordBackoff({ account: "account-a", environment: "sandbox" }, 1000);
    const after = (await pool.query(`SELECT blocked_until FROM ${schema}.provider_usage
      WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`)).rows[0].blocked_until;
    assert.equal(after.getTime(), before.getTime());

    const childScript = `
      import { createBookingPool } from './backend/src/lib/bookingStore.js';
      import { createProviderUsageStore } from './backend/src/lib/providerUsageStore.js';
      const schema = process.env.TEST_PROVIDER_SCHEMA;
      if (!/^provider_test_[a-f0-9]{32}$/.test(schema)) throw new Error('Invalid schema');
      const pool = createBookingPool();
      const translate = (sql) => sql.replaceAll('booking_portal_v4.', schema + '.');
      const scoped = { query: (sql, params) => pool.query(translate(sql), params), async connect() {
        const client = await pool.connect();
        return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
      } };
      const store = createProviderUsageStore(scoped, () => ({ account: 'account-a', environment: 'sandbox' }));
      try { console.log(JSON.stringify({ stats: await store.stats(), reservation: await store.reserve(100, 100) })); }
      finally { await pool.end(); }
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", childScript], {
      cwd: fileURLToPath(new URL("../..", import.meta.url)), env: { ...process.env, TEST_PROVIDER_SCHEMA: schema }
    });
    const restarted = JSON.parse(stdout.trim());
    assert.deepEqual(restarted.stats, { callsThisMonth: 2, callsLastMinute: 2 });
    assert.equal(restarted.reservation, null);

    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second'
      WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`);
    assert.ok(await storeB.reserve(100, 100));
    const countBeforeFailure = (await storeB.stats()).callsThisMonth;
    globalThis.fetch = async () => { calls++; throw new Error("simulated network failure"); };
    await assert.rejects(panvayaRequest("/track/air", {}), { code: "PROVIDER_REQUEST_UNCERTAIN" });
    assert.equal((await storeB.stats()).callsThisMonth, countBeforeFailure + 1);
    globalThis.fetch = async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ code: "UPSTREAM_LIMIT", detail: "Slow down" }] }), { status: 429 });
    };
    await assert.rejects(panvayaRequest("/track/air", {}), { status: 429, code: "UPSTREAM_LIMIT" });
    const defaultBackoff = (await pool.query(`SELECT blocked_until > clock_timestamp() + interval '50 seconds' AS active
      FROM ${schema}.provider_usage WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`)).rows[0];
    assert.equal(defaultBackoff.active, true);
    await pool.query(`UPDATE ${schema}.provider_usage SET blocked_until = clock_timestamp() - interval '1 second'
      WHERE provider_account = 'account-a' AND provider_environment = 'sandbox'`);
    const quotaFailure = Object.assign(new Error("Provider quota accounting is unavailable"), { status: 503, code: "PROVIDER_QUOTA_UNAVAILABLE" });
    providerUsageStore.reserve = async () => { throw quotaFailure; };
    await assert.rejects(getTracking({ mode: "AIR", awb: "04445428036" }), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    assert.equal(await providerCacheStore.getTracking(JSON.stringify(trackingIdentity({ mode: "AIR", awb: "04445428036" }))), null);
    await assert.rejects(getPortCongestion(["SGSIN"]), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    assert.equal(calls, 3);
    Object.assign(providerUsageStore, storeA);
    providerUsageStore.recordBackoff = async () => { throw quotaFailure; };
    await assert.rejects(panvayaRequest("/track/air", {}), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    assert.equal(calls, 4);

    scope.account = "";
    await assert.rejects(storeA.reserve(1, 1), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    scope.account = "test-key";
    await assert.rejects(storeA.stats(), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    scope.account = "account-a";
    await pool.query(`ALTER TABLE ${schema}.provider_usage RENAME TO usage_unavailable`);
    await assert.rejects(storeB.reserve(100, 100), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    await assert.rejects(storeB.stats(), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
    await assert.rejects(storeB.recordBackoff({ account: "account-a", environment: "sandbox" }, 60000), { code: "PROVIDER_QUOTA_UNAVAILABLE" });
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.freightPulse, settings);
    Object.assign(providerUsageStore, originalUsage);
    Object.assign(providerCacheStore, originalCache);
    Object.assign(providerFetchLeaseStore, originalLeases);
    Object.assign(providerPortRetryStore, originalRetries);
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
