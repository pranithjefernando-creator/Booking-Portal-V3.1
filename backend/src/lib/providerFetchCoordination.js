import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { bookingDatabasePool } from "./bookingDatabase.js";
import { config } from "./config.js";
import { configuredProviderScope, validProviderScope } from "./providerCacheStore.js";

function coordinationError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { status: 503, code });
}

function uncertain(id, cause) {
  return coordinationError("PROVIDER_REQUEST_UNCERTAIN",
    `Provider request ${id} may have been billed. Manual review is required before retrying.`, cause);
}

export function createProviderFetchLeaseStore(pool, getScope) {
  function scope() {
    const value = getScope();
    if (!validProviderScope(value)) throw coordinationError("PROVIDER_COORDINATION_UNAVAILABLE", "Configure non-secret Panvaya cache scope labels");
    return [value.account, value.environment];
  }
  async function run(operation) {
    try { return await operation(); }
    catch (error) {
      if (["PROVIDER_REQUEST_UNCERTAIN", "PROVIDER_COORDINATION_UNAVAILABLE"].includes(error.code)) throw error;
      console.error("[provider-coordination] PostgreSQL operation failed:", error.message);
      throw coordinationError("PROVIDER_COORDINATION_UNAVAILABLE", "Provider coordination database is unavailable", error);
    }
  }
  return {
    async claim(kind, key, durationMs) {
      const currentScope = scope();
      return run(async () => {
        const id = randomUUID();
        const params = [...currentScope, kind, key];
        const inserted = await pool.query(`WITH t AS (SELECT clock_timestamp() AS ts)
          INSERT INTO booking_portal_v4.provider_fetch_leases
            (provider_account, provider_environment, cache_kind, cache_key, lease_id, state, started_at, expires_at)
          SELECT $1, $2, $3, $4, $5, 'active', t.ts, t.ts + $6 * interval '1 millisecond' FROM t
          ON CONFLICT (provider_account, provider_environment, cache_kind, cache_key) DO NOTHING RETURNING lease_id`,
        [...params, id, durationMs]);
        if (inserted.rowCount) return { owner: true, id };
        const { rows } = await pool.query(`SELECT lease_id, state, expires_at <= clock_timestamp() AS expired
          FROM booking_portal_v4.provider_fetch_leases
          WHERE provider_account = $1 AND provider_environment = $2 AND cache_kind = $3 AND cache_key = $4`, params);
        return rows.length ? { owner: false, id: rows[0].lease_id, expired: rows[0].expired, state: rows[0].state } : null;
      });
    },
    async assertOwner(id) {
      return run(async () => {
        const { rows } = await pool.query(`SELECT 1 FROM booking_portal_v4.provider_fetch_leases
          WHERE lease_id = $1 AND state = 'active' AND expires_at > clock_timestamp()`, [id]);
        if (!rows.length) throw uncertain(id);
      });
    },
    async markUncertain(id) {
      return run(() => pool.query("UPDATE booking_portal_v4.provider_fetch_leases SET state = 'uncertain' WHERE lease_id = $1", [id]));
    },
    async cancel(id) {
      return run(() => pool.query("DELETE FROM booking_portal_v4.provider_fetch_leases WHERE lease_id = $1 AND state = 'active'", [id]));
    },
    async complete(id, write) {
      return run(async () => {
        const client = await pool.connect();
        let started = false;
        let releaseError;
        try {
          await client.query("BEGIN");
          started = true;
          const held = await client.query(`SELECT 1 FROM booking_portal_v4.provider_fetch_leases
            WHERE lease_id = $1 AND state = 'active' AND expires_at > clock_timestamp() FOR UPDATE`, [id]);
          if (!held.rowCount) throw uncertain(id);
          await write(client);
          const removed = await client.query(`DELETE FROM booking_portal_v4.provider_fetch_leases
            WHERE lease_id = $1 AND state = 'active' AND expires_at > clock_timestamp()`, [id]);
          if (!removed.rowCount) throw uncertain(id);
          await client.query("COMMIT");
          started = false;
        } catch (error) {
          if (started) {
            try { await client.query("ROLLBACK"); }
            catch (rollbackError) { releaseError = rollbackError; console.error("[provider-coordination] rollback failed:", rollbackError.message); }
          }
          throw error;
        } finally { client.release(releaseError); }
      });
    }
  };
}

export const providerFetchLeaseStore = createProviderFetchLeaseStore(
  { connect: () => bookingDatabasePool().connect(), query: (...args) => bookingDatabasePool().query(...args) },
  configuredProviderScope
);

export async function coordinateProviderFetch(kind, key, { read, accept, fetch, write }) {
  const timeout = Number(config.freightPulse.timeoutMs);
  const providerTimeout = Number.isFinite(timeout) && timeout > 0 ? timeout : 10000;
  const leaseMs = Math.max(60000, providerTimeout + 30000);
  const deadline = Date.now() + Math.min(leaseMs, providerTimeout + 10000);
  for (;;) {
    const existing = await read();
    if (accept(existing)) return { cached: true, value: existing };
    const lease = await providerFetchLeaseStore.claim(kind, key, leaseMs);
    if (!lease) {
      if (Date.now() >= deadline) throw coordinationError("PROVIDER_REQUEST_PENDING", "A provider request is in progress. Try again later.");
      continue;
    }
    if (!lease.owner) {
      if (lease.expired || lease.state === "uncertain") throw uncertain(lease.id);
      if (Date.now() >= deadline) throw coordinationError("PROVIDER_REQUEST_PENDING", "A provider request is in progress. Try again later.");
      await sleep(500);
      continue;
    }
    let fetched = false;
    try {
      const latest = await read();
      if (accept(latest)) {
        await providerFetchLeaseStore.cancel(lease.id);
        return { cached: true, value: latest };
      }
      await providerFetchLeaseStore.assertOwner(lease.id);
      const value = await fetch(() => providerFetchLeaseStore.assertOwner(lease.id));
      fetched = true;
      await providerFetchLeaseStore.complete(lease.id, (client) => write(value, client));
      return { cached: false, value };
    } catch (error) {
      if (fetched || error.providerRequestSent || error.code === "PROVIDER_REQUEST_UNCERTAIN") {
        try { await providerFetchLeaseStore.markUncertain(lease.id); }
        catch (markError) { console.error("[provider-coordination] could not mark uncertain request:", markError.message); }
        throw uncertain(lease.id, error);
      }
      await providerFetchLeaseStore.cancel(lease.id);
      throw error;
    }
  }
}
