import { config } from "./config.js";
import { providerUsageStore } from "./providerUsageStore.js";

export function canUseLiveApi() {
  const settings = config.freightPulse;
  return settings.mode === "live" && !!settings.apiKey && !!settings.baseUrl;
}

export async function usageStats() {
  const usage = await providerUsageStore.stats();
  return { callsThisMonth: usage.callsThisMonth, monthlyQuota: config.freightPulse.monthlyQuota, callsLastMinute: usage.callsLastMinute, rateLimitPerMin: config.freightPulse.rateLimitPerMin };
}

export function providerError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export async function panvayaRequest(path, payload, { beforeFetch } = {}) {
  if (!canUseLiveApi()) throw providerError("Panvaya is not enabled", 503, "NOT_CONFIGURED");
  const settings = config.freightPulse;
  const reservation = await providerUsageStore.reserve(
    Math.max(1, Number(settings.rateLimitPerMin) || 5),
    Math.max(1, Number(settings.monthlyQuota) || 100)
  );
  if (!reservation) throw Object.assign(providerError("Shared Panvaya request limit reached", 429, "RATE_LIMIT_EXCEEDED"), { localLimit: true });
  if (beforeFetch) await beforeFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const scheme = settings.authScheme ? `${settings.authScheme} ` : "";
    let response;
    try {
      response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: payload === undefined ? "GET" : "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", [settings.authHeader]: `${scheme}${settings.apiKey}` },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw Object.assign(providerError("Panvaya request outcome is uncertain; it may have been billed", 503, "PROVIDER_REQUEST_UNCERTAIN"), { cause: error, providerRequestSent: true });
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const seconds = Number(retryAfter);
      const delay = retryAfter && Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 60000;
      try { await providerUsageStore.recordBackoff(reservation, delay); }
      catch (error) { console.error("[provider-quota] could not persist Panvaya 429 backoff"); error.providerRequestSent = true; throw error; }
    }
    let body;
    try { body = await response.json(); }
    catch (error) {
      if (controller.signal.aborted || !(error instanceof SyntaxError)) {
        throw Object.assign(providerError("Panvaya response outcome is uncertain; the request may have been billed", 503, "PROVIDER_REQUEST_UNCERTAIN"), { cause: error, providerRequestSent: true });
      }
      body = null;
    }
    const error = body?.errors?.[0];
    if (!response.ok || error) throw providerError(error?.detail || error?.message || error?.title || `Panvaya responded ${response.status}`, response.ok ? 502 : response.status, error?.code || "UPSTREAM_ERROR");
    if (!body || typeof body !== "object") throw providerError("Invalid Panvaya response", 502, "UPSTREAM_ERROR");
    return body;
  } finally {
    clearTimeout(timer);
  }
}