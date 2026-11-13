import { randomUUID } from "node:crypto";
import { createAuditStore } from "./auditStore.js";

export function operationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function transaction(client, callback) {
  await client.query("BEGIN");
  try {
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { console.error(`Operation rollback failed: ${rollbackError.message}`); }
    throw error;
  }
}

async function mark(client, id, status) {
  const result = await client.query(
    "UPDATE booking_portal_v4.external_operations SET status = $2, resolved_at = now() WHERE id = $1 AND status = 'PENDING'",
    [id, status]
  );
  if (result.rowCount !== 1) throw new Error("Pending operation not found");
}

export async function finishOperation(client, id) {
  await mark(client, id, "COMPLETED");
}

async function acquire(client, key) {
  const { rows } = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired", [key]);
  if (!rows[0].acquired) throw operationError("OPERATION_PENDING", "This operation is already in progress. Do not retry until it finishes.");
}

async function release(client, key) {
  const { rows } = await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released", [key]);
  if (!rows[0].released) throw new Error("Operation lock was not held");
}

async function locked(pool, key, callback) {
  const client = await pool.connect();
  let acquired = false;
  let releaseError;
  try {
    await acquire(client, key);
    acquired = true;
    return await callback(client);
  } finally {
    if (acquired) {
      try { await release(client, key); }
      catch (error) { releaseError = error; console.error(`Operation lock release failed: ${error.message}`); }
    }
    client.release(releaseError);
  }
}

export async function runExternalOperation(pool, { key, kind, entityId, entityRef, user, details = {} }, callback) {
  return locked(pool, key, async (client) => {
    const id = randomUUID();
    try {
      await transaction(client, async () => {
        await client.query(
          `INSERT INTO booking_portal_v4.external_operations
             (id, operation_key, kind, entity_id, entity_ref, actor_id, actor_name, actor_role, details)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
          [id, key, kind, entityId, entityRef, user?.id || null, user?.name || "system", user?.role || "—", JSON.stringify(details)]
        );
        await createAuditStore(client).append({ user, action: "OPERATION_STARTED", entityType: kind.startsWith("CW_") ? "Booking" : "Order", entityId: entityRef, after: { operationId: id, kind } });
      });
    } catch (error) {
      if (error.code === "23505" && error.constraint === "external_operations_pending_key_idx") {
        throw operationError("OPERATION_PENDING", "A previous operation needs administrator review. Do not retry.");
      }
      throw error;
    }
    try {
      return await callback({
        id, client,
        complete: (audit) => transaction(client, async () => {
          if (audit) await createAuditStore(client).append(audit);
          await finishOperation(client, id);
        }),
        abort: () => transaction(client, () => mark(client, id, "ABORTED"))
      });
    } catch (error) {
      console.error(`Operation ${id} requires reconciliation: ${error.message}`);
      throw operationError("OPERATION_UNCERTAIN", "The operation outcome is uncertain. Do not retry; contact an administrator for reconciliation.");
    }
  });
}

export async function listPendingOperations(pool) {
  const { rows } = await pool.query(`SELECT id, kind, entity_id, entity_ref, actor_name, actor_role, details, started_at
    FROM booking_portal_v4.external_operations WHERE status = 'PENDING' ORDER BY started_at DESC, id DESC`);
  return rows.map((row) => ({
    id: row.id, kind: row.kind, entityId: row.entity_id, entityRef: row.entity_ref,
    actorName: row.actor_name, actorRole: row.actor_role, details: row.details, startedAt: row.started_at.toISOString()
  }));
}

export async function reconcileOperation(pool, id, user, resolution, reconcileBooking) {
  if (!resolution || !["APPLIED", "NOT_APPLIED"].includes(resolution.outcome)) throw operationError("OPERATION_INVALID", "Select whether the operation was applied.");
  if (typeof resolution.notes !== "string" || !resolution.notes.trim() || resolution.notes.length > 2000) throw operationError("OPERATION_INVALID", "Reconciliation notes are required and must be at most 2000 characters.");
  const initial = await pool.query("SELECT operation_key FROM booking_portal_v4.external_operations WHERE id = $1 AND status = 'PENDING'", [id]);
  if (!initial.rows.length) throw operationError("OPERATION_INVALID", "Pending operation not found.");
  return locked(pool, initial.rows[0].operation_key, (client) => transaction(client, async () => {
    const { rows } = await client.query("SELECT * FROM booking_portal_v4.external_operations WHERE id = $1 AND status = 'PENDING' FOR UPDATE", [id]);
    if (!rows.length) throw operationError("OPERATION_INVALID", "Pending operation not found.");
    const operation = rows[0];
    if (operation.kind.startsWith("CW_")) {
      if (resolution.outcome === "APPLIED" && (typeof resolution.cwReference !== "string" || !resolution.cwReference.trim() || resolution.cwReference.length > 160)) throw operationError("OPERATION_INVALID", "A CargoWise reference of at most 160 characters is required.");
      await reconcileBooking(client, operation, resolution, user);
    }
    const record = { outcome: resolution.outcome, notes: resolution.notes.trim(), ...(operation.kind.startsWith("CW_") && resolution.outcome === "APPLIED" ? { cwReference: resolution.cwReference.trim() } : {}), actorId: user.id, actorName: user.name };
    await client.query("UPDATE booking_portal_v4.external_operations SET status = 'RECONCILED', resolved_at = now(), resolution = $2::jsonb WHERE id = $1", [id, JSON.stringify(record)]);
    await createAuditStore(client).append({ user, action: "OPERATION_RECONCILED", entityType: operation.kind.startsWith("CW_") ? "Booking" : "Order", entityId: operation.entity_ref, after: { operationId: id, kind: operation.kind, ...record } });
    return { ok: true };
  }));
}
