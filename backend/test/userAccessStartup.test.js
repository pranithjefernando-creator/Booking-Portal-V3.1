import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/lib/http.js";
import { apiReadiness } from "../src/lib/apiReadiness.js";
import { checkUserAccessDatabase, closeUserAccessDatabase, initializeUserAccessDatabase, userAccessServices } from "../src/lib/userAccessDatabase.js";

const serviceEnv = { AUTH_SECRET: "startup-test-secret-with-at-least-32-bytes" };

test("readiness reports each dependency, fails closed and recovers", async () => {
  let booking = true;
  let access = true;
  const app = createApp();
  app.get("/ready", apiReadiness(
    async () => { if (!booking) throw new Error("booking outage"); },
    async () => { if (!access) throw new Error("access outage"); }
  ));
  const server = app.listen(0);
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}/ready`;
  try {
    let response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.fromEntries(Object.entries(await response.json()).filter(([key]) => key.endsWith("Database"))), { bookingDatabase: "ready", userAccessDatabase: "ready" });
    access = false;
    response = await fetch(url);
    assert.equal(response.status, 503);
    let body = await response.json();
    assert.equal(body.bookingDatabase, "ready");
    assert.equal(body.userAccessDatabase, "unavailable");
    assert.equal(JSON.stringify(body).includes("access outage"), false);
    booking = false;
    body = await (await fetch(url)).json();
    assert.equal(body.bookingDatabase, "unavailable");
    assert.equal(body.userAccessDatabase, "unavailable");
    access = true;
    response = await fetch(url);
    assert.equal(response.status, 503);
    body = await response.json();
    assert.equal(body.bookingDatabase, "unavailable");
    assert.equal(body.userAccessDatabase, "ready");
    booking = true;
    assert.equal((await fetch(url)).status, 200);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("configured PostgreSQL user schema initializes and readiness requires active services", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  try {
    assert.throws(() => userAccessServices(), /not initialized/);
    await initializeUserAccessDatabase(serviceEnv);
    const services = userAccessServices();
    assert.equal(typeof services.users.list, "function");
    assert.equal(typeof services.settings.getAccess, "function");
    assert.equal(typeof services.authentication.login, "function");
    assert.equal(typeof services.configurations.listRules, "function");
    assert.equal(typeof services.authHandlers.middleware, "function");
    await checkUserAccessDatabase();
    await assert.rejects(initializeUserAccessDatabase({ AUTH_SECRET: "short" }), /AUTH_SECRET/);
    assert.throws(() => userAccessServices(), /not initialized/);
    await initializeUserAccessDatabase(serviceEnv);
    assert.notEqual(userAccessServices(), services);
    await closeUserAccessDatabase();
    assert.throws(() => userAccessServices(), /not initialized/);
    await assert.rejects(checkUserAccessDatabase(), /not initialized/);
    await initializeUserAccessDatabase(serviceEnv);
    await checkUserAccessDatabase();
  } finally {
    await closeUserAccessDatabase();
  }
});

test("backend stops before listening when user schema initialization fails", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/userStartupLoader.js", import.meta.url).href, "server.js"], {
    cwd, env: { ...process.env, PORT: "0", TEST_USER_STARTUP_FAILURE: "1", AUTH_SECRET: "startup-test-secret-with-at-least-32-bytes" }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const [code] = await once(child, "close");
  assert.notEqual(code, 0);
  assert.match(output, /User access PostgreSQL startup failed: simulated incompatible user schema/);
  assert.doesNotMatch(output, /SBMS API on/);
});

test("backend readiness exposes a user database outage", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const child = spawn(process.execPath, ["--experimental-loader", new URL("./fixtures/userStartupLoader.js", import.meta.url).href, "server.js"], {
    cwd, env: { ...process.env, PORT: String(port), TEST_USER_READY_FAILURE: "1", AUTH_SECRET: "startup-test-secret-with-at-least-32-bytes", SEED_DEFAULT_PASSWORD: "Test-Password1", TRACKING_DB_PASSWORD: "", ORDER_DB_PASSWORD: "", ORG_DB_PASSWORD: "" }, stdio: ["ignore", "ignore", "pipe"]
  });
  let errors = "";
  child.stderr.on("data", (chunk) => { errors += chunk; });
  try {
    let response;
    for (let attempt = 0; attempt < 200; attempt++) {
      if (child.exitCode !== null) throw new Error(`Backend exited: ${errors}`);
      try { response = await fetch(`http://127.0.0.1:${port}/api/ready`); break; }
      catch { await sleep(100); }
    }
    assert.ok(response, "Backend did not start");
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.bookingDatabase, "ready");
    assert.equal(body.userAccessDatabase, "unavailable");
    assert.doesNotMatch(JSON.stringify(body), /simulated user database outage/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
});
