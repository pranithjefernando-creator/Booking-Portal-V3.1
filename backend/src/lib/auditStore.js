import { randomUUID } from "node:crypto";

function mapEvent(row) {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorName: row.actor_name,
    actorRole: row.actor_role,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    before: row.before_data,
    after: row.after_data
  };
}

function jsonValue(value) {
  if (value == null) return null;
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("Audit details must be JSON serializable");
  return json;
}

export function createAuditStore(database) {
  return {
    async append({ user, action, entityType, entityId, before, after }) {
      for (const [name, value] of Object.entries({ action, entityType, entityId })) {
        if (typeof value !== "string" || !value.trim()) throw new Error(`Audit ${name} is required`);
      }
      const { rows } = await database.query(
        `INSERT INTO booking_portal_v4.audit_events
          (id, actor_id, actor_name, actor_role, action, entity_type, entity_id, before_data, after_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         RETURNING *`,
        [randomUUID(), user?.id || null, user?.name || "system", user?.role || "—", action, entityType, entityId, jsonValue(before), jsonValue(after)]
      );
      return mapEvent(rows[0]);
    },

    async list() {
      const { rows } = await database.query(
        `SELECT id, occurred_at, actor_name, actor_role, action, entity_type, entity_id,
                before_data, after_data, count(*) OVER () AS total
         FROM booking_portal_v4.audit_events
         ORDER BY occurred_at DESC, id DESC
         LIMIT 200`
      );
      const total = rows.length ? Number(rows[0].total) : 0;
      if (!Number.isSafeInteger(total)) throw new Error("Audit event count exceeds the supported range");
      return { total, items: rows.map(mapEvent) };
    }
  };
}
