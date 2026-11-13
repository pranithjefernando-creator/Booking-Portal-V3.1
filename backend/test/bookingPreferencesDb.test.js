import { getRole } from "../src/rbac.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { closeBookingDatabase } from "../src/lib/bookingDatabase.js";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createApp } from "../src/lib/http.js";
import bookingsRouter from "../src/routes/bookings.js";

test("booking preferences persist across server restarts and remain user-scoped", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const owner = { ...db.users[0], email: `${randomUUID()}@example.invalid` };
  const other = { ...owner, email: `${randomUUID()}@example.invalid` };
  const pool = createBookingPool();
  let server;
  async function start() {
    const app = createApp();
    app.use((req, res, next) => { req.user = req.header("x-test-other") ? other : owner; req.accessRole = getRole(req.user.role); next(); });
    app.use("/bookings", bookingsRouter);
    server = app.listen(0);
    await once(server, "listening");
    return `http://127.0.0.1:${server.address().port}/bookings`;
  }
  async function stop() {
    if (server) {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server = undefined;
    }
    await closeBookingDatabase();
  }
  const post = (url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    let base = await start();
    const filters = [{ field: "status", operator: "eq", value: "DRAFT" }];
    const [first, second, filter] = await Promise.all([
      post(`${base}/layouts`, { name: "First", columns: ["reference"] }),
      post(`${base}/layouts`, { name: "Second", columns: ["status"] }),
      post(`${base}/filters`, { name: "Draft", filters })
    ]);
    assert.deepEqual([first.status, second.status, filter.status], [201, 201, 201]);
    await stop();
    base = await start();
    const layouts = (await (await fetch(`${base}/layouts/list`)).json()).layouts;
    assert.equal(layouts.length, 2);
    assert.deepEqual((await (await fetch(`${base}/filters/list`)).json()).layouts[0].filters, filters);
    assert.deepEqual((await (await fetch(`${base}/layouts/list`, { headers: { "x-test-other": "1" } })).json()).layouts, []);
    assert.equal((await fetch(`${base}/layouts/${layouts[0].id}`, { method: "DELETE" })).status, 200);
    assert.equal((await (await fetch(`${base}/layouts/list`)).json()).layouts.length, 1);
  } finally {
    await stop();
    try {
      await pool.query("DELETE FROM booking_portal_v4.preferences WHERE owner_email = ANY($1::text[])", [[owner.email, other.email]]);
    } finally {
      await pool.end();
    }
  }
});
