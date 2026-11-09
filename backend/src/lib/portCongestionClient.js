import { config } from "./config.js";
import { panvayaRequest } from "./panvayaClient.js";

function hashCode(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  return hash;
}

const LEVELS = ["Low", "Moderate", "High"];
export const LEVEL_RANK = { low: 1, moderate: 2, high: 3, severe: 4, unknown: 0 };

export function mockPortCongestion(unloco) {
  const level = LEVELS[hashCode(unloco) % LEVELS.length];
  const ratio = level === "High" ? 1.4 + (hashCode(unloco) % 30) / 100 : level === "Moderate" ? 1.1 + (hashCode(unloco) % 20) / 100 : 0.8 + (hashCode(unloco) % 20) / 100;
  return {
    unloco, source: "mock", portName: unloco, country: "", congestionLevel: level,
    asOf: new Date().toISOString().slice(0, 10), ratioVsBaseline: Math.round(ratio * 100) / 100,
    recentAvgPortCallsPerDay: null, baselineAvgPortCallsPerDay: null,
    advisory: level === "Low" ? `Normal conditions reported at ${unloco}.` : `Elevated congestion (${level.toLowerCase()}) reported at ${unloco}.`,
  };
}

function normalize(unloco, body) {
  const result = body?.ports?.find((port) => port.locode === unloco || String(port.locodeAlt || "").split(",").some((alias) => alias.trim() === unloco));
  const port = result || (body?.ports?.length === 1 ? body.ports[0] : null);
  const waitDays = port?.anchorLast30?.median;
  const levelLabel = !Number.isFinite(waitDays) ? "Unknown" : waitDays >= 3 ? "Severe" : waitDays >= 2 ? "High" : waitDays >= 1 ? "Moderate" : "Low";
  return {
    unloco,
    source: port ? "live" : "unknown",
    portName: port?.name || unloco,
    country: port?.country || "",
    congestionLevel: levelLabel,
    asOf: "",
    ratioVsBaseline: null,
    recentAvgPortCallsPerDay: Number.isFinite(port?.capLast30?.vesselsArriving) ? port.capLast30.vesselsArriving / 30 : null,
    baselineAvgPortCallsPerDay: null,
    anchorWaitDays: Number.isFinite(waitDays) ? waitDays : null,
    berthingDays: port?.berthingLast30?.median ?? null,
    approachingVessels: port?.approachingLast30?.vesselsNext7 ?? null,
    vesselsAnchored: port?.within50nmiLast30?.vesselsAnchoredOutside ?? null,
    metrics: port || null,
    advisory: port ? `${port.name || unloco}: ${Number.isFinite(waitDays) ? `${waitDays} days median anchorage wait over the last 30 days` : "anchorage wait unavailable"}.` : `No Panvaya coverage for ${unloco}.`,
  };
}

export async function fetchLivePortCongestion(unloco) {
  try {
    const body = await panvayaRequest(`${config.freightPulse.portPath}?locode=${encodeURIComponent(unloco)}`);
    return normalize(unloco, body);
  } catch (e) {
    console.error(`[port-congestion] live lookup failed for ${unloco}: ${e.message}`);
    if (e.status === 404) return normalize(unloco, { ports: [] });
    return { ...mockPortCongestion(unloco), source: "fallback", error: e.message };
  }
}
