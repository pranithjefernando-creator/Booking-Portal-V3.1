import { readFile, stat } from "node:fs/promises";
import { parse } from "csv-parse/sync";
import { effectiveModules } from "../rbac.js";
import { reference, orgCodeForName } from "../reference.js";
import { sqlTrackingRecords } from "./trackingDb.js";

const DATASET = new URL("../../../Tracking - Sample Dataset.csv", import.meta.url);
const EVENTS = new URL("../../data/tracking-events.csv", import.meta.url);
let cachedDataset;

function normalized(value) { return String(value || "").trim().toUpperCase(); }
function partyKey(name) {
  return orgCodeForName(name) || `tracking:${normalized(name)}`;
}

export function trackingPartyOptions(records) {
  const options = new Map();
  for (const record of records) {
    for (const field of ["Consignor Name", "Consignee Name"]) {
      const name = String(record[field] || "").trim();
      if (name) options.set(partyKey(name), { code: partyKey(name), label: name });
    }
  }
  return options;
}

export function trackingOrganizations(records) {
  const options = new Map(reference.cwOrg.map((org) => [org.code, org]));
  for (const [code, option] of trackingPartyOptions(records)) options.set(code, option);
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

export function canSeeTracking(user, record) {
  if (!user || !effectiveModules(user).includes("tracking")) return false;
  const allowed = new Set(Array.isArray(user.trackingOrgs) ? user.trackingOrgs : []);
  const organizations = [record["CW Org Code"], record["Consignor Code"], record["Consignee Code"], ...["Consignor Name", "Consignee Name"].filter((field) => record[field]).map((field) => partyKey(record[field]))].filter(Boolean);
  return organizations.some((organization) => allowed.has(organization));
}

export function historicalPorts(records) {
  const ports = new Set();
  for (const record of records) {
    if (normalized(record.Trans) !== "SEA") continue;
    for (let leg = 1; leg <= 4; leg += 1) {
      for (const value of [record[`Leg ${leg}-Load`] || record[`Leg ${leg} - Load`], record[`Leg ${leg} - Discharge`] || record[`Leg ${leg}-Discharge`]]) {
        const code = normalized(value);
        if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(code)) ports.add(code);
      }
    }
  }
  return [...ports];
}

export function requireTracking(req, res, next) {
  if (!effectiveModules(req.user).includes("tracking")) return res.status(403).json({ error: "Tracking module access is not enabled" });
  next();
}

export function canTrackReference(records, identity) {
  const { payload, mode } = identity;
  return records.some((record) => {
    if (mode === "air") return normalized(record.Trans) === "AIR" && normalized(record.Master).replace(/[\s-]/g, "") === payload.awb.replace(/-/g, "");
    if (normalized(record.Trans) !== "SEA") return false;
    if (payload.container && !String(record.ContainerNum || "").split(",").map(normalized).includes(payload.container)) return false;
    if (payload.bol && normalized(record.Master) !== payload.bol) return false;
    if (payload.bk && normalized(record["Booking Number"] || record["Booking No"]) !== payload.bk) return false;
    return true;
  });
}

export async function trackingRecords() {
  const sqlRecords = await sqlTrackingRecords();
  if (sqlRecords) return sqlRecords;
  const info = await stat(DATASET);
  if (cachedDataset?.mtimeMs === info.mtimeMs && cachedDataset.size === info.size) return cachedDataset.records;
  const records = parse(await readFile(DATASET, "utf8"), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  cachedDataset = { mtimeMs: info.mtimeMs, size: info.size, records };
  return records;
}

export async function trackingHistory(user) {
  return (await trackingRecords()).filter((record) => canSeeTracking(user, record));
}

export async function shipmentEvents(records) {
  const ids = new Set(records.map((record) => record["Shipment ID"]));
  const events = parse(await readFile(EVENTS, "utf8"), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true });
  const byShipment = {};
  for (const event of events) {
    const seq = Number.parseInt(event.event_seq, 10);
    if (!ids.has(event.shipment_no) || !Number.isFinite(seq)) continue;
    (byShipment[event.shipment_no] ||= []).push({ seq, datetime: event.event_datetime, type: event.event_type, description: event.event_description, location: event.event_location });
  }
  for (const milestones of Object.values(byShipment)) milestones.sort((left, right) => left.seq - right.seq);
  return byShipment;
}