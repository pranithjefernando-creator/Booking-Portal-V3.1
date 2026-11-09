const REFERENCE_URL = new URL("../data/location-reference.json", import.meta.url).href;
let referencePromise;

export function decodeLocationCoordinates(value) {
  const match = /^(\d{2})(\d{2})([NS])\s+(\d{3})(\d{2})([EW])$/.exec(String(value || "").trim());
  if (!match) return null;
  const latitude = Number(match[1]) + Number(match[2]) / 60;
  const longitude = Number(match[4]) + Number(match[5]) / 60;
  if (Number(match[2]) >= 60 || Number(match[5]) >= 60 || latitude > 90 || longitude > 180) return null;
  return [Number((latitude * (match[3] === "S" ? -1 : 1)).toFixed(6)), Number((longitude * (match[6] === "W" ? -1 : 1)).toFixed(6))];
}

export function locationCoordinates(reference, fallback = {}) {
  const coordinates = { ...fallback };
  for (const [code, point] of Object.entries(reference?.locations || {})) {
    if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(code) && Array.isArray(point) && point.length === 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180) coordinates[code] = point;
  }
  return coordinates;
}

export function loadLocationReference() {
  if (!referencePromise) referencePromise = fetch(REFERENCE_URL).then(async (response) => {
    if (!response.ok) throw new Error(`Location reference unavailable (${response.status})`);
    const reference = await response.json();
    if (!reference?.locations || Object.keys(reference.locations).length < 1000) throw new Error("Location reference is incomplete");
    return reference;
  }).catch((error) => { referencePromise = null; throw error; });
  return referencePromise;
}

export function routeCoverage(shipment, coordinates) {
  const legs = shipment.routingLegs.map((leg) => {
    const missing = [...new Set([leg.load, leg.discharge].filter((code) => code && !coordinates[code]))];
    const status = !leg.load || !leg.discharge ? "incomplete" : missing.length ? "unmapped" : leg.load === leg.discharge ? "stationary" : "mapped";
    return { ...leg, status, missing, from: coordinates[leg.load], to: coordinates[leg.discharge] };
  });
  return { legs, missingCodes: [...new Set(legs.flatMap((leg) => leg.missing))] };
}