import { validateProviderCacheSchemaName } from "./providerCacheSchema.js";

const BATCH_SIZE = 1000;

export async function cleanupExpiredProviderCache(pool, schema = "booking_portal_v4") {
  validateProviderCacheSchemaName(schema);
  const client = await pool.connect();
  let started = false;
  let releaseError;
  try {
    await client.query("BEGIN");
    started = true;
    const counts = {};
    for (const [table, timeColumn, cutoff] of [
      ["provider_tracking_cache", "expires_at", "now()"],
      ["provider_port_cache", "expires_at", "now()"],
      ["provider_request_events", "requested_at", "now() - interval '1 minute'"]
    ]) {
      const { rowCount } = await client.query(`WITH expired AS (
        SELECT ctid FROM "${schema}"."${table}" WHERE "${timeColumn}" < ${cutoff}
        ORDER BY "${timeColumn}" LIMIT $1 FOR UPDATE SKIP LOCKED
      ) DELETE FROM "${schema}"."${table}" AS target USING expired WHERE target.ctid = expired.ctid`, [BATCH_SIZE]);
      counts[table] = rowCount;
    }
    await client.query("COMMIT");
    started = false;
    return counts;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { releaseError = rollbackError; console.error(`Provider cache cleanup rollback failed: ${rollbackError.message}`); }
    }
    throw error;
  } finally { client.release(releaseError); }
}
