import { createBookingPool } from "./bookingStore.js";
import { cleanupExpiredProviderCache } from "./providerCacheCleanup.js";

let pool;
try {
  pool = createBookingPool();
  console.log("Provider cache cleanup:", await cleanupExpiredProviderCache(pool));
} catch (error) {
  console.error(`Provider cache cleanup failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) {
    try { await pool.end(); }
    catch (error) { console.error(`Provider cache database shutdown failed: ${error.message}`); process.exitCode = 1; }
  }
}
