import { api } from "./api.js";
import { isArrived } from "./trackingData.js";

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

export async function loadPortCongestion(portCodes, request = api.post) {
  if (!portCodes.length) return {};
  const results = {};
  for (let offset = 0; offset < portCodes.length; offset += 60) {
    const ports = portCodes.slice(offset, offset + 60);
    const response = await request("/port-congestion/lookup", { ports });
    if (!response?.ports || typeof response.ports !== "object" || Array.isArray(response.ports) ||
        ports.some((code) => !Object.hasOwn(response.ports, code))) throw new Error("Invalid port congestion response");
    Object.assign(results, response.ports);
  }
  return results;
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
