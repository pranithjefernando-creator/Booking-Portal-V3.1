import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { initializeProviderCacheSchema } from "../src/lib/providerCacheSchema.js";
import { createProviderCacheStore, providerCacheStore } from "../src/lib/providerCacheStore.js";
import { config } from "../src/lib/config.js";
import { getTracking, trackingIdentity } from "../src/lib/trackingCache.js";
import { getPortCongestion, cacheStats } from "../src/lib/portCongestionCache.js";
import { providerUsageStore } from "../src/lib/providerUsageStore.js";
import { memoryProviderUsageStore } from "./fixtures/memoryProviderUsageStore.js";
import { providerFetchLeaseStore } from "../src/lib/providerFetchCoordination.js";
import { memoryProviderFetchLeaseStore } from "./fixtures/memoryProviderFetchLeaseStore.js";
import { providerPortRetryStore } from "../src/lib/providerPortRetryStore.js";
import { memoryProviderPortRetryStore } from "./fixtures/memoryProviderPortRetryStore.js";

test("PostgreSQL caches preserve identities, errors, expiry, isolation and failures", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const schema = `provider_test_${randomUUID().replaceAll("-", "")}`;
  const scoped = { query: (sql, params) => pool.query(sql.replaceAll("booking_portal_v4.", `${schema}.`), params) };
  const scope = { account: "account-a", environment: "sandbox", apiKey: "test-key" };
  const store = createProviderCacheStore(scoped, () => scope);
  const originalStore = { ...providerCacheStore };
  const originalUsageStore = { ...providerUsageStore };
  const originalLeases = { ...providerFetchLeaseStore };
  const originalRetries = { ...providerPortRetryStore };
  const settings = { ...config.freightPulse };
  const originalFetch = globalThis.fetch;
  let created = false;
  let calls = 0;
  try {
    await initializeProviderCacheSchema(pool, schema);
    created = true;
    Object.assign(providerCacheStore, store);
    Object.assign(providerUsageStore, memoryProviderUsageStore());
    Object.assign(providerFetchLeaseStore, memoryProviderFetchLeaseStore());
    Object.assign(providerPortRetryStore, memoryProviderPortRetryStore());
    Object.assign(config.freightPulse, { apiKey: "test-key", mode: "live", baseUrl: "https://api.panvaya.com/api/v1", rateLimitPerMin: 100, monthlyQuota: 1000, cacheTtlMs: 86400000 });
    globalThis.fetch = async (url, options) => {
      calls++;
      if (url.includes("/track/air")) {
        if (JSON.parse(options.body).awb.startsWith("999-")) return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND", detail: "No tracking data" }] }), { status: 404 });
        return new Response(JSON.stringify({ awbNumber: "044-45428036" }));
      }
      return new Response(JSON.stringify({ ports: [{ locode: "SGSIN", name: "Singapore", anchorLast30: { median: 1 } }] }));
    };

    const [first, concurrent] = await Promise.all([
      getTracking({ mode: "AIR", awb: "04445428036" }),
      getTracking({ mode: "air", awb: "044-45428036" })
    ]);
    assert.equal(calls, 1);
    assert.equal(first.cached, false);
    assert.deepEqual(concurrent, first);
    assert.deepEqual(await getTracking({ mode: "AIR", awb: "04445428036" }), { ...first, cached: true });

    await assert.rejects(getTracking({ mode: "AIR", awb: "99999999999" }), { message: "No tracking data", status: 404, code: "NOT_FOUND" });
    await assert.rejects(getTracking({ mode: "air", awb: "999-99999999" }), { message: "No tracking data", status: 404, code: "NOT_FOUND" });
    assert.equal(calls, 2);

    const [port, concurrentPort] = await Promise.all([getPortCongestion([" sgsin "]), getPortCongestion(["SGSIN"])]);
    assert.equal(calls, 3);
    assert.deepEqual(concurrentPort, port);
    assert.equal(port.SGSIN.source, "live");
    assert.deepEqual((await getPortCongestion(["SGSIN"])).SGSIN, { ...port.SGSIN, cached: true });
    assert.equal((await cacheStats()).portsCached, 1);
    const row = (await pool.query(`SELECT source, fetched_at, expires_at FROM ${schema}.provider_port_cache WHERE port_code = 'SGSIN'`)).rows[0];
    assert.equal(row.source, "live");
    assert.equal(row.expires_at - row.fetched_at, 86400000);
    const errorRow = (await pool.query(`SELECT fetched_at, expires_at FROM ${schema}.provider_tracking_cache WHERE error IS NOT NULL`)).rows[0];
    assert.equal(errorRow.expires_at - errorRow.fetched_at, 60000);
    const successRow = (await pool.query(`SELECT request_key, fetched_at, expires_at FROM ${schema}.provider_tracking_cache WHERE result IS NOT NULL`)).rows[0];
    assert.equal(successRow.request_key, JSON.stringify(trackingIdentity({ mode: "AIR", awb: "04445428036" })));
    assert.equal(successRow.expires_at - successRow.fetched_at, 86400000);

    scope.account = "account-b";
    assert.equal(await store.getTracking(successRow.request_key), null);
    assert.equal(await store.getPort("SGSIN"), null);
    await store.putPort("SGSIN", { unloco: "SGSIN", source: "mock" }, Date.now(), 60000);
    scope.account = "account-a";
    scope.environment = "production";
    assert.equal(await store.getPort("SGSIN"), null);
    assert.equal(await store.getTracking(successRow.request_key), null);
    await store.putTracking(successRow.request_key, { mode: "air", data: {} }, null, Date.now(), 60000);
    scope.environment = "sandbox";
    assert.equal((await store.getTracking(successRow.request_key)).result.data.awbNumber, "044-45428036");
    assert.equal((await store.getPort("SGSIN")).result.source, "live");
    const secondStore = createProviderCacheStore(scoped, () => scope);
    assert.equal((await secondStore.getPort("SGSIN")).result.source, "live");

    await pool.query(`UPDATE ${schema}.provider_tracking_cache SET fetched_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'`);
    await pool.query(`UPDATE ${schema}.provider_port_cache SET fetched_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'`);
    assert.equal((await getTracking({ mode: "AIR", awb: "04445428036" })).cached, false);
    assert.equal((await getPortCongestion(["SGSIN"])).SGSIN.cached, false);
    await assert.rejects(getTracking({ mode: "AIR", awb: "99999999999" }), { status: 404 });
    assert.equal(calls, 6);

    scope.account = "";
    await assert.rejects(store.getPort("SGSIN"), { code: "PROVIDER_CACHE_UNAVAILABLE", status: 503 });
    scope.account = "test-key";
    await assert.rejects(store.getPort("SGSIN"), { code: "PROVIDER_CACHE_UNAVAILABLE" });
    scope.account = "account-a";
    await pool.query(`ALTER TABLE ${schema}.provider_tracking_cache RENAME TO tracking_unavailable`);
    await assert.rejects(getTracking({ mode: "AIR", awb: "04445428036" }), { code: "PROVIDER_CACHE_UNAVAILABLE", status: 503 });
    assert.equal(calls, 6);
    await pool.query(`ALTER TABLE ${schema}.tracking_unavailable RENAME TO provider_tracking_cache`);
    await pool.query(`ALTER TABLE ${schema}.provider_port_cache RENAME TO port_unavailable`);
    await assert.rejects(getPortCongestion(["SGSIN"]), { code: "PROVIDER_CACHE_UNAVAILABLE", status: 503 });
    await assert.rejects(cacheStats(), { code: "PROVIDER_CACHE_UNAVAILABLE" });
    await pool.query(`ALTER TABLE ${schema}.port_unavailable RENAME TO provider_port_cache`);

    const failingWrites = createProviderCacheStore({
      query(sql, params) {
        if (sql.includes("INSERT INTO")) throw new Error("simulated write failure");
        return scoped.query(sql, params);
      }
    }, () => scope);
    Object.assign(providerCacheStore, failingWrites);
    await assert.rejects(getTracking({ mode: "AIR", awb: "04400000000" }), { code: "PROVIDER_REQUEST_UNCERTAIN" });
    await assert.rejects(getTracking({ mode: "AIR", awb: "99999999998" }), { code: "PROVIDER_REQUEST_UNCERTAIN" });
    await assert.rejects(getPortCongestion(["LKCMB"]), { code: "PROVIDER_REQUEST_UNCERTAIN" });
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(config.freightPulse, settings);
    Object.assign(providerCacheStore, originalStore);
    Object.assign(providerUsageStore, originalUsageStore);
    Object.assign(providerFetchLeaseStore, originalLeases);
    Object.assign(providerPortRetryStore, originalRetries);
    try { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); }
    finally { await pool.end(); }
  }
});
