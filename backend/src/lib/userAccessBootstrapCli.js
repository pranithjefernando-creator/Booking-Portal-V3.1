import { createBookingPool } from "./bookingStore.js";
import { initializeUserAccessSchema } from "./userAccessSchema.js";
import { bootstrapUserAccess } from "./userAccessBootstrap.js";

let pool;
try {
  pool = createBookingPool();
  await initializeUserAccessSchema(pool);
  await bootstrapUserAccess(pool, {
    name: process.env.BOOTSTRAP_ADMIN_NAME,
    email: process.env.BOOTSTRAP_ADMIN_EMAIL,
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD
  });
  console.log("First administrator created. Change the password at first login.");
} catch (error) {
  console.error(`Administrator bootstrap failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  delete process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (pool) {
    try { await pool.end(); }
    catch (error) {
      console.error(`User access database shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
