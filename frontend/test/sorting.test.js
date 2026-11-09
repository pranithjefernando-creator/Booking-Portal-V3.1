import assert from "node:assert/strict";
import test from "node:test";
import { sortRecords } from "../src/lib/sorting.js";

const records = [{ value: "10" }, { value: "2" }, { value: "" }, { value: "Alpha" }];

test("sorts text naturally and does not mutate the source records", () => {
  const sorted = sortRecords(records, "value");
  assert.deepEqual(sorted.map((record) => record.value), ["2", "10", "Alpha", ""]);
  assert.deepEqual(records.map((record) => record.value), ["10", "2", "", "Alpha"]);
});

test("sorts descending while keeping empty values last", () => {
  assert.deepEqual(sortRecords(records, "value", "desc").map((record) => record.value), ["Alpha", "10", "2", ""]);
});

test("returns original order when no sort column is selected", () => {
  assert.equal(sortRecords(records, "").map((record) => record.value).join(","), "10,2,,Alpha");
});
