import { createBookingPool } from "../../src/lib/bookingStore.js";
import { createUserAccessServices } from "../../src/lib/userAccessServices.js";
import { verifyUserAccessRuntime } from "../../src/lib/userAccessReadiness.js";
import { verifyUserAccessSchema } from "../../src/lib/userAccessSchema.js";

const schema = process.env.TEST_ACCESS_SCHEMA;
if (!/^access_session_[a-f0-9]{32}$/.test(schema || "")) throw new Error("Invalid test schema");
let pool;
let services;

export async function initializeUserAccessDatabase() {
  pool = createBookingPool();
  const translate = (sql) => sql.replaceAll("portal_access_v1.", `${schema}.`);
  const scoped = {
    query: (sql, params) => pool.query(translate(sql), params),
    async connect() {
      const client = await pool.connect();
      return { query: (sql, params) => client.query(translate(sql), params?.map((value) => value === "portal_access_v1" ? schema : value)), release: (error) => client.release(error) };
    }
  };
  await verifyUserAccessSchema(pool, schema);
  await verifyUserAccessRuntime(pool, schema);
  services = createUserAccessServices(scoped);
}
export function userAccessServices() {
  if (!services) throw new Error("Test user access services are not initialized");
  return services;
}
export async function checkUserAccessDatabase() {
  if (!services) throw new Error("User access services not initialized");
  await verifyUserAccessSchema(pool, schema);
  await verifyUserAccessRuntime(pool, schema);
}
export async function closeUserAccessDatabase() {
  services = undefined;
  if (pool) await pool.end();
  pool = undefined;
}
