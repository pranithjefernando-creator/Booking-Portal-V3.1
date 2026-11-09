import assert from "node:assert/strict";
import test from "node:test";
import { FIELD_CATALOG, isFieldVisible } from "../src/lib/formVisibility.js";

test("visibility defaults to all fields and respects module-specific hidden fields", () => {
  assert.equal(isFieldVisible("booking", undefined, "originCode"), true);
  assert.equal(isFieldVisible("booking", ["originCode"], "originCode"), false);
  assert.equal(isFieldVisible("order", ["originCode"], "originCode"), false);
  assert.equal(isFieldVisible("order", [], "originCode"), true);
});

test("required fields stay visible even if a profile attempts to hide them", () => {
  for (const [module, fields] of Object.entries(FIELD_CATALOG)) {
    for (const field of fields.filter((item) => item.required)) {
      assert.equal(isFieldVisible(module, [field.key], field.key), true, `${module}: ${field.key}`);
    }
  }
});

test("field keys are unique within each module", () => {
  for (const fields of Object.values(FIELD_CATALOG)) {
    assert.equal(new Set(fields.map((field) => field.key)).size, fields.length);
  }
});
