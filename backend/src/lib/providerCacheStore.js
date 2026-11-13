import { bookingDatabasePool } from "./bookingDatabase.js";
import { config } from "./config.js";

function cacheError(message, cause) {
  return Object.assign(new Error(message, { cause }), { status: 503, code: "PROVIDER_CACHE_UNAVAILABLE" });
}

export function validProviderScope({ account, environment, apiKey }) {
  return !!account && !!environment && account === account.trim() && environment === environment.trim() &&
    !(apiKey && (account === apiKey || environment === apiKey));
}

export function configuredProviderScope() {
  return { account: config.freightPulse.cacheAccount, environment: config.freightPulse.cacheEnvironment, apiKey: config.freightPulse.apiKey };
}

export function createProviderCacheStore(queryable, getScope) {
  async function query(sql, params = [], client = queryable) {
    const scope = getScope();
    const { account, environment } = scope;
    if (!validProviderScope(scope)) {
      throw cacheError("Configure non-secret PANVAYA_CACHE_ACCOUNT and PANVAYA_CACHE_ENVIRONMENT labels");
    }
    try {
      return await client.query(sql, [account, environment, ...params]);
    } catch (error) {
      console.error("[provider-cache] PostgreSQL operation failed:", error.message);
      throw cacheError("Provider cache database is unavailable", error);
    }
  }

  return {
    async getTracking(key) {
      const { rows } = await query(`SELECT result, error FROM booking_portal_v4.provider_tracking_cache
        WHERE provider_account = $1 AND provider_environment = $2 AND request_key = $3 AND expires_at > now()`, [key]);
      return rows[0] || null;
    },
    async putTracking(key, result, error, fetchedAt, ttl, client) {
      await query(`INSERT INTO booking_portal_v4.provider_tracking_cache
        (provider_account, provider_environment, request_key, result, error, fetched_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider_account, provider_environment, request_key) DO UPDATE
        SET result = EXCLUDED.result, error = EXCLUDED.error, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at
        WHERE booking_portal_v4.provider_tracking_cache.fetched_at <= EXCLUDED.fetched_at`,
      [key, result, error, new Date(fetchedAt), new Date(fetchedAt + ttl)], client);
    },
    async getPort(code) {
      const { rows } = await query(`SELECT result, fetched_at FROM booking_portal_v4.provider_port_cache
        WHERE provider_account = $1 AND provider_environment = $2 AND port_code = $3 AND expires_at > now()`, [code]);
      return rows[0] || null;
    },
    async getPortForRetry(code) {
      const { rows } = await query(`SELECT result, fetched_at FROM booking_portal_v4.provider_port_cache
        WHERE provider_account = $1 AND provider_environment = $2 AND port_code = $3`, [code]);
      return rows[0] || null;
    },
    async putPort(code, result, fetchedAt, ttl, client) {
      await query(`INSERT INTO booking_portal_v4.provider_port_cache
        (provider_account, provider_environment, port_code, result, source, fetched_at, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (provider_account, provider_environment, port_code) DO UPDATE
        SET result = EXCLUDED.result, source = EXCLUDED.source, fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at
        WHERE booking_portal_v4.provider_port_cache.fetched_at <= EXCLUDED.fetched_at`,
      [code, result, result.source, new Date(fetchedAt), new Date(fetchedAt + ttl)], client);
    },
    async countPorts() {
      const { rows } = await query(`SELECT count(*)::int AS count FROM booking_portal_v4.provider_port_cache
        WHERE provider_account = $1 AND provider_environment = $2`);
      return rows[0].count;
    }
  };
}

export const providerCacheStore = createProviderCacheStore(
  { query: (...args) => bookingDatabasePool().query(...args) },
  configuredProviderScope
);
