import { fetchLivePortCongestion, mockPortCongestion } from "./portCongestionClient.js";
import { config } from "./config.js";
import { canUseLiveApi, withinRateLimit, usageStats } from "./panvayaClient.js";

// Cached per UNLOCO port (not per shipment) so many shipments sharing a port cost a single API call.
const cache = new Map(); // unloco -> { data, fetchedAt }
const inFlight = new Map(); // unloco -> Promise, de-dupes concurrent lookups for the same port
const pendingRetry = new Set(); // ports queued for a background retry once a rate-limit slot frees up

const WINDOW_MS = 60 * 1000;

function ttlMs() { return Math.max(60000, Number(config.freightPulse.cacheTtlMs) || 24 * 60 * 60 * 1000); }
function isFresh(entry) { return !!entry && (Date.now() - entry.fetchedAt) < ttlMs(); }

// Queues a single retry ~1 minute later so a rate-limited port still gets live data for the
// next request within its 24h cache window, without blocking the current response.
function scheduleBackgroundRetry(unloco) {
  if (pendingRetry.has(unloco)) return;
  pendingRetry.add(unloco);
  setTimeout(async () => {
    pendingRetry.delete(unloco);
    if (!canUseLiveApi() || !withinRateLimit()) return;
    if (inFlight.has(unloco)) return;
    const promise = fetchLivePortCongestion(unloco)
      .then((data) => { cache.set(unloco, { data, fetchedAt: Date.now() }); return data; })
      .finally(() => inFlight.delete(unloco));
    inFlight.set(unloco, promise);
    try { await promise; } catch (_) { /* keep existing cache/mock entry */ }
  }, WINDOW_MS).unref();
}

async function getOne(unloco) {
  const cached = cache.get(unloco);
  if (isFresh(cached)) return { ...cached.data, cached: true, cachedAt: new Date(cached.fetchedAt).toISOString() };
  if (inFlight.has(unloco)) return inFlight.get(unloco);
  const useLive = canUseLiveApi() && withinRateLimit();
  if (!useLive && canUseLiveApi()) scheduleBackgroundRetry(unloco);
  const promise = (useLive ? fetchLivePortCongestion(unloco) : Promise.resolve({ ...mockPortCongestion(unloco), source: canUseLiveApi() ? "rate-limited" : "mock" }))
    .then((data) => { cache.set(unloco, { data, fetchedAt: Date.now() }); return { ...data, cached: false, cachedAt: new Date().toISOString() }; })
    .finally(() => inFlight.delete(unloco));
  inFlight.set(unloco, promise);
  return promise;
}

export async function getPortCongestion(unlocoCodes) {
  const codes = [...new Set(unlocoCodes.map((code) => String(code || "").trim().toUpperCase()).filter(Boolean))];
  const results = await Promise.all(codes.map((code) => getOne(code).catch((e) => ({ unloco: code, source: "error", error: e.message, congestionLevel: "Unknown" }))));
  return Object.fromEntries(results.map((r) => [r.unloco, r]));
}

export function cacheStats() {
  return { portsCached: cache.size, ttlMs: ttlMs(), mode: config.freightPulse.mode, ...usageStats() };
}
