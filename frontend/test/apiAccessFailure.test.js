import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/api.js";

test("access outages fail JSON, text and downloads and notify the access context", async () => {
  const old = { fetch: globalThis.fetch, localStorage: globalThis.localStorage, sessionStorage: globalThis.sessionStorage, window: globalThis.window };
  const events = [];
  globalThis.localStorage = { getItem: (key) => key === "sbms.token" ? "test-token" : "", removeItem() {} };
  globalThis.sessionStorage = { getItem: () => "", removeItem() {} };
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: "User access service is temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
  try {
    for (const operation of [() => api.get("/me"), () => api.getText("/bookings/id/cw-xml"), () => api.download("/bookings/id/documents/id/download"), () => api.blob("/bookings/id/documents/id")]) {
      await assert.rejects(operation(), (error) => error.status === 503 && /temporarily unavailable/.test(error.message));
    }
    assert.deepEqual(events, Array(4).fill("sbms:access-unavailable"));
  } finally {
    Object.assign(globalThis, old);
  }
});
