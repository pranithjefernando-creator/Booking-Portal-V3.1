import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsv, routingLegsFor } from "../src/trackingData.js";
import { locationCoordinates, routeCoverage } from "../src/lib/locations.js";

const reference = JSON.parse(await readFile(new URL("../src/data/location-reference.json", import.meta.url), "utf8"));
const knownIssues = JSON.parse(await readFile(new URL("../src/data/location-issues.json", import.meta.url), "utf8"));
const coordinates = locationCoordinates(reference);
if (Object.keys(coordinates).length < 10000) throw new Error("Coordinate reference is missing or incomplete. Run npm run update:locations.");
const dataset = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL("../../Tracking - Sample Dataset.csv", import.meta.url);
const rows = parseCsv(await readFile(dataset, "utf8"));
const missing = new Map();
const codes = new Set();
for (const row of rows) {
  const coverage = routeCoverage({ routingLegs: routingLegsFor(row) }, coordinates);
  for (const leg of coverage.legs) for (const code of [leg.load, leg.discharge]) if (code) codes.add(code);
  for (const code of coverage.missingCodes) missing.set(code, [...(missing.get(code) || []), row["Shipment ID"]]);
}
const unexpected = [...missing.keys()].filter((code) => !knownIssues[code]);
console.log(`Location coverage: ${codes.size - missing.size}/${codes.size} leg codes across ${rows.length} shipments`);
for (const [code, shipments] of missing) console.warn(`${code}: ${shipments.length} shipment(s); ${knownIssues[code] || "NEW UNMAPPED CODE"}`);
if (unexpected.length) {
  console.error(`New unmapped location codes: ${unexpected.join(", ")}. Refresh the reference or verify the source data; do not add guessed coordinates.`);
  process.exitCode = 1;
}