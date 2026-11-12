import { closeBookingDatabase, initializeBookingDatabase } from "./bookingDatabase.js";

try {
  await initializeBookingDatabase();
  console.log("Booking PostgreSQL schema initialized and verified.");
} catch (error) {
  console.error(`Booking schema initialization failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { await closeBookingDatabase(); }
  catch (error) {
    console.error(`Booking database shutdown failed: ${error.message}`);
    process.exitCode = 1;
  }
}
