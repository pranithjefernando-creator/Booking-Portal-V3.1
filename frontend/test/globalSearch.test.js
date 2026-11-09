import assert from "node:assert/strict";
import test from "node:test";
import { globalSearchPath } from "../src/lib/globalSearch.js";

test("global search routes explicit order references to orders", () => {
  assert.equal(globalSearchPath("PO-88213", { canViewOrders: true }), "/orders?q=PO-88213");
  assert.equal(globalSearchPath("ORD 123", { canViewOrders: true }), "/orders?q=ORD%20123");
});

test("global search routes order-only matches to orders", () => {
  assert.equal(globalSearchPath("Lanka Engineering", {
    bookingItems: [],
    orderItems: [{ id: "order-1" }],
    canViewOrders: true
  }), "/orders?q=Lanka%20Engineering");
});

test("global search preserves booking results when a term matches both modules", () => {
  assert.equal(globalSearchPath("sample garments", {
    bookingItems: [{ id: "booking-1" }],
    orderItems: [{ id: "order-1" }],
    canViewOrders: true
  }), "/bookings?q=sample%20garments");
});

test("global search uses bookings when order access is unavailable", () => {
  assert.equal(globalSearchPath("PO-88213", { canViewOrders: false }), "/bookings?q=PO-88213");
});
