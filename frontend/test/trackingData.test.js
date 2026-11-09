import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTrackingData, parseCsv, withLiveTracking } from "../src/trackingData.js";

async function loadCsv(csv) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(url === "/container-master.csv" ? "Code,Description\n" : url === "/tracking-events.csv" ? "shipment_no,event_seq\n" : csv);
  try { return await loadTrackingData(async () => ({ records: parseCsv(csv), eventsByShipment: {} })); }
  finally { globalThis.fetch = originalFetch; }
}

test("splits comma-separated containers and derives only the populated leg route", async () => {
  const [shipment] = await loadCsv('Shipment ID,Trans,ContainerNum,Origin,Destination,Load,Discharge,Leg 1-Load,Leg 1 - Discharge,Leg 2-Load,Leg 2 - Discharge\nTEST,SEA," caiu7505969, MSBU8093580,CAIU7505969, ",AEKLF,ESVLC,AEKLF,INMUN,USORD,LULUX,LULUX,BEBRU');
  assert.deepEqual(shipment.containers.map((container) => container.number), ["CAIU7505969", "MSBU8093580"]);
  assert.deepEqual(shipment.routePorts, ["USORD", "LULUX", "BEBRU"]);
  assert.equal(shipment.route, "USORD → LULUX → BEBRU");
  assert.deepEqual(shipment.routingLegs.map(({ load, discharge }) => [load, discharge]), [["USORD", "LULUX"], ["LULUX", "BEBRU"]]);
  assert.ok(shipment.containers.every((container) => container.route === shipment.route));
});

test("retains return stops and reads all four legs in order", async () => {
  const [shipment] = await loadCsv("Shipment ID,Leg 1-Load,Leg 1 - Discharge,Leg 2-Load,Leg 2 - Discharge,Leg 3-Load,Leg 3 - Discharge,Leg 4-Load,Leg 4 - Discharge\nTEST,AAA,BBB,BBB,AAA,AAA,CCC,CCC,DDD");
  assert.deepEqual(shipment.routePorts, ["AAA", "BBB", "AAA", "CCC", "DDD"]);
  assert.equal(shipment.routingLegs.length, 4);
});

test("does not invent a route from unrelated fields when legs are empty", async () => {
  const [shipment] = await loadCsv("Shipment ID,Origin,Destination,Load,Discharge,Leg 1 - ETD\nTEST,AAA,BBB,CCC,DDD,2026-10-15");
  assert.deepEqual(shipment.routePorts, []);
  assert.equal(shipment.route, "Not Available Now");
  assert.deepEqual(shipment.routingLegs, []);
});

test("the reported shipment has two containers and exactly its two recorded legs", async () => {
  const csv = await readFile(new URL("../../Tracking - Sample Dataset.csv", import.meta.url), "utf8");
  const shipment = (await loadCsv(csv)).find((item) => item.id === "S15126281793");
  assert.ok(shipment);
  assert.deepEqual(shipment.containers.map((container) => container.number), ["CAIU7505969", "MSBU8093580"]);
  assert.equal(shipment.route, "USORD → LULUX → BEBRU");
  assert.deepEqual(shipment.routingLegs.map((leg) => leg.leg), [1, 2]);
});

test("partial provider results preserve every CSV container and its leg-derived route", async () => {
  const [shipment] = await loadCsv('Shipment ID,Trans,ContainerNum,Leg 1-Load,Leg 1 - Discharge\nTEST,SEA,"CAIU7505969,MSBU8093580",USORD,LULUX');
  const enriched = withLiveTracking(shipment, { mode: "ocean", data: { status: "in_transit", containers: [{ number: "CAIU7505969", equipment: { iso_code: "42G1", description: "Dry container" }, status: "loaded", events: [] }] } });
  assert.deepEqual(enriched.containers.map((container) => container.number), ["CAIU7505969", "MSBU8093580"]);
  assert.equal(enriched.containers[0].iso, "42G1");
  assert.equal(enriched.containers[0].status, "loaded");
  assert.equal(enriched.containers[1].iso, "Unknown");
  assert.equal(enriched.route, "USORD → LULUX");
  assert.ok(enriched.containers.every((container) => container.route === enriched.route));
});