import { setTimeout as sleep } from "node:timers/promises";
import { createBookingPool } from "../../src/lib/bookingStore.js";
import { createProviderCacheStore, providerCacheStore } from "../../src/lib/providerCacheStore.js";
import { createProviderFetchLeaseStore, providerFetchLeaseStore } from "../../src/lib/providerFetchCoordination.js";
import { createProviderUsageStore, providerUsageStore } from "../../src/lib/providerUsageStore.js";
import { createProviderPortRetryStore, providerPortRetryStore } from "../../src/lib/providerPortRetryStore.js";
import { config } from "../../src/lib/config.js";
import { getTracking } from "../../src/lib/trackingCache.js";
import { getPortCongestion, runDuePortRetries } from "../../src/lib/portCongestionCache.js";

const schema = process.env.TEST_PROVIDER_SCHEMA;
if (!/^provider_test_[a-f0-9]{32}$/.test(schema || "")) throw new Error("Invalid provider test schema");
const pool = createBookingPool();
const translate = (sql) => sql.replaceAll("booking_portal_v4.", `${schema}.`);
const scoped = {
  query: (sql, params) => pool.query(translate(sql), params),
  async connect() {
    const client = await pool.connect();
    return { query: (sql, params) => client.query(translate(sql), params), release: (error) => client.release(error) };
  }
};
const scope = () => ({ account: process.env.TEST_PROVIDER_ACCOUNT || "account-a", environment: "sandbox", apiKey: "test-key" });
Object.assign(providerCacheStore, createProviderCacheStore(scoped, scope));
Object.assign(providerFetchLeaseStore, createProviderFetchLeaseStore(scoped, scope));
Object.assign(providerUsageStore, createProviderUsageStore(scoped, scope));
Object.assign(providerPortRetryStore, createProviderPortRetryStore(scoped, scope));
Object.assign(config.freightPulse, {
  apiKey: "test-key", mode: "live", baseUrl: "https://provider.test/api/v1", timeoutMs: 20000,
  rateLimitPerMin: Number(process.env.TEST_RATE_LIMIT || 100), monthlyQuota: Number(process.env.TEST_MONTHLY_QUOTA || 1000)
});
const kind = process.argv[2];
const behavior = process.argv[3] || "success";
const reference = process.argv[4] || "04445428036";
let overlappingLookup;
globalThis.fetch = async () => {
  await pool.query(`INSERT INTO ${schema}.test_provider_calls (kind) VALUES ($1)`, [kind]);
  if (kind === "retry-overlap") {
    overlappingLookup = await Promise.race([
      getPortCongestion(["SGSIN"]),
      sleep(3000).then(() => { throw new Error("Overlapping lookup did not finish"); })
    ]);
  }
  if (behavior === "crash") process.exit(44);
  if (behavior === "timeout") throw new Error("simulated timeout");
  await sleep(1500);
  if (behavior === "body-timeout") return { status: 200, ok: true, headers: new Headers(), json: async () => { throw new Error("response interrupted"); } };
  if (behavior === "not-found") return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND", detail: "No tracking data" }] }), { status: 404 });
  if (behavior === "rate-limit") return new Response(JSON.stringify({ errors: [{ code: "UPSTREAM_LIMIT", detail: "Slow down" }] }), { status: 429, headers: { "Retry-After": "120" } });
  if (kind === "tracking") return new Response(JSON.stringify({ awbNumber: "044-45428036" }));
  return new Response(JSON.stringify({ ports: [{ locode: "SGSIN", name: "Singapore", anchorLast30: { median: 1 } }] }));
};
try {
  if (kind === "retry" || kind === "retry-overlap") {
    await runDuePortRetries();
    console.log(JSON.stringify({ complete: true, ...(overlappingLookup && { lookup: overlappingLookup.SGSIN }) }));
  } else {
    const result = kind === "tracking"
    ? await getTracking({ mode: "AIR", awb: reference })
    : (await getPortCongestion(["SGSIN"])).SGSIN;
    console.log(JSON.stringify({ cached: result.cached, source: result.source }));
  }
} catch (error) {
  console.log(JSON.stringify({ code: error.code, message: error.message }));
} finally { await pool.end(); }
