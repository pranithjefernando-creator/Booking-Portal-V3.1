import assert from "node:assert/strict";
import test from "node:test";
import { applySearchFilters } from "../src/lib/searchFilters.js";

const records = [
  { reference: "BK-100", weight: 12.5, cargoReadyDate: "2025-02-14T08:30:00Z", isDg: true },
  { reference: "BK-200", weight: 8, cargoReadyDate: "2025-03-01", isDg: false },
  { reference: "BK-300", weight: null, cargoReadyDate: null, isDg: false }
];

test("string filters match case-insensitively and combine with AND", () => {
  const result = applySearchFilters(records, [
    { field: "reference", operator: "contains", value: "bk-", type: "text" },
    { field: "reference", operator: "neq", value: "BK-200", type: "text" }
  ]);
  assert.deepEqual(result.map((record) => record.reference), ["BK-100", "BK-300"]);
});

test("numeric filters compare numbers and reject missing values", () => {
  const result = applySearchFilters(records, [{ field: "weight", operator: "gt", value: "10", type: "number" }]);
  assert.deepEqual(result.map((record) => record.weight), [12.5]);
});

test("date filters compare calendar dates when records include timestamps", () => {
  const result = applySearchFilters(records, [{ field: "cargoReadyDate", operator: "eq", value: "2025-02-14", type: "date" }]);
  assert.deepEqual(result.map((record) => record.reference), ["BK-100"]);
});

test("boolean filters support explicit true and false values", () => {
  const result = applySearchFilters(records, [{ field: "isDg", operator: "eq", value: "true", type: "boolean" }]);
  assert.deepEqual(result.map((record) => record.reference), ["BK-100"]);
});
