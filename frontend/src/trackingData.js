import { api } from "./api.js";

export const UNAVAILABLE = "Not Available Now";
export const UNKNOWN = "Unknown";

const MAPPING = {
  status: "Tracking - Shipment Details Data > Status",
  confidence: "Tracking - Shipment Details Data > confidence",
  originalEta: "Tracking - Shipment Details Data > originaleta",
  aiEta: "Tracking - Shipment Details Data > aieta",
  milestones: "Tracking - Shipment Details Data > Milestone",
  coordinates: "Tracking - Command Center Data > lat / lng",
  risk: "Tracking - Command Center Data > risk",
  cause: "Tracking - Command Center Data > cause",
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1; continue; }
    if (character === '"') { quoted = !quoted; continue; }
    if (character === "," && !quoted) { row.push(value); value = ""; continue; }
    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(value); value = "";
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      continue;
    }
    value += character;
  }
  if (value || row.length) { row.push(value); rows.push(row); }
  const [headers, ...data] = rows;
  return data.map((cells) => Object.fromEntries(headers.map((header, index) => [header.trim(), (cells[index] || "").trim()])));
}

function first(record, ...keys) { return keys.map((key) => record[key]).find(Boolean) || ""; }
function modeName(value) { return value === "SEA" ? "Ocean" : value === "AIR" ? "Air" : value === "ROAD" ? "Road" : value || UNAVAILABLE; }
export const PORT_COORDINATES = {
  LKCMB: [6.9271, 79.8612], USPHL: [39.9526, -75.1652], USJFK: [40.6413, -73.7781],
  VNSGN: [10.8231, 106.6297], CAVAN: [49.2827, -123.1207], USFLK: [30.3322, -81.6557],
  USHOU: [29.7604, -95.3698], AREZE: [-34.6037, -58.3816], IDJKT: [-6.2088, 106.8456],
  QADOH: [25.2854, 51.5310], USILG: [39.7391, -75.5398], GBSOT: [50.9097, -1.4044],
  USLAX: [33.7395, -118.2610], CNJAX: [30.7467, 120.7559],
  GBLHR: [51.4700, -0.4543], KENBO: [-4.0435, 39.6682], BRSSZ: [-23.9608, -46.3336],
  USOLS: [41.6556, -83.5363], TWTPE: [25.0330, 121.5654], THBKK: [13.7563, 100.5018],
  USCHS: [32.7765, -79.9311], TWKHH: [22.6273, 120.3014], CNCAN: [23.1291, 113.2644],
  CAYVR: [49.1951, -123.1775], SEARN: [59.3293, 18.0686], CAYYZ: [43.6777, -79.6248],
  CNNBO: [29.8683, 121.5440], CNSHA: [31.2304, 121.4737],
};

function routePortsFor(record) {
  const stops = [];
  const addValue = (value) => {
    if (value && stops[stops.length - 1] !== value) stops.push(value);
  };
  for (let leg = 1; leg <= 4; leg += 1) {
    const load = first(record, `Leg ${leg}-Load`, `Leg ${leg} - Load`);
    const discharge = first(record, `Leg ${leg} - Discharge`, `Leg ${leg}-Discharge`);
    addValue(load);
    addValue(discharge);
  }
  return stops;
}
function routeFor(record) {
  return routePortsFor(record).join(" → ") || UNAVAILABLE;
}
export function routingLegsFor(record) {
  return Array.from({ length: 4 }, (_, index) => {
    const leg = index + 1;
    const etd = first(record, `Leg ${leg} - ETD`, `Leg ${leg}-ETD`);
    const eta = first(record, `Leg ${leg} - ETA`, `Leg ${leg}-ETA`);
    const load = first(record, `Leg ${leg}-Load`, `Leg ${leg} - Load`);
    const discharge = first(record, `Leg ${leg} - Discharge`, `Leg ${leg}-Discharge`);
    return load || discharge ? { leg, load, discharge, etd, eta } : null;
  }).filter(Boolean);
}
const CONTAINER_TYPE_CODES = ["20F", "20R", "20H", "40F", "40R", "40H", "45F", "GEN"];
const CONTAINER_TYPE_ALIASES = { "20F": "20GP", "20R": "20RE", "20H": "20HC", "40F": "40GP", "40R": "40RE", "40H": "40HC", "45F": "45HC" };

function containerTypeCode(record) {
  return CONTAINER_TYPE_CODES.find((type) => record[type] && record[type] !== "0") || "";
}

function masterValue(master, key) {
  return master?.[key] || UNKNOWN;
}

function containerNumbersFor(record) {
  return [...new Set(String(record.ContainerNum || "").split(",").map((number) => number.trim().toUpperCase()).filter(Boolean))];
}

function containerSummary(record) {
  const types = CONTAINER_TYPE_CODES
    .filter((type) => record[type] && record[type] !== "0")
    .map((type) => `${record[type]} × ${type}`);
  return [containerNumbersFor(record).join(", ") || record["Consol ID"], ...types].filter(Boolean).join(" ") || UNAVAILABLE;
}

function containerDetails(record, masterByCode) {
  const typeCounts = CONTAINER_TYPE_CODES
    .filter((type) => record[type] && record[type] !== "0")
    .map((type) => `${record[type]} × ${type}`);
  const derivedCount = ["20F", "20R", "20H", "40F", "40R", "40H", "45F", "GEN"]
    .reduce((total, type) => total + (Number(record[type]) || 0), 0);
  const sourceType = containerTypeCode(record);
  const masterCode = CONTAINER_TYPE_ALIASES[sourceType];
  const master = masterByCode[masterCode];
  const numbers = containerNumbersFor(record);
  return (numbers.length ? numbers : [record["Consol ID"] || UNKNOWN]).map((number) => ({
    number,
    type: typeCounts.join(", ") || UNKNOWN,
    typeCode: masterCode || UNKNOWN,
    description: masterValue(master, "Description"),
    containerType: masterValue(master, "Container Type"),
    iso: masterValue(master, "ISO"),
    isoDescription: masterValue(master, "ISO Description"),
    dimensions: master ? `${masterValue(master, "Length")} ft × ${masterValue(master, "Width")} ft × ${masterValue(master, "Height")} ft` : UNKNOWN,
    grossWeight: masterValue(master, "Gross Weight"),
    tareWeight: masterValue(master, "Tare Weight"),
    capacity: masterValue(master, "Capacity (M3)"),
    count: record["Container Count"] || (derivedCount ? String(derivedCount) : UNKNOWN),
    teu: record.TEU || UNKNOWN,
    status: record["Customs Info"] || UNKNOWN,
    vessel: first(record, "Vessel", "Flight/Voyage") || UNKNOWN,
    route: routeFor(record),
    cargo: record["Goods Description"] || UNKNOWN,
    weight: [record.Weight, record["WEIGHT UQ"]].filter(Boolean).join(" ") || UNKNOWN,
    volume: [record.Volume, record["Volume UQ"]].filter(Boolean).join(" ") || UNKNOWN,
  }));
}

export function unavailable(mappingKey) { return { value: UNAVAILABLE, mapping: MAPPING[mappingKey] }; }

export function trackingRequestFor(shipment) {
  const raw = shipment?.raw || {};
  if (raw.Trans === "AIR") {
    const awb = String(raw.Master || "").replace(/[\s-]/g, "");
    return /^\d{11}$/.test(awb) ? { mode: "AIR", awb } : null;
  }
  if (raw.Trans !== "SEA") return null;
  const container = String(raw.ContainerNum || "").replace(/\s/g, "").toUpperCase();
  if (/^[A-Z]{3}U\d{7}$/.test(container)) return { mode: "SEA", container };
  if (raw.Master?.trim()) return { mode: "SEA", bol: raw.Master.trim().toUpperCase() };
  return null;
}

export function trackingMapData(response) {
  const data = response?.data;
  if (!data) return { position: null, paths: [] };
  const coordinates = (latitude, longitude) => Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { lat: latitude, lng: longitude } : null;
  if (response.mode === "air") {
    const actualEvents = (data.events || []).filter((event) => event.actual === true);
    const ordered = actualEvents.every((event) => Number.isFinite(Date.parse(event.eventTimeUtc)))
      ? [...actualEvents].sort((left, right) => Date.parse(right.eventTimeUtc) - Date.parse(left.eventTimeUtc))
      : [...actualEvents].sort((left, right) => (right.orderId ?? 0) - (left.orderId ?? 0));
    const latest = ordered[0];
    const point = latest && coordinates(latest.lat, latest.lng);
    return { paths: [], position: point ? { point, kind: "airport", label: "Last reported airport", observedAt: latest.eventTimeUtc || latest.eventTime || "", localTime: !latest.eventTimeUtc, place: latest.airportCode || latest.airportName || "", source: "Panvaya carrier milestone", cachedAt: response.cachedAt, cached: response.cached } : null };
  }
  const current = data.route_data?.current_position;
  const point = current && coordinates(current.latitude, current.longitude);
  const paths = (data.route_data?.segments || []).map((segment) => {
    if (!Array.isArray(segment.path)) return [];
    const points = segment.path.map((pair) => Array.isArray(pair) ? coordinates(pair[1], pair[0]) : null);
    return points.every(Boolean) && points.length > 1 ? points : [];
  }).filter((path) => path.length);
  return {
    paths,
    position: point ? { point, kind: current.estimated === false ? "reported" : "estimated", label: current.estimated === false ? "Carrier-reported position" : "Provider-estimated position", observedAt: current.observed_at || "", localTime: false, source: current.source || "Panvaya", cachedAt: response.cachedAt, cached: response.cached } : null,
  };
}

export function withLiveTracking(shipment, response) {
  const data = response.data;
  const air = response.mode === "air";
  const locations = new Map((data.locations || []).map((location) => [location.id, location]));
  const transports = new Map((data.transports || []).map((transport) => [transport.id, transport]));
  const stageSequences = air ? { RCS: 1, FOH: 2, DEP: 4, ARR: 7, RCF: 8, NFD: 9, AWD: 10, DLV: 11 } : { GTIN: 1, LOAD: 3, DEPA: 4, ARRI: 7, DISC: 8 };
  const arrivalLocationId = data.journey?.port_of_discharge?.location_id ?? data.journey?.destination?.location_id;
  const sourceEvents = air ? data.events || [] : (data.containers || []).flatMap((container) => (container.events || []).map((event) => ({ ...event, containerNumber: container.number })));
  const events = sourceEvents.map((event, index) => {
    const code = air ? event.code : event.event_code;
    const location = locations.get(event.location_id);
    const transport = transports.get(event.transport_id);
    const arrivalEvent = air ? ["ARR", "RCF"].includes(code) : ["ARRI", "DISC"].includes(code);
    const finalArrival = air ? !!data.destinationAirportCode && event.airportCode === data.destinationAirportCode : arrivalLocationId != null && event.location_id === arrivalLocationId;
    return {
      seq: arrivalEvent && !finalArrival ? 5 : stageSequences[code] || 0,
      key: `${event.containerNumber || "air"}-${event.id ?? event.orderId ?? index}`,
      datetime: air ? event.eventTime : event.event_time,
      type: code || (air ? event.description : event.event_name) || "Unknown",
      description: [air ? event.description : event.event_name, event.containerNumber, transport?.name, transport?.voyage_number].filter(Boolean).join(" / "),
      location: air ? event.airportCode || event.airportName : location?.locode || location?.name,
      actual: event.actual === true,
      localTime: air,
    };
  });
  const destination = data.journey?.destination || data.journey?.port_of_discharge;
  const origin = data.journey?.origin || data.journey?.port_of_lading;
  const eta = air ? data.arrivalEstimated || data.arrivalActual : destination?.estimated_arrival_at || destination?.actual_arrival_at;
  const etd = air ? data.departureEstimated || data.departureActual : origin?.estimated_departure_at || origin?.actual_departure_at;
  const etaDate = eta ? air ? eta.slice(0, 10) : formatEventDate(eta) : UNAVAILABLE;
  const etaTime = eta ? air ? `${eta.slice(11, 16)} (airport local)` : `${new Date(eta).toISOString().slice(11, 16)} UTC` : UNAVAILABLE;
  const vessel = air ? data.flightNumber : (data.transports || []).find((transport) => transport.mode === "vessel")?.name;
  const containers = new Map(shipment.containers.map((container) => [container.number, container]));
  for (const container of data.containers || []) {
    const existing = containers.get(container.number);
    const equipment = container.equipment;
    const template = Object.fromEntries(Object.keys(shipment.containers[0] || {}).map((key) => [key, UNKNOWN]));
    containers.set(container.number, { ...template, ...existing, number: container.number || UNKNOWN, typeCode: equipment?.iso_code || equipment?.carrier_code || existing?.typeCode || UNKNOWN, iso: equipment?.iso_code || existing?.iso || UNKNOWN, description: equipment?.description || existing?.description || UNKNOWN, status: container.status || existing?.status || UNKNOWN, vessel: vessel || existing?.vessel || UNKNOWN, route: shipment.route });
  }
  if ((data.containers || []).some((container) => container.number)) containers.delete(UNKNOWN);
  return {
    ...shipment,
    liveTracking: response,
    status: data.status || UNAVAILABLE,
    eta: eta || UNAVAILABLE,
    etaDate,
    etaTime,
    carrierEta: eta || UNAVAILABLE,
    etd: etd || UNAVAILABLE,
    vessel: vessel || UNAVAILABLE,
    events,
    containers: air ? [] : [...containers.values()],
  };
}

export function trackingEventDateTime(event) {
  if (!event.datetime) return UNAVAILABLE;
  return event.localTime ? `${event.datetime.replace("T", " ")} (${event.location || "airport"} local)` : formatEventDateTime(event.datetime);
}

function normalize(record, masterByCode) {
  const etd = first(record, "ETD Load", "Origin ETD", "1st Leg STD", "ETD First Load");
  const eta = first(record, "Destination ETA");
  const carrierEta = first(record, "ETA Last Discharge");
  const routePorts = routePortsFor(record);
  return {
    id: first(record, "Shipment ID"),
    reference: first(record, "House Ref", "ContainerNum", "Consol ID", "Order Ref"),
    mode: modeName(record.Trans),
    load: record.Mode || UNAVAILABLE,
    service: first(record, "Service Level Code") || (record.Trans ? `${modeName(record.Trans)} Freight` : UNAVAILABLE),
    route: routePorts.join(" → ") || UNAVAILABLE,
    routePorts,
    routingLegs: routingLegsFor(record),
    origin: record.Origin || UNAVAILABLE,
    destination: record.Destination || UNAVAILABLE,
    consignee: record["Consignee Name"] || UNAVAILABLE,
    shipper: record["Consignor Name"] || UNAVAILABLE,
    customer: unavailable("status").value,
    booking: record.Master || UNAVAILABLE,
    hbl: record["House Ref"] || UNAVAILABLE,
    container: containerSummary(record),
    cargo: record["Goods Description"] || UNAVAILABLE,
    weight: [record.Weight, record["WEIGHT UQ"]].filter(Boolean).join(" ") || UNAVAILABLE,
    volume: [record.Volume, record["Volume UQ"]].filter(Boolean).join(" ") || UNAVAILABLE,
    containers: containerDetails(record, masterByCode),
    etd: etd || UNAVAILABLE,
    eta: eta || UNAVAILABLE,
    etaTime: unavailable("status"),
    carrierEta: carrierEta || UNAVAILABLE,
    status: unavailable("status"),
    confidence: unavailable("confidence"),
    originalEta: unavailable("originalEta"),
    aiEta: unavailable("aiEta"),
    risk: unavailable("risk"),
    cause: unavailable("cause"),
    milestones: unavailable("milestones"),
    coordinates: unavailable("coordinates"),
    vessel: first(record, "Vessel", "Flight/Voyage") || UNAVAILABLE,
    raw: record,
  };
}

export function isBooked(shipment) { return Boolean(shipment.raw?.Master); }
export function searchableShipmentText(shipment) {
  const raw = shipment.raw || {};
  return [shipment.id, shipment.reference, shipment.hbl, shipment.container, shipment.booking, raw.ContainerNum, raw["Consol ID"], raw["Order Ref"], raw.Master, raw["House Ref"]]
    .filter(Boolean).join(" ").toLowerCase();
}
export function isDeparted(shipment, now = new Date()) {
  const etd = etaTimestamp(shipment.etd);
  return !Number.isNaN(etd) && etd <= now.getTime();
}
export function isInTransit(shipment, now = new Date()) {
  if (shipment.routingLegs.length < 3) return false;
  const current = now.getTime();
  const tolerance = 24 * 60 * 60 * 1000;
  return shipment.routingLegs.slice(1, 3).some((leg) => {
    const etd = etaTimestamp(leg.etd);
    const eta = etaTimestamp(leg.eta);
    if (Number.isNaN(etd) && Number.isNaN(eta)) return false;
    const start = Number.isNaN(etd) ? eta : etd;
    const end = Number.isNaN(eta) ? etd : eta;
    return current >= start - tolerance && current <= end + tolerance;
  });
}
export function isArrived(shipment, now = new Date()) {
  const eta = etaTimestamp(shipment.eta);
  return !Number.isNaN(eta) && eta <= now.getTime();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatEventDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE;
  return `${String(date.getUTCDate()).padStart(2, "0")}-${MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)}`;
}
export function formatEventDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return UNAVAILABLE;
  return `${formatEventDate(value)} ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} UTC`;
}

// Event sequence ranges that drive each lifecycle milestone.
const MILESTONE_SEQUENCES = [
  { label: "Picked Up", description: "Shipment collected from origin", seqs: [1, 2, 3] },
  { label: "Departed", description: "Left origin facility", seqs: [4] },
  { label: "In Transit", description: "On the way to destination", seqs: [5, 6] },
  { label: "Arriving", description: "Reaching destination facility", seqs: [7, 8, 9, 10] },
  { label: "Delivered", description: "Shipment successfully delivered", seqs: [11] },
];

function eventLifecycle(shipment) {
  const stages = MILESTONE_SEQUENCES.map(({ label, description, seqs }) => {
    const reached = shipment.events.filter((event) => seqs.includes(event.seq) && event.actual !== false);
    const latest = reached[reached.length - 1];
    return { label, description, date: latest?.datetime ? latest.localTime ? latest.datetime.slice(0, 10) : formatEventDate(latest.datetime) : "", reached: reached.length > 0 };
  });
  const activeIndex = stages.reduce((index, stage, position) => (stage.reached ? position : index), 0);
  return { stages, activeIndex, status: stages[activeIndex].label, transportMode: shipment.raw?.Trans };
}

export function shipmentLifecycle(shipment, now = new Date()) {
  if (shipment.liveTracking) {
    const lifecycle = eventLifecycle(shipment);
    const delivered = String(shipment.status).toLowerCase() === "delivered";
    return { ...lifecycle, activeIndex: delivered ? 4 : lifecycle.activeIndex, status: String(shipment.status).replace(/_/g, " ") };
  }
  if (shipment.events?.length) return eventLifecycle(shipment);
  const departed = isDeparted(shipment, now);
  const arrived = isArrived(shipment, now);
  const transit = departed && !arrived;
  const stages = [
    { label: "Picked Up", description: "Shipment collected from origin", date: first(shipment.raw, "Origin ETD", "ETD First Load") },
    { label: "Departed", description: "Left origin facility", date: shipment.etd },
    { label: "In Transit", description: "On the way to destination", date: shipment.routingLegs[1]?.etd || shipment.etd },
    { label: "Arriving", description: "Reaching destination facility", date: shipment.eta },
    { label: "Delivered", description: "Shipment successfully delivered", date: shipment.eta },
  ];
  const activeIndex = arrived ? 4 : transit ? 2 : departed ? 1 : 0;
  return { stages, activeIndex, status: stages[activeIndex].label, transportMode: shipment.raw?.Trans };
}

async function loadShipmentEvents() {
  try {
    const response = await fetch("/tracking-events.csv");
    if (!response.ok) return {};
    const byShipment = {};
    parseCsv(await response.text()).forEach((record) => {
      const seq = Number.parseInt(record.event_seq, 10);
      if (!record.shipment_no || Number.isNaN(seq)) return;
      (byShipment[record.shipment_no] ||= []).push({ seq, datetime: record.event_datetime, type: record.event_type, description: record.event_description, location: record.event_location });
    });
    Object.values(byShipment).forEach((events) => events.sort((a, b) => a.seq - b.seq));
    return byShipment;
  } catch {
    return {};
  }
}

let lastRefresh = "";
export function trackingRefreshedAt() {
  if (!lastRefresh) return "";
  const date = new Date(lastRefresh);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export async function loadTrackingData(request = api.get) {
  const [history, masterResponse] = await Promise.all([request("/tracking/shipments"), fetch("/container-master.csv")]);
  lastRefresh = history.refreshedAt || "";
  if (!masterResponse.ok) throw new Error(`Unable to load container master data (${masterResponse.status})`);
  const masterByCode = Object.fromEntries(parseCsv(await masterResponse.text()).map((record) => [record.Code, record]));
  return (history.records || []).map((record) => normalize(record, masterByCode)).filter((shipment) => shipment.id).map((shipment) => ({ ...shipment, events: history.eventsByShipment?.[shipment.id] || [] }));
}

export function displayValue(value) {
  return typeof value === "object" && value?.value ? value.value : value || UNAVAILABLE;
}

export function mappingName(value) {
  return typeof value === "object" && value?.mapping ? value.mapping : "";
}

export function isWithinNextDays(value, from = new Date("2026-09-14T00:00:00Z"), days = 7) {
  const parsed = etaTimestamp(value);
  if (Number.isNaN(parsed)) return false;
  const start = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const end = start + days * 24 * 60 * 60 * 1000;
  return parsed >= start && parsed <= end;
}

export function etaTimestamp(value) {
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{2})$/.exec(value || "");
  if (!match) return Number.NaN;
  const [, day, month, year] = match;
  const monthIndex = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].indexOf(month);
  if (monthIndex < 0) return Number.NaN;
  return Date.UTC(2000 + Number(year), monthIndex, Number(day));
}
