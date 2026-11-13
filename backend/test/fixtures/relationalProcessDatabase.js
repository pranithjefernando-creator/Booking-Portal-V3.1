import { initializeBookingDatabase as initializeSchemas, checkBookingDatabase as checkSchemas, closeBookingDatabase as closeSchemas } from "../../src/lib/bookingDatabase.js";
import { createBookingPool } from "../../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../../src/lib/bookingRelationalStore.js";

let pool;
let store;
export function bookingDatabase() {
  if (!store) {
    pool = createBookingPool();
    store = createRelationalBookingStore(pool, { allocateReference: (_client, booking) => `TEST-PROCESS-${booking.id}` });
  }
  return store;
}
export function bookingDatabasePool() {
  bookingDatabase();
  return pool;
}
export async function initializeBookingDatabase() {
  await initializeSchemas();
  bookingDatabase();
}
export async function checkBookingDatabase() { await checkSchemas(); }
export async function closeBookingDatabase() {
  try { if (pool) await pool.end(); }
  finally {
    pool = undefined;
    store = undefined;
    await closeSchemas();
  }
}
