import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { etaTimestamp, parseCsv, routingLegsFor } from "../src/trackingData.js";
import { decodeLocationCoordinates, locationCoordinates, routeCoverage } from "../src/lib/locations.js";

test("decodes source coordinates and rejects missing or invalid values", () => {
  assert.deepEqual(decodeLocationCoordinates("2550N 08017W"), [25.833333, -80.283333]);
  assert.deepEqual(decodeLocationCoordinates("0000S 00000E"), [0, 0]);
  for (const value of ["", "unknown", "9060N 18000E", "9100N 00000E", "0000N 18100E"]) assert.equal(decodeLocationCoordinates(value), null);
});

test("uses valid reference coordinates without accepting guesses or invalid points", () => {
  const coordinates = locationCoordinates({ locations: { USMIA: [25.8, -80.3], USORD: [null, 0], BAD: [1, 2] } }, { USMIA: [1, 2] });
  assert.deepEqual(coordinates.USMIA, [25.8, -80.3]);
  assert.equal(coordinates.USORD, undefined);
  assert.equal(coordinates.BAD, undefined);
});

test("distinguishes mapped legs, same-location stops, unknown codes and incomplete legs", () => {
  const result = routeCoverage({ routingLegs: [{ leg: 1, load: "USORD", discharge: "USMIA" }, { leg: 2, load: "USMIA", discharge: "USMIA" }, { leg: 3, load: "USMIA", discharge: "ZZZZZ" }, { leg: 4, load: "USORD", discharge: "" }] }, { USORD: [41.9, -87.9], USMIA: [25.8, -80.3] });
  assert.deepEqual(result.legs.map((leg) => leg.status), ["mapped", "stationary", "unmapped", "incomplete"]);
  assert.deepEqual(result.missingCodes, ["ZZZZZ"]);
  assert.equal(result.legs[2].to, undefined);
});

test("the bundled reference resolves all six initial shipments without invented movement", async () => {
  const reference = JSON.parse(await readFile(new URL("../src/data/location-reference.json", import.meta.url), "utf8"));
  const coordinates = locationCoordinates(reference);
  assert.ok(Object.keys(coordinates).length > 90000);
  for (const code of ["USORD", "USMIA", "CNSUZ", "USEFG", "VNVUT"]) assert.ok(coordinates[code], code);
  const rows = parseCsv(await readFile(new URL("../../Tracking - Sample Dataset.csv", import.meta.url), "utf8"));
  const initial = rows.sort((left, right) => etaTimestamp(right["Destination ETA"]) - etaTimestamp(left["Destination ETA"])).slice(0, 6);
  const coverages = initial.map((row) => routeCoverage({ routingLegs: routingLegsFor(row) }, coordinates));
  assert.deepEqual(coverages.flatMap((coverage) => coverage.missingCodes), []);
  assert.equal(coverages.filter((coverage) => coverage.legs.some((leg) => leg.status === "mapped")).length, 4);
  assert.equal(coverages.filter((coverage) => coverage.legs.every((leg) => leg.status === "stationary")).length, 2);
});

test("new dataset location gaps require explicit review instead of disappearing silently", async () => {
  const reference = JSON.parse(await readFile(new URL("../src/data/location-reference.json", import.meta.url), "utf8"));
  const knownIssues = JSON.parse(await readFile(new URL("../src/data/location-issues.json", import.meta.url), "utf8"));
  const coordinates = locationCoordinates(reference);
  const rows = parseCsv(await readFile(new URL("../../Tracking - Sample Dataset.csv", import.meta.url), "utf8"));
  const missing = [...new Set(rows.flatMap((row) => routeCoverage({ routingLegs: routingLegsFor(row) }, coordinates).missingCodes))];
  assert.deepEqual(missing.filter((code) => !knownIssues[code]), [], `New unmapped location codes: ${missing.join(", ")}`);
  assert.ok(reference.sources.some((source) => source.license === "MIT" && source.notice.includes("Permission is hereby granted")));
});

test("the build coverage check rejects a newly introduced unmapped code", async () => {
  const directory = await mkdtemp(join(tmpdir(), "efl-location-check-"));
  try {
    const dataset = join(directory, "new-tracking.csv");
    await writeFile(dataset, "Shipment ID,Leg 1-Load,Leg 1 - Discharge\nTEST,USMIA,ZZZZZ\n");
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/check-locations.mjs", import.meta.url)), dataset], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /New unmapped location codes: ZZZZZ/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});