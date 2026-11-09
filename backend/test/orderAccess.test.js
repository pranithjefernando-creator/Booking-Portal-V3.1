import assert from "node:assert/strict";
import test from "node:test";
import { canSeeOrder } from "../src/db.js";

const user = { role: "Ops", orderOrgs: ["SUPPLIER", "BUYER"] };

test("order visibility matches the assigned supplier organization or buyer code", () => {
  assert.equal(canSeeOrder(user, { cwOrgCode: "SUPPLIER" }), true);
  assert.equal(canSeeOrder(user, { cwOrgCode: "OTHER", buyerCode: "BUYER" }), true);
  assert.equal(canSeeOrder(user, { buyerCode: "BUYER" }), true);
  assert.equal(canSeeOrder(user, { cwOrgCode: "OTHER", buyerCode: "OTHER" }), false);
});
