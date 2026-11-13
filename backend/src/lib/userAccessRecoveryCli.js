import { createBookingPool } from "./bookingStore.js";
import { recoverAdministratorPassword } from "./userAccessRecovery.js";

let pool;
try {
  pool = createBookingPool();
  await recoverAdministratorPassword(pool, {
    email: process.env.RECOVERY_ADMIN_EMAIL,
    password: process.env.RECOVERY_ADMIN_PASSWORD
  });
  console.log("Administrator password reset. Change it at next login.");
} catch (error) {
  console.error(`Administrator recovery failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  delete process.env.RECOVERY_ADMIN_PASSWORD;
  if (pool) {
    try { await pool.end(); }
    catch (error) {
      console.error(`User access database shutdown failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
