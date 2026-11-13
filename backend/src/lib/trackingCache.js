import { config } from "./config.js";
import { panvayaRequest, providerError } from "./panvayaClient.js";
import { providerCacheStore } from "./providerCacheStore.js";
import { coordinateProviderFetch } from "./providerFetchCoordination.js";

const inFlight = new Map();

function reference(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 160) throw providerError("Invalid tracking reference", 400, "INVALID_REQUEST");
  return value.trim().toUpperCase();
}

export function trackingIdentity(input) {
  const mode = reference(input?.mode);
  if (mode === "AIR") {
    const awb = reference(input.awb).replace(/[\s-]/g, "");
    if (!/^\d{11}$/.test(awb)) throw providerError("Provide a full 11-digit master AWB", 400, "INVALID_REQUEST");
    return { mode: "air", payload: { awb: `${awb.slice(0, 3)}-${awb.slice(3)}` } };
  }
  if (!["SEA", "OCEAN"].includes(mode)) throw providerError("Tracking mode must be SEA or AIR", 400, "INVALID_REQUEST");
  const container = reference(input.container).replace(/\s/g, "");
  const bol = reference(input.bol);
  const booking = reference(input.bk);
  const carrier = reference(input.shipping_line_scac);
  if ((!container && !bol && !booking) || (bol && booking)) throw providerError("Provide a container, B/L or booking; B/L and booking cannot be combined", 400, "INVALID_REQUEST");
  if (container && !/^[A-Z]{3}U\d{7}$/.test(container)) throw providerError("Invalid ISO container reference", 400, "INVALID_REQUEST");
  if (carrier && !/^[A-Z]{4}$/.test(carrier)) throw providerError("Carrier SCAC must contain four letters", 400, "INVALID_REQUEST");
  return { mode: "ocean", payload: { ...(container ? { container } : {}), ...(bol ? { bol } : {}), ...(booking ? { bk: booking } : {}), ...(carrier ? { shipping_line_scac: carrier } : {}), include_route_data: true } };
}

export async function getTracking(input) {
  const identity = trackingIdentity(input);
  const key = JSON.stringify(identity);
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = (async () => {
    try {
      const coordinated = await coordinateProviderFetch("tracking", key, {
        read: () => providerCacheStore.getTracking(key),
        accept: Boolean,
        async fetch(beforeFetch) {
          try {
            const body = await panvayaRequest(`/track/${identity.mode}`, identity.payload, { beforeFetch });
            const data = identity.mode === "air" ? body : body.data;
            if (!data || (identity.mode === "ocean" && !Array.isArray(data.containers)) || (identity.mode === "air" && !data.awbNumber)) {
              throw providerError("Invalid Panvaya tracking response", 502, "UPSTREAM_ERROR");
            }
            const fetchedAt = Date.now();
            return { result: { mode: identity.mode, source: "panvaya", data, cached: false, cachedAt: new Date(fetchedAt).toISOString() }, error: null, fetchedAt };
          } catch (error) {
            if (error.code === "PROVIDER_QUOTA_UNAVAILABLE" || error.code === "PROVIDER_REQUEST_UNCERTAIN" ||
                error.code === "PROVIDER_COORDINATION_UNAVAILABLE" || error.providerRequestSent) throw error;
            const safeError = providerError(error.message, error.status || 502, error.code || "UPSTREAM_ERROR");
            return { result: null, error: { message: safeError.message, status: safeError.status, code: safeError.code }, fetchedAt: Date.now() };
          }
        },
        write: (value, client) => providerCacheStore.putTracking(key, value.result, value.error, value.fetchedAt,
          value.error ? 60000 : Math.max(60000, Number(config.freightPulse.cacheTtlMs) || 86400000), client)
      });
      if (coordinated.value.error) throw providerError(coordinated.value.error.message, coordinated.value.error.status, coordinated.value.error.code);
      return coordinated.cached ? { ...coordinated.value.result, cached: true } : coordinated.value.result;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}