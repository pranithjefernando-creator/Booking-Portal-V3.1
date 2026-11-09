import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseCsv, routingLegsFor } from "../src/trackingData.js";
import { decodeLocationCoordinates } from "../src/lib/locations.js";

async function download(repository, branch, path) {
  const revisionResponse = await fetch(`https://api.github.com/repos/${repository}/commits/${branch}`, { headers: { "User-Agent": "EFL-One-location-reference" } });
  if (!revisionResponse.ok) throw new Error(`Cannot resolve ${repository} revision (${revisionResponse.status})`);
  const revision = (await revisionResponse.json()).sha;
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid location reference revision");
  const sourceUrl = `https://raw.githubusercontent.com/${repository}/${revision}/${path}`;
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Cannot download ${repository} (${response.status})`);
  return { sourceUrl, revision, text: await response.text() };
}

function validPoint(point) {
  return Array.isArray(point) && point.length === 2 && point.every(Number.isFinite) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180;
}

const locodes = await download("datasets/un-locode", "main", "data/code-list.csv");
const ports = await download("marchah/sea-ports", "master", "lib/ports.json");
const airports = await download("datasets/airport-codes", "main", "data/airport-codes.csv");
const licenseResponse = await fetch(`https://raw.githubusercontent.com/marchah/sea-ports/${ports.revision}/LICENSE`);
if (!licenseResponse.ok) throw new Error("Cannot download seaport license notice");
const portLicense = await licenseResponse.text();
const rows = parseCsv(locodes.text);
const locations = {};
for (const row of rows) {
  const code = `${row.Country}${row.Location}`.toUpperCase();
  const coordinates = decodeLocationCoordinates(row.Coordinates);
  if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(code) && coordinates && row.Change !== "X") locations[code] = coordinates;
}
let portSupplements = 0;
for (const [code, port] of Object.entries(JSON.parse(ports.text))) {
  const coordinates = Array.isArray(port.coordinates) ? [port.coordinates[1], port.coordinates[0]] : null;
  if (!locations[code] && /^[A-Z]{2}[A-Z0-9]{3}$/.test(code) && validPoint(coordinates)) { locations[code] = coordinates; portSupplements += 1; }
}
const airportByCode = new Map();
for (const airport of parseCsv(airports.text)) {
  if (!airport.iata_code || airport.type === "closed") continue;
  const coordinates = airport.coordinates.split(",").map((value) => value.trim() ? Number(value) : NaN);
  if (!validPoint(coordinates)) continue;
  const key = `${airport.iso_country}:${airport.iata_code}`;
  airportByCode.set(key, [...(airportByCode.get(key) || []), { coordinates, municipality: airport.municipality }]);
}
let airportSupplements = 0;
for (const row of rows) {
  const code = `${row.Country}${row.Location}`;
  if (locations[code] || row.Change === "X") continue;
  const matches = airportByCode.get(`${row.Country}:${row.IATA || row.Location}`);
  const municipalityMatch = matches?.length === 1 && row.NameWoDiacritics && matches[0].municipality.toLowerCase() === row.NameWoDiacritics.toLowerCase();
  if (matches?.length === 1 && (row.Function[3] === "4" || municipalityMatch)) { locations[code] = matches[0].coordinates; airportSupplements += 1; }
}
const trackingRows = parseCsv(await readFile(new URL("../../Tracking - Sample Dataset.csv", import.meta.url), "utf8"));
const trackingCodes = [...new Set(trackingRows.flatMap((row) => routingLegsFor(row).flatMap((leg) => [leg.load, leg.discharge])).filter((code) => /^[A-Z]{2}[A-Z0-9]{3}$/.test(code)))];
const missingCodes = trackingCodes.filter((code) => !locations[code]);
let wikidataSource;
if (missingCodes.length) {
  const query = `SELECT ?code ?coordinates WHERE { VALUES ?code { ${missingCodes.slice(0, 100).map((code) => JSON.stringify(code)).join(" ")} } ?place wdt:P1937 ?code; wdt:P625 ?coordinates. }`;
  const url = new URL("https://query.wikidata.org/sparql");
  url.searchParams.set("query", query);
  url.searchParams.set("format", "json");
  const result = await fetch(url, { headers: { Accept: "application/sparql-results+json", "User-Agent": "EFL-One-location-reference/1.0" }, signal: AbortSignal.timeout(20000) });
  if (!result.ok) throw new Error(`Cannot check exact-code coordinate supplements (${result.status})`);
  const candidates = new Map();
  for (const binding of (await result.json()).results.bindings) {
    const code = binding.code.value;
    const match = /^Point\((-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)\)$/.exec(binding.coordinates.value);
    const point = match ? [Number(match[2]), Number(match[1])] : null;
    if (missingCodes.includes(code) && validPoint(point)) candidates.set(code, [...(candidates.get(code) || []), point]);
  }
  for (const [code, points] of candidates) if (new Set(points.map((point) => JSON.stringify(point))).size === 1) locations[code] = points[0];
  wikidataSource = { sourceUrl: url.href, license: "CC0-1.0", matchedCodes: [...candidates.keys()].filter((code) => locations[code]) };
}
if (Object.keys(locations).length < 10000) throw new Error("Downloaded location reference is unexpectedly small");
const reference = { sources: [{ sourceUrl: locodes.sourceUrl, revision: locodes.revision, license: "ODC-PDDL-1.0" }, { sourceUrl: ports.sourceUrl, revision: ports.revision, license: "MIT", notice: portLicense }, { sourceUrl: airports.sourceUrl, revision: airports.revision, license: "ODC-PDDL-1.0" }, ...(wikidataSource ? [wikidataSource] : [])], generatedAt: new Date().toISOString(), locations: Object.fromEntries(Object.entries(locations).sort(([left], [right]) => left.localeCompare(right))) };
await mkdir(new URL("../src/data/", import.meta.url), { recursive: true });
await writeFile(new URL("../src/data/location-reference.json", import.meta.url), `${JSON.stringify(reference)}\n`);
console.log(`Generated ${Object.keys(locations).length} coordinates (${portSupplements} seaport and ${airportSupplements} country-matched airport supplements)`);
for (const code of ["USORD", "USMIA", "CNSUZ", "USEFG", "VNVUT"]) console.log(JSON.stringify({ code, coordinates: locations[code] || null }));
console.log(`Unresolved shipment codes: ${trackingCodes.filter((code) => !locations[code]).join(", ") || "none"}`);