import assert from "node:assert/strict";
import test from "node:test";
import { cargoLinkedOrderIds, planCargoOrderLinks } from "../src/lib/bookingOrderLinks.js";

test("editing cargo links preserves orders linked outside cargo lines", () => {
  const linked = new Set(["external", "removed", "kept"]);
  const cargo = cargoLinkedOrderIds([{ orderId: "removed" }, { orderId: "kept" }, { orderId: "unlinked" }], linked);
  const changes = planCargoOrderLinks([{ orderId: "kept" }, { orderId: "new" }, { orderId: "new" }], linked, cargo);
  assert.deepEqual(changes.toLink, ["new"]);
  assert.deepEqual(changes.toUnlink, ["removed"]);
  assert.deepEqual([...changes.selected], ["kept", "new"]);
});
