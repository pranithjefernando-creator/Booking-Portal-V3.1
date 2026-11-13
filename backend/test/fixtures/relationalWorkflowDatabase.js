import { createBookingPool } from "../../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../../src/lib/bookingRelationalStore.js";

const pool = createBookingPool();
const store = createRelationalBookingStore(pool, { allocateReference: (_client, booking) => `TEST-HTTP-${booking.id}` });
export function bookingDatabase() { return store; }
export function bookingDatabasePool() { return pool; }
