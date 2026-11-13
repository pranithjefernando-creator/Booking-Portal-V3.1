import { randomUUID } from "node:crypto";
import { createBookingPool } from "../../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../../src/lib/bookingRelationalStore.js";
import { checkRelationalBookingReadiness, verifyRelationalBookingSchema } from "../../src/lib/bookingRelationalSchema.js";

const schema = process.env.TEST_BOOKING_SCHEMA;
if (!/^booking_session_[a-f0-9]{32}$/.test(schema || "")) throw new Error("Invalid test booking schema");
let pool;
let store;
export function bookingDatabase() {
  if (!store) {
    pool = createBookingPool();
    const scoped = {
      query: (sql, params) => pool.query(sql.replaceAll("booking_portal_v4.", `${schema}.`), params),
      async connect() {
        const client = await pool.connect();
        return { query: (sql, params) => client.query(sql.replaceAll("booking_portal_v4.", `${schema}.`), params), release: (error) => client.release(error) };
      }
    };
    store = createRelationalBookingStore(scoped, { allocateReference: () => `TEST-${randomUUID()}` });
  }
  return store;
}
export async function initializeBookingDatabase() {
  bookingDatabase();
  await verifyRelationalBookingSchema(pool, schema);
}
export async function checkBookingDatabase() {
  bookingDatabase();
  await checkRelationalBookingReadiness(pool, schema);
}
export async function closeBookingDatabase() {
  store = undefined;
  if (pool) await pool.end();
  pool = undefined;
}
