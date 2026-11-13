import assert from "node:assert/strict";
import test from "node:test";
import { affectedShipmentsFor, isCongested, loadPortCongestion } from "../src/portCongestion.js";

test("only reported congestion is highlighted, not mock or rate-limited placeholders", () => {
  assert.equal(isCongested({ source: "live", congestionLevel: "High" }), true);
  assert.equal(isCongested({ source: "live", congestionLevel: "Low" }), false);
  for (const source of ["mock", "fallback", "rate-limited", "unknown", "error"]) assert.equal(isCongested({ source, congestionLevel: "High" }), false);
});
test("only active ocean shipments become affected shipment alerts", () => {
  const ocean = { id: "SEA", mode: "Ocean", routePorts: ["SGSIN"], eta: "2099-01-01" };
  const air = { ...ocean, id: "AIR", mode: "Air" };
  const arrived = { ...ocean, id: "OLD", eta: "2020-01-01" };
  const results = affectedShipmentsFor([ocean, air, arrived], { SGSIN: { source: "live", congestionLevel: "High" } }, new Date("2026-10-15"));
  assert.deepEqual(results.map(({ shipment }) => shipment.id), ["SEA"]);
});

test("large scoped histories are batched without silently dropping ports", async () => {
  const ports = Array.from({ length: 65 }, (_, index) => `US${String(index).padStart(3, "0")}`);
  const sizes = [];
  const result = await loadPortCongestion(ports, async (path, body) => {
    assert.equal(path, "/port-congestion/lookup");
    sizes.push(body.ports.length);
    return { ports: Object.fromEntries(body.ports.map((code) => [code, { unloco: code, source: "live", congestionLevel: "High" }])) };
  });

  assert.deepEqual(sizes, [60, 5]);
  assert.equal(Object.keys(result).length, 65);
});

test("cached results never bypass renewed authorization or database errors", async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    if (calls === 1) return { ports: { SGSIN: { unloco: "SGSIN", source: "live" } } };
    throw new Error("Provider cache database is unavailable");
  };
  assert.equal((await loadPortCongestion(["SGSIN"], request)).SGSIN.source, "live");
  await assert.rejects(loadPortCongestion(["SGSIN"], request), /database is unavailable/);
  assert.equal(calls, 2);
  await assert.rejects(loadPortCongestion(["SGSIN"], async () => ({ ports: {} })), /Invalid port congestion response/);
});