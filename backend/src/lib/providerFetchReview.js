import { createAuditStore } from "./auditStore.js";

export async function listUncertainProviderFetches(pool) {
  const { rows } = await pool.query(`SELECT lease_id, provider_account, provider_environment, cache_kind, cache_key,
      state, started_at, expires_at
    FROM booking_portal_v4.provider_fetch_leases
    WHERE state = 'uncertain' OR expires_at <= clock_timestamp()
    ORDER BY started_at, lease_id LIMIT 200`);
  return rows.map((row) => ({
    id: row.lease_id, account: row.provider_account, environment: row.provider_environment,
    kind: row.cache_kind, key: row.cache_key, state: row.state,
    startedAt: row.started_at.toISOString(), expiresAt: row.expires_at.toISOString()
  }));
}

export async function releaseUncertainProviderFetch(pool, { id, operator, notes, workerStopped }) {
  if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error("A valid lease ID is required");
  if (typeof operator !== "string" || !operator.trim() || operator.length > 200) throw new Error("An operator name of at most 200 characters is required");
  if (typeof notes !== "string" || !notes.trim() || notes.length > 2000) throw new Error("Review notes of at most 2000 characters are required");
  if (workerStopped !== true) throw new Error("Confirm the original worker has stopped before releasing this lease");
  const client = await pool.connect();
  let started = false;
  let releaseError;
  try {
    await client.query("BEGIN");
    started = true;
    const { rows } = await client.query(`SELECT provider_account, provider_environment, cache_kind, cache_key, state
      FROM booking_portal_v4.provider_fetch_leases
      WHERE lease_id = $1 AND (state = 'uncertain' OR expires_at <= clock_timestamp()) FOR UPDATE`, [id]);
    if (!rows.length) throw new Error("Reviewable provider request not found");
    const lease = rows[0];
    await createAuditStore(client).append({
      user: { name: operator.trim(), role: "operator" }, action: "PROVIDER_FETCH_RETRY_APPROVED",
      entityType: "ProviderFetch", entityId: id,
      after: { account: lease.provider_account, environment: lease.provider_environment, kind: lease.cache_kind, key: lease.cache_key, notes: notes.trim() }
    });
    await client.query("DELETE FROM booking_portal_v4.provider_fetch_leases WHERE lease_id = $1", [id]);
    await client.query("COMMIT");
    started = false;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { releaseError = rollbackError; console.error("[provider-coordination] review rollback failed:", rollbackError.message); }
    }
    throw error;
  } finally { client.release(releaseError); }
}
