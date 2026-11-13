import { randomUUID } from "node:crypto";
import { bookingDatabasePool } from "./bookingDatabase.js";
import { configuredProviderScope, validProviderScope } from "./providerCacheStore.js";

export function createProviderPortRetryStore(pool, getScope) {
  async function query(sql, params = [], client = pool) {
    const scope = getScope();
    if (!validProviderScope(scope)) {
      throw Object.assign(new Error("Configure non-secret Panvaya cache scope labels"), { status: 503, code: "PROVIDER_CACHE_UNAVAILABLE" });
    }
    try { return await client.query(sql, [scope.account, scope.environment, ...params]); }
    catch (error) {
      console.error("[port-retry] PostgreSQL operation failed:", error.message);
      throw Object.assign(new Error("Provider retry database is unavailable", { cause: error }), { status: 503, code: "PROVIDER_CACHE_UNAVAILABLE" });
    }
  }
  return {
    async schedule(code, fetchedAt, client) {
      await query(`INSERT INTO booking_portal_v4.provider_port_retries
        (provider_account, provider_environment, port_code, retry_id, cache_fetched_at, due_at)
        SELECT $1, $2, $3, $4, $5, clock_timestamp() + interval '1 minute'
        FROM booking_portal_v4.provider_port_cache
        WHERE provider_account = $1 AND provider_environment = $2 AND port_code = $3
          AND source = 'rate-limited' AND fetched_at = $5::timestamptz
        ON CONFLICT (provider_account, provider_environment, port_code) DO UPDATE
        SET retry_id = EXCLUDED.retry_id, cache_fetched_at = EXCLUDED.cache_fetched_at, due_at = EXCLUDED.due_at`,
      [code, randomUUID(), new Date(fetchedAt)], client);
    },
    async discardPort(code, client) {
      await query(`DELETE FROM booking_portal_v4.provider_port_retries
        WHERE provider_account = $1 AND provider_environment = $2 AND port_code = $3`, [code], client);
    },
    async discard(id, client) {
      await query(`DELETE FROM booking_portal_v4.provider_port_retries
        WHERE provider_account = $1 AND provider_environment = $2 AND retry_id = $3`, [id], client);
    },
    async getDue(id) {
      const { rows } = await query(`SELECT retry_id, port_code, cache_fetched_at
        FROM booking_portal_v4.provider_port_retries
        WHERE provider_account = $1 AND provider_environment = $2 AND retry_id = $3 AND due_at <= clock_timestamp()`, [id]);
      return rows[0] || null;
    },
    async listDue() {
      const { rows } = await query(`SELECT r.retry_id, r.port_code, r.cache_fetched_at
        FROM booking_portal_v4.provider_port_retries r
        WHERE r.provider_account = $1 AND r.provider_environment = $2 AND r.due_at <= clock_timestamp()
          AND NOT EXISTS (SELECT 1 FROM booking_portal_v4.provider_fetch_leases l
            WHERE l.provider_account = r.provider_account AND l.provider_environment = r.provider_environment
              AND l.cache_kind = 'port' AND l.cache_key = r.port_code)
        ORDER BY r.due_at, r.retry_id LIMIT 20`);
      return rows;
    }
  };
}

export const providerPortRetryStore = createProviderPortRetryStore(
  { query: (...args) => bookingDatabasePool().query(...args) },
  configuredProviderScope
);
