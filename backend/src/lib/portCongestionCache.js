import { fetchLivePortCongestion, mockPortCongestion } from "./portCongestionClient.js";
import { config } from "./config.js";
import { canUseLiveApi, usageStats } from "./panvayaClient.js";
import { providerCacheStore } from "./providerCacheStore.js";
import { coordinateProviderFetch } from "./providerFetchCoordination.js";
import { providerPortRetryStore } from "./providerPortRetryStore.js";

// Cached per UNLOCO port (not per shipment) so many shipments sharing a port cost a single API call.
const inFlight = new Map(); // unloco -> Promise, de-dupes concurrent lookups for the same port
function ttlMs() { return Math.max(60000, Number(config.freightPulse.cacheTtlMs) || 24 * 60 * 60 * 1000); }

async function coordinatedPort(unloco) {
  const coordinated = await coordinateProviderFetch("port", unloco, {
    read: () => providerCacheStore.getPort(unloco),
    accept: Boolean,
    async fetch(beforeFetch) {
      const data = canUseLiveApi() ? await fetchLivePortCongestion(unloco, beforeFetch) : mockPortCongestion(unloco);
      return { result: data, fetchedAt: Date.now() };
    },
    async write(value, client) {
      await providerCacheStore.putPort(unloco, value.result, value.fetchedAt, ttlMs(), client);
      if (value.result.source === "rate-limited") await providerPortRetryStore.schedule(unloco, value.fetchedAt, client);
      else await providerPortRetryStore.discardPort(unloco, client);
    }
  });
  if (coordinated.cached) return { ...coordinated.value.result, cached: true, cachedAt: new Date(coordinated.value.fetched_at).toISOString() };
  return { ...coordinated.value.result, cached: false, cachedAt: new Date(coordinated.value.fetchedAt).toISOString() };
}

async function retryPort(job) {
  const code = job.port_code;
  await coordinateProviderFetch("port", code, {
    async read() {
      const current = await providerPortRetryStore.getDue(job.retry_id);
      if (!current) return { done: true };
      const cached = await providerCacheStore.getPortForRetry(code);
      if (cached && (cached.result.source !== "rate-limited" ||
          new Date(cached.fetched_at).getTime() !== new Date(current.cache_fetched_at).getTime())) {
        await providerPortRetryStore.discard(job.retry_id);
        return { done: true };
      }
      return null;
    },
    accept: Boolean,
    async fetch(beforeFetch) {
      const result = await fetchLivePortCongestion(code, beforeFetch);
      return { result, fetchedAt: Date.now() };
    },
    async write(value, client) {
      if (value.result.source !== "rate-limited") await providerCacheStore.putPort(code, value.result, value.fetchedAt, ttlMs(), client);
      await providerPortRetryStore.discard(job.retry_id, client);
    }
  });
}

export async function runDuePortRetries(shouldStop = () => false) {
  if (!canUseLiveApi()) return;
  const jobs = await providerPortRetryStore.listDue();
  for (const job of jobs) {
    if (shouldStop()) break;
    if (inFlight.has(job.port_code)) continue;
    try { await retryPort(job); }
    catch (error) { console.error(`[port-congestion] background retry failed for ${job.port_code}: ${error.message}`); }
  }
}

export function startPortCongestionRetries() {
  let stopped = false;
  let running;
  function tick() {
    if (stopped || running || !canUseLiveApi()) return;
    running = runDuePortRetries(() => stopped)
      .catch((error) => console.error(`[port-congestion] retry queue unavailable: ${error.message}`))
      .finally(() => { running = undefined; });
  }
  const timer = setInterval(tick, 5000);
  timer.unref();
  tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (running) await running;
  };
}

async function getOne(unloco) {
  if (inFlight.has(unloco)) return inFlight.get(unloco);
  const promise = (async () => {
    if (!/^[A-Z]{2}[A-Z0-9]{3}$/.test(unloco)) throw new Error("Invalid UNLOCO port code");
    return coordinatedPort(unloco);
  })()
    .finally(() => inFlight.delete(unloco));
  inFlight.set(unloco, promise);
  return promise;
}

export async function getPortCongestion(unlocoCodes) {
  const codes = [...new Set(unlocoCodes.map((code) => String(code || "").trim().toUpperCase()).filter(Boolean))];
  const results = await Promise.all(codes.map((code) => getOne(code).catch((e) => {
    if (["PROVIDER_CACHE_UNAVAILABLE", "PROVIDER_QUOTA_UNAVAILABLE", "PROVIDER_COORDINATION_UNAVAILABLE", "PROVIDER_REQUEST_UNCERTAIN", "PROVIDER_REQUEST_PENDING"].includes(e.code)) throw e;
    return { unloco: code, source: "error", error: e.message, congestionLevel: "Unknown" };
  })));
  return Object.fromEntries(results.map((r) => [r.unloco, r]));
}

export async function cacheStats() {
  return { portsCached: await providerCacheStore.countPorts(), ttlMs: ttlMs(), mode: config.freightPulse.mode, ...await usageStats() };
}
