import { createBookingPool } from "./bookingStore.js";
import { listUncertainProviderFetches, releaseUncertainProviderFetch } from "./providerFetchReview.js";

let pool;
try {
  const args = process.argv.slice(2);
  if (!(args.length === 1 && args[0] === "list") &&
      !(args.length === 5 && args[0] === "release" && args[4] === "--confirm-worker-stopped")) {
    throw new Error('Usage: list | release <lease-id> <operator> "<review notes>" --confirm-worker-stopped');
  }
  pool = createBookingPool();
  if (args[0] === "list") console.log(JSON.stringify(await listUncertainProviderFetches(pool), null, 2));
  else {
    await releaseUncertainProviderFetch(pool, { id: args[1], operator: args[2], notes: args[3], workerStopped: true });
    console.log("Retry approved. A new request may be billable and will consume quota.");
  }
} catch (error) {
  console.error(`Provider request review failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (pool) {
    try { await pool.end(); }
    catch (error) { console.error(`Provider database shutdown failed: ${error.message}`); process.exitCode = 1; }
  }
}
