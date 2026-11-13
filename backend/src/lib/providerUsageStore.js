import { randomUUID } from "node:crypto";
import { bookingDatabasePool } from "./bookingDatabase.js";
import { configuredProviderScope, validProviderScope } from "./providerCacheStore.js";

function quotaError(message, cause) {
  return Object.assign(new Error(message, { cause }), { status: 503, code: "PROVIDER_QUOTA_UNAVAILABLE" });
}

export function createProviderUsageStore(pool, getScope) {
  function scope() {
    const value = getScope();
    if (!validProviderScope(value)) throw quotaError("Configure non-secret PANVAYA_CACHE_ACCOUNT and PANVAYA_CACHE_ENVIRONMENT labels");
    return { account: value.account, environment: value.environment };
  }

  async function run(operation) {
    try { return await operation(); }
    catch (error) {
      if (error.code === "PROVIDER_QUOTA_UNAVAILABLE") throw error;
      console.error("[provider-quota] PostgreSQL operation failed:", error.message);
      throw quotaError("Provider quota database is unavailable", error);
    }
  }

  return {
    async reserve(rateLimit, monthlyQuota) {
      const currentScope = scope();
      return run(async () => {
        const client = await pool.connect();
        let started = false;
        let releaseError;
        try {
          await client.query("BEGIN");
          started = true;
          const params = [currentScope.account, currentScope.environment];
          await client.query(`INSERT INTO booking_portal_v4.provider_usage (provider_account, provider_environment, month_start)
            VALUES ($1, $2, date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::date)
            ON CONFLICT (provider_account, provider_environment) DO NOTHING`, params);
          const usage = (await client.query(`SELECT month_start::text, monthly_count
            FROM booking_portal_v4.provider_usage WHERE provider_account = $1 AND provider_environment = $2 FOR UPDATE`, params)).rows[0];
          const time = (await client.query(`SELECT t.ts::text AS ts, date_trunc('month', t.ts AT TIME ZONE 'UTC')::date::text AS month_start,
            (SELECT blocked_until > t.ts FROM booking_portal_v4.provider_usage
             WHERE provider_account = $1 AND provider_environment = $2) AS blocked,
            (SELECT count(*)::int FROM booking_portal_v4.provider_request_events
             WHERE provider_account = $1 AND provider_environment = $2 AND requested_at > t.ts - interval '1 minute') AS calls_last_minute
            FROM (SELECT clock_timestamp() AS ts) t`, params)).rows[0];
          const monthlyCount = usage.month_start === time.month_start ? usage.monthly_count : "0";
          const allowed = !time.blocked &&
            time.calls_last_minute < rateLimit && Number(monthlyCount) < monthlyQuota;
          if (allowed) {
            await client.query(`UPDATE booking_portal_v4.provider_usage SET month_start = $3::date, monthly_count = $4::bigint + 1
              WHERE provider_account = $1 AND provider_environment = $2`, [...params, time.month_start, monthlyCount]);
            await client.query(`INSERT INTO booking_portal_v4.provider_request_events
              (provider_account, provider_environment, request_id, requested_at) VALUES ($1, $2, $3, $4)`,
            [...params, randomUUID(), time.ts]);
          }
          await client.query("COMMIT");
          started = false;
          return allowed ? currentScope : null;
        } catch (error) {
          if (started) {
            try { await client.query("ROLLBACK"); }
            catch (rollbackError) { releaseError = rollbackError; console.error("[provider-quota] rollback failed:", rollbackError.message); }
          }
          throw error;
        } finally { client.release(releaseError); }
      });
    },
    async recordBackoff(currentScope, delayMs) {
      return run(async () => {
        const { rowCount } = await pool.query(`UPDATE booking_portal_v4.provider_usage
          SET blocked_until = GREATEST(COALESCE(blocked_until, '-infinity'::timestamptz), clock_timestamp() + $3 * interval '1 millisecond')
          WHERE provider_account = $1 AND provider_environment = $2`,
        [currentScope.account, currentScope.environment, delayMs]);
        if (rowCount !== 1) throw new Error("Missing provider usage reservation for backoff");
      });
    },
    async stats() {
      const currentScope = scope();
      return run(async () => {
        const { rows } = await pool.query(`SELECT
          COALESCE((SELECT CASE WHEN month_start = date_trunc('month', t.ts AT TIME ZONE 'UTC')::date
            THEN monthly_count ELSE 0 END FROM booking_portal_v4.provider_usage
            WHERE provider_account = $1 AND provider_environment = $2), 0)::text AS monthly_count,
          (SELECT count(*)::int FROM booking_portal_v4.provider_request_events
            WHERE provider_account = $1 AND provider_environment = $2 AND requested_at > t.ts - interval '1 minute') AS calls_last_minute
          FROM (SELECT clock_timestamp() AS ts) t`, [currentScope.account, currentScope.environment]);
        return { callsThisMonth: Number(rows[0].monthly_count), callsLastMinute: rows[0].calls_last_minute };
      });
    }
  };
}

export const providerUsageStore = createProviderUsageStore(
  { connect: () => bookingDatabasePool().connect(), query: (...args) => bookingDatabasePool().query(...args) },
  configuredProviderScope
);
