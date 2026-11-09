import assert from "node:assert/strict";
import test from "node:test";
import { cargoValuesFromOrder } from "../src/lib/bookingOrderMapping.js";

test("booking cargo values use the linked order detail totals and units", () => {
  assert.deepEqual(cargoValuesFromOrder({
    weight: 99,
    weightUom: "LBS",
    volume: 99,
    volumeUom: "CF",
    quantity: 99,
    quantityUom: "BOX",
    orderLines: [
      { weight: 10, weightUom: "KGS", volume: 2, volumeUom: "M3", outerPacks: 3, outerPacksType: "CTN" },
      { weight: 5, weightUom: "KGS", volume: 1.5, volumeUom: "M3", outerPacks: 4, outerPacksType: "CTN" }
    ]
  }), {
    grossWeight: "15",
    weightUnit: "KGS",
    volume: "3.5",
    volumeUnit: "M3",
    packages: "7",
    packageTypeCode: "CTN"
  });
});

test("booking cargo values use order detail fields when there are no order lines", () => {
  assert.deepEqual(cargoValuesFromOrder({
    weight: 12,
    weightUom: "KGS",
    volume: 4,
    volumeUom: "M3",
    quantity: 6,
    quantityUom: "PLT"
  }), {
    grossWeight: "12",
    weightUnit: "KGS",
    volume: "4",
    volumeUnit: "M3",
    packages: "6",
    packageTypeCode: "PLT"
  });
});
