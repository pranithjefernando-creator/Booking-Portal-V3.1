import assert from "node:assert/strict";
import test from "node:test";
import { paginate } from "../src/lib/pagination.js";

const records = Array.from({ length: 329 }, (_, index) => ({ id: index + 1 }));
test("defaults to 25 records without changing the input", () => {
  const result = paginate(records);
  assert.equal(result.items.length, 25);
  assert.equal(result.pageCount, 14);
  assert.equal(result.start, 1);
  assert.equal(result.end, 25);
  assert.equal(records.length, 329);
});
test("advances through all records and handles a partial final page", () => {
  assert.equal(paginate(records, 2).items[0].id, 26);
  const last = paginate(records, 14);
  assert.deepEqual(last.items.map((record) => record.id), [326, 327, 328, 329]);
  assert.equal(last.start, 326);
  assert.equal(last.end, 329);
});
test("clamps a page after filtering or deleting records", () => {
  const result = paginate(records.slice(0, 3), 14);
  assert.equal(result.page, 1);
  assert.equal(result.items.length, 3);
});
test("supports different sizes and empty results", () => {
  assert.equal(paginate(records, 1, 50).items.length, 50);
  const empty = paginate([], 10);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.equal(empty.start, 0);
  assert.equal(empty.end, 0);
});
test("normalizes invalid, zero and fractional page inputs", () => {
  assert.equal(paginate(records, NaN).page, 1);
  assert.equal(paginate(records, -1).page, 1);
  assert.equal(paginate(records, 999).page, 14);
  assert.equal(paginate(records, 2.9).page, 2);
  assert.equal(paginate(records, 1, NaN).pageSize, 25);
  assert.equal(paginate(records, 1, 0).pageSize, 1);
});