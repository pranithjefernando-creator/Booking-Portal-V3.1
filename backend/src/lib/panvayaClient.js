import { config } from "./config.js";

const WINDOW_MS = 60000;
let callTimestamps = [];
let monthKey = "";
let monthlyCount = 0;
let blockedUntil = 0;

function refreshWindow() {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
  if (key !== monthKey) { monthKey = key; monthlyCount = 0; }
  callTimestamps = callTimestamps.filter((timestamp) => Date.now() - timestamp < WINDOW_MS);
}

export function canUseLiveApi() {
  const settings = config.freightPulse;
  return settings.mode === "live" && !!settings.apiKey && !!settings.baseUrl;
}

export function withinRateLimit() {
  refreshWindow();
  const settings = config.freightPulse;
  return Date.now() >= blockedUntil && callTimestamps.length < Math.max(1, Number(settings.rateLimitPerMin) || 5)
    && monthlyCount < Math.max(1, Number(settings.monthlyQuota) || 100);
}

export function usageStats() {
  refreshWindow();
  return { callsThisMonth: monthlyCount, monthlyQuota: config.freightPulse.monthlyQuota, callsLastMinute: callTimestamps.length, rateLimitPerMin: config.freightPulse.rateLimitPerMin };
}

export function providerError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

export async function panvayaRequest(path, payload) {
  if (!canUseLiveApi()) throw providerError("Panvaya is not enabled", 503, "NOT_CONFIGURED");
  if (!withinRateLimit()) throw providerError("Shared Panvaya request limit reached", 429, "RATE_LIMIT_EXCEEDED");
  callTimestamps.push(Date.now());
  monthlyCount += 1;
  const settings = config.freightPulse;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const scheme = settings.authScheme ? `${settings.authScheme} ` : "";
    const response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}${path}`, {
      method: payload === undefined ? "GET" : "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", [settings.authHeader]: `${scheme}${settings.apiKey}` },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      const seconds = Number(retryAfter);
      blockedUntil = Date.now() + (retryAfter && Number.isFinite(seconds) ? Math.max(1, seconds) * 1000 : 60000);
    }
    const error = body?.errors?.[0];
    if (!response.ok || error) throw providerError(error?.detail || error?.message || error?.title || `Panvaya responded ${response.status}`, response.ok ? 502 : response.status, error?.code || "UPSTREAM_ERROR");
    if (!body || typeof body !== "object") throw providerError("Invalid Panvaya response", 502, "UPSTREAM_ERROR");
    return body;
  } finally {
    clearTimeout(timer);
  }
}