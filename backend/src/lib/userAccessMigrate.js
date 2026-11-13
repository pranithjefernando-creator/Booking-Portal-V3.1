import { createBookingPool } from "./bookingStore.js";
import { initializeUserAccessSchema } from "./userAccessSchema.js";

let pool;
try {
  pool = createBookingPool();
  await initializeUserAccessSchema(pool);
  console.log("User access PostgreSQL schema initialized and verified.");
} catch (error) {
  console.error(`User access schema initialization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) {
    try { await pool.end(); }
    catch (error) {
      console.error(`User access database shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
