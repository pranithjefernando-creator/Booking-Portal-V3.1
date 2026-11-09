import assert from "node:assert/strict";
import test from "node:test";
import { orderLineTotals } from "../src/lib/orderLineTotals.js";

test("order detail totals map and sum values from order lines", () => {
  assert.deepEqual(orderLineTotals([
    { weight: "10", weightUom: "KGS", volume: "2", volumeUom: "M3", outerPacks: "3", outerPacksType: "CTN" },
    { weight: "5", weightUom: "KGS", volume: "1.5", volumeUom: "M3", outerPacks: "4", outerPacksType: "CTN" }
  ]), {
    weight: 15,
    weightUom: "KGS",
    volume: 3.5,
    volumeUom: "M3",
    quantity: 7,
    quantityUom: "CTN"
  });
});

test("order detail totals leave unpopulated line values empty", () => {
  assert.deepEqual(orderLineTotals([{}]), {
    weight: "",
    weightUom: "",
    volume: "",
    volumeUom: "",
    quantity: "",
    quantityUom: ""
  });
});
