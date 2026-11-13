import { randomUUID } from "node:crypto";
import { createBookingPool } from "./bookingStore.js";
import { createRelationalBookingStore } from "./bookingRelationalStore.js";
import { checkRelationalBookingReadiness, initializeRelationalBookingSchema } from "./bookingRelationalSchema.js";
import { checkProviderCacheReadiness, initializeProviderCacheSchema } from "./providerCacheSchema.js";

let pool;
let store;

export function bookingDatabase() {
  if (!store) {
    pool = createBookingPool();
    store = createRelationalBookingStore(pool, { allocateReference: () => `BKV4-${randomUUID()}` });
  }
  return store;
}

export function bookingDatabasePool() {
  bookingDatabase();
  return pool;
}

export async function initializeBookingDatabase() {
  bookingDatabase();
  await initializeRelationalBookingSchema(pool);
  await initializeProviderCacheSchema(pool);
}

export async function checkBookingDatabase() {
  bookingDatabase();
  await checkRelationalBookingReadiness(pool);
  await checkProviderCacheReadiness(pool);
}

export async function closeBookingDatabase() {
  if (!pool) return;
  const activePool = pool;
  pool = undefined;
  store = undefined;
  await activePool.end();
}
