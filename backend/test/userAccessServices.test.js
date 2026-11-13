import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createUserAccessServices } from "../src/lib/userAccessServices.js";

const secret = "service-test-secret-with-at-least-32-bytes";

test("access services require a stable secret and valid token lifetime", () => {
  const pool = {};
  for (const value of [undefined, "", "short", " ".repeat(32)]) {
    assert.throws(() => createUserAccessServices(pool, { AUTH_SECRET: value }), /AUTH_SECRET.*at least 32 bytes/);
  }
  for (const value of ["", " ", "0", "-1", "Infinity", "NaN", "1000000000000", "0.00000001"]) {
    assert.throws(() => createUserAccessServices(pool, { AUTH_SECRET: secret, AUTH_TOKEN_TTL_HOURS: value }), /AUTH_TOKEN_TTL_HOURS/);
  }
  assert.ok(createUserAccessServices(pool, { AUTH_SECRET: secret }));
  assert.ok(createUserAccessServices(pool, { AUTH_SECRET: secret, AUTH_TOKEN_TTL_HOURS: "0.5" }));
});

test("all access stores propagate PostgreSQL failures without fallback", async () => {
  const pool = {
    async query() { throw new Error("simulated PostgreSQL outage"); },
    async connect() { throw new Error("simulated PostgreSQL outage"); }
  };
  const services = createUserAccessServices(pool, { AUTH_SECRET: secret });
  await assert.rejects(services.users.list(), /simulated PostgreSQL outage/);
  await assert.rejects(services.settings.listRoles(), /simulated PostgreSQL outage/);
  await assert.rejects(services.configurations.listProfiles(), /simulated PostgreSQL outage/);
  await assert.rejects(services.authentication.login("user@example.invalid", "Test-Password1"), /simulated PostgreSQL outage/);
});

test("backend fails before listening for invalid access configuration or schema failure", async () => {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const loader = new URL("./fixtures/accessServicesStartupLoader.js", import.meta.url).href;
  const cases = [
    { secret: undefined, ttl: undefined, expected: /AUTH_SECRET.*at least 32 bytes/ },
    { secret: "short", ttl: undefined, expected: /AUTH_SECRET.*at least 32 bytes/ },
    { secret: " ".repeat(32), ttl: undefined, expected: /AUTH_SECRET.*at least 32 bytes/ },
    { secret, ttl: "0", expected: /AUTH_TOKEN_TTL_HOURS/ },
    { secret, ttl: "8", failure: "1", expected: /simulated user database failure/ }
  ];
  for (const item of cases) {
    const env = {
      ...process.env, PGHOST: "localhost", PGDATABASE: "test", PGUSER: "test", PGPASSWORD: "test",
      PORT: "0", TEST_ACCESS_SCHEMA_FAILURE: item.failure || "0"
    };
    delete env.AUTH_SECRET;
    delete env.AUTH_TOKEN_TTL_HOURS;
    if (item.secret !== undefined) env.AUTH_SECRET = item.secret;
    if (item.ttl !== undefined) env.AUTH_TOKEN_TTL_HOURS = item.ttl;
    const child = spawn(process.execPath, ["--experimental-loader", loader, "server.js"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const [code] = await once(child, "close");
    assert.notEqual(code, 0);
    assert.match(output, /User access PostgreSQL startup failed:/);
    assert.match(output, item.expected);
    assert.doesNotMatch(output, /SBMS API on/);
    assert.doesNotMatch(output, /using a random secret/);
    if (item.secret && item.secret.trim()) assert.equal(output.includes(item.secret), false);
  }
});
