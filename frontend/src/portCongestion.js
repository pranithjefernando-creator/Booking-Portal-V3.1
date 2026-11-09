import { api } from "./api.js";
import { isArrived } from "./trackingData.js";

const CLIENT_CACHE_KEY = "sbms.portCongestion.cache.panvaya.v1";
const CLIENT_TTL_MS = 24 * 60 * 60 * 1000;

// "In progress" = not yet arrived/completed. The sample dataset has no explicit cancelled flag.
export function isActiveShipment(shipment, now = new Date()) {
  return !isArrived(shipment, now);
}

export function activeShipments(shipments, now = new Date()) {
  return shipments.filter((shipment) => isActiveShipment(shipment, now));
}

export function activePortCodes(shipments, now = new Date()) {
  const codes = new Set();
  activeShipments(shipments, now).filter((shipment) => shipment.mode === "Ocean").forEach((shipment) => shipment.routePorts.forEach((port) => codes.add(port)));
  return [...codes];
}

function readClientCache() {
  try { return JSON.parse(localStorage.getItem(CLIENT_CACHE_KEY) || "{}"); } catch (_) { return {}; }
}
function writeClientCache(cache) {
  try { localStorage.setItem(CLIENT_CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* storage unavailable */ }
}

// Skips the backend call entirely for ports already fetched in this browser within the last 24h.
export async function loadPortCongestion(portCodes, request = api.post) {
  if (!portCodes.length) return {};
  const cache = readClientCache();
  const now = Date.now();
  const fresh = {};
  const stale = [];
  portCodes.forEach((code) => {
    const entry = cache[code];
    if (entry && now - entry.cachedAt < CLIENT_TTL_MS) fresh[code] = entry.data;
    else stale.push(code);
  });
  if (!stale.length) return fresh;
  for (let offset = 0; offset < stale.length; offset += 60) {
    const response = await request("/port-congestion/lookup", { ports: stale.slice(offset, offset + 60) });
    Object.entries(response.ports || {}).forEach(([code, data]) => { cache[code] = { data, cachedAt: now }; fresh[code] = data; });
  }
  writeClientCache(cache);
  return fresh;
}

const LEVEL_RANK = { low: 1, moderate: 2, high: 3, severe: 4, unknown: 0 };

export function congestionTag(level) {
  switch (String(level || "").toLowerCase()) {
    case "severe":
    case "high": return "tag-error";
    case "moderate": return "tag-amber";
    case "low": return "tag-ok";
    default: return "tag-plain";
  }
}

export function isCongested(entry) {
  const level = String(entry?.congestionLevel || "").toLowerCase();
  return entry?.source === "live" && (level === "moderate" || level === "high" || level === "severe");
}

export function affectedShipmentsFor(shipments, congestionByPort, now = new Date()) {
  const affected = [];
  activeShipments(shipments, now).filter((shipment) => shipment.mode === "Ocean").forEach((shipment) => {
    const hits = shipment.routePorts.map((code) => congestionByPort[code]).filter(isCongested);
    if (hits.length) {
      const worst = hits.sort((a, b) => (LEVEL_RANK[String(b.congestionLevel).toLowerCase()] || 0) - (LEVEL_RANK[String(a.congestionLevel).toLowerCase()] || 0))[0];
      affected.push({ shipment, congestion: worst });
    }
  });
  return affected;
}
