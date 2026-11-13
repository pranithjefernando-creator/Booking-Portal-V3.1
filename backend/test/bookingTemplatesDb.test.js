import { getRole } from "../src/rbac.js";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { db, seed } from "../src/db.js";
import { bookingDatabase, closeBookingDatabase } from "../src/lib/bookingDatabase.js";
import { createApp } from "../src/lib/http.js";
import bookingsRouter from "../src/routes/bookings.js";

test("booking templates survive a server restart and remain owner-scoped", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  seed();
  const owner = db.users[0];
  const other = { ...owner, email: `${randomUUID()}@example.invalid` };
  const name = `test-${randomUUID()}`;
  let templateId;
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
  try {
    let base = await start();
    const create = await fetch(`${base}/templates`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, data: { mode: "Air", cargoLines: [{ id: "line", packages: 5 }] } })
    });
    assert.equal(create.status, 201);
    templateId = (await create.json()).id;
    const sameName = await Promise.all([0, 1].map(() => fetch(`${base}/templates`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.toUpperCase(), data: { mode: "Air" } })
    })));
    assert.deepEqual(sameName.map((response) => response.status), [200, 200]);
    for (const response of sameName) assert.equal((await response.json()).id, templateId);
    await stop();
    base = await start();
    const list = await (await fetch(`${base}/templates`)).json();
    assert.equal(list.templates.filter((template) => template.id === templateId).length, 1);
    assert.equal((await fetch(`${base}/templates/${templateId}`, { headers: { "x-test-other": "1" } })).status, 404);
    await fetch(`${base}/templates/${templateId}`, { method: "DELETE", headers: { "x-test-other": "1" } });
    assert.equal((await fetch(`${base}/templates/${templateId}`)).status, 200);
    assert.equal((await fetch(`${base}/templates/${templateId}`, { method: "DELETE" })).status, 200);
    assert.equal((await fetch(`${base}/templates/${templateId}`)).status, 404);
  } finally {
    if (templateId) await bookingDatabase().deleteTemplate(owner.email, templateId);
    await stop();
  }
});
