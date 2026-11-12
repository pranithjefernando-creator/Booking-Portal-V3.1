import pg from "pg";

const required = ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"];

export function createBookingPool(env = process.env) {
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Missing PostgreSQL configuration: ${missing.join(", ")}`);
  const port = env.PGPORT ? Number(env.PGPORT) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PostgreSQL port");
  const pool = new pg.Pool({
    host: env.PGHOST,
    port,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    connectionTimeoutMillis: 15000,
    ssl: { rejectUnauthorized: true }
  });
  pool.on("error", (error) => console.error(`Idle booking PostgreSQL connection failed: ${error.message}`));
  return pool;
}

async function transaction(pool, operation) {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query("BEGIN");
    started = true;
    const result = await operation(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error("Booking transaction rollback failed:", rollbackError.message);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function insertBooking(client, booking) {
  if (!booking?.id) throw new Error("Booking id is required");
  const { rows } = await client.query("SELECT nextval('booking_portal_v3.booking_reference_seq')::text AS value");
  const reference = `BK-0${rows[0].value}`;
  const data = { ...booking, id: booking.id, reference };
  await client.query("INSERT INTO booking_portal_v3.bookings (id, reference, data) VALUES ($1, $2, $3)", [data.id, reference, data]);
  return data;
}

export function createBookingStore(pool) {
  return {
    async listOrderLinks() {
      const { rows } = await pool.query("SELECT l.order_id, l.booking_id, b.reference, b.data->>'cwOrgCode' AS cw_org_code FROM booking_portal_v3.order_links l JOIN booking_portal_v3.bookings b ON b.id = l.booking_id");
      return rows.map((row) => ({ orderId: row.order_id, bookingId: row.booking_id, bookingRef: row.reference, booking: { cwOrgCode: row.cw_org_code } }));
    },

    async linkOrder(orderId, bookingId, checkBooking) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["booking-order-link", orderId]);
        const { rows } = await client.query("SELECT data FROM booking_portal_v3.bookings WHERE id = $1 FOR UPDATE", [bookingId]);
        if (!rows.length) return { status: "not_found" };
        const booking = rows[0].data;
        if (!checkBooking(booking)) return { status: "forbidden" };
        const existing = await client.query("SELECT l.booking_id, b.reference FROM booking_portal_v3.order_links l JOIN booking_portal_v3.bookings b ON b.id = l.booking_id WHERE l.order_id = $1", [orderId]);
        if (existing.rows.length && existing.rows[0].booking_id !== bookingId) return { status: "conflict" };
        if (!existing.rows.length) await client.query("INSERT INTO booking_portal_v3.order_links (order_id, booking_id) VALUES ($1, $2)", [orderId, bookingId]);
        return { status: "linked", bookingRef: booking.reference };
      });
    },

    async unlinkOrder(orderId, checkBooking, expectedBookingId) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["booking-order-link", orderId]);
        const { rows } = await client.query("SELECT l.booking_id, b.data FROM booking_portal_v3.order_links l JOIN booking_portal_v3.bookings b ON b.id = l.booking_id WHERE l.order_id = $1 FOR UPDATE OF b", [orderId]);
        if (!rows.length) return { status: "unlinked" };
        if (!checkBooking(rows[0].data)) return { status: "forbidden" };
        if (expectedBookingId && rows[0].booking_id !== expectedBookingId) return { status: "conflict" };
        await client.query("DELETE FROM booking_portal_v3.order_links WHERE order_id = $1", [orderId]);
        return { status: "unlinked" };
      });
    },

    async createImport(batch) {
      if (!batch?.id || !Array.isArray(batch.rows)) throw new Error("Import batch id and rows are required");
      await pool.query("INSERT INTO booking_portal_v3.imports (id, data) VALUES ($1, $2)", [batch.id, batch]);
      return batch;
    },

    async getImport(id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.imports WHERE id = $1", [id]);
      return rows.length ? rows[0].data : null;
    },

    async updateImport(id, change) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query("SELECT data FROM booking_portal_v3.imports WHERE id = $1 FOR UPDATE", [id]);
        if (!rows.length) return null;
        const batch = await change(rows[0].data);
        if (!batch || batch.id !== id || !Array.isArray(batch.rows)) throw new Error("Invalid updated import batch");
        await client.query("UPDATE booking_portal_v3.imports SET data = $2 WHERE id = $1", [id, batch]);
        return batch;
      });
    },

    async commitImport(id, makeBooking, checkBatch = () => {}) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query("SELECT data FROM booking_portal_v3.imports WHERE id = $1 FOR UPDATE", [id]);
        if (!rows.length) return null;
        const batch = rows[0].data;
        await checkBatch(batch);
        const bookings = [];
        for (const row of batch.rows) {
          if (row.status !== "VALID") continue;
          const booking = await insertBooking(client, await makeBooking(row));
          bookings.push(booking);
          row.status = "COMMITTED";
          row.committedBookingId = booking.id;
        }
        batch.valid = batch.rows.filter((row) => row.status === "VALID").length;
        await client.query("UPDATE booking_portal_v3.imports SET data = $2 WHERE id = $1", [id, batch]);
        return { batch, bookings };
      });
    },

    async getPreferences(owner, type) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.preferences WHERE owner_email = $1 AND preference_type = $2", [owner, type]);
      return rows.length ? rows[0].data : [];
    },

    async updatePreferences(owner, type, change) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [owner, `preference:${type}`]);
        const { rows } = await client.query("SELECT data FROM booking_portal_v3.preferences WHERE owner_email = $1 AND preference_type = $2 FOR UPDATE", [owner, type]);
        const updated = change(rows.length ? rows[0].data : []);
        if (!Array.isArray(updated)) throw new Error("Booking preferences must be an array");
        await client.query("INSERT INTO booking_portal_v3.preferences (owner_email, preference_type, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (owner_email, preference_type) DO UPDATE SET data = EXCLUDED.data", [owner, type, JSON.stringify(updated)]);
        return updated;
      });
    },

    async listTemplates(owner) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.templates WHERE owner_email = $1 ORDER BY data->>'createdAt', id", [owner]);
      return rows.map((row) => row.data);
    },

    async getTemplate(owner, id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.templates WHERE owner_email = $1 AND id = $2", [owner, id]);
      return rows.length ? rows[0].data : null;
    },

    async saveTemplate(owner, template) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext(lower($2)))", [owner, template.name]);
        const { rows } = await client.query("SELECT id, data FROM booking_portal_v3.templates WHERE owner_email = $1 AND lower(data->>'name') = lower($2) ORDER BY id LIMIT 1 FOR UPDATE", [owner, template.name]);
        const existing = rows[0];
        const record = { ...template, id: existing?.id || template.id, createdAt: existing?.data.createdAt || template.createdAt };
        if (existing) await client.query("UPDATE booking_portal_v3.templates SET data = $2 WHERE id = $1", [record.id, record]);
        else await client.query("INSERT INTO booking_portal_v3.templates (id, owner_email, data) VALUES ($1, $2, $3)", [record.id, owner, record]);
        return { record, created: !existing };
      });
    },

    async deleteTemplate(owner, id) {
      await pool.query("DELETE FROM booking_portal_v3.templates WHERE owner_email = $1 AND id = $2", [owner, id]);
    },

    async list() {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.bookings");
      return rows.map((row) => row.data);
    },

    async listNotificationSnapshot() {
      const { rows } = await pool.query("SELECT b.data - 'documents' AS booking, COALESCE((SELECT jsonb_agg(a.data) FROM booking_portal_v3.approvals a WHERE a.booking_id = b.id), '[]'::jsonb) AS approvals FROM booking_portal_v3.bookings b");
      return rows;
    },

    async get(id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.bookings WHERE id = $1", [id]);
      return rows.length ? rows[0].data : null;
    },

    async listApprovals() {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.approvals");
      return rows.map((row) => row.data);
    },

    async getApproval(id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v3.approvals WHERE id = $1", [id]);
      return rows.length ? rows[0].data : null;
    },

    async updateWithApproval(bookingId, change) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query("SELECT reference, data FROM booking_portal_v3.bookings WHERE id = $1 FOR UPDATE", [bookingId]);
        if (!rows.length) return null;
        const approvalRows = await client.query("SELECT data FROM booking_portal_v3.approvals WHERE booking_id = $1", [bookingId]);
        const existing = new Map(approvalRows.rows.map((row) => [row.data.id, row.data]));
        const result = await change(rows[0].data, [...existing.values()]);
        if (!result?.booking || typeof result.booking !== "object" || Array.isArray(result.booking)) throw new Error("Approval transition must return a booking");
        const booking = { ...result.booking, id: bookingId, reference: rows[0].reference };
        await client.query("UPDATE booking_portal_v3.bookings SET data = $2 WHERE id = $1", [bookingId, booking]);
        if (result.approval) {
          const approval = result.approval;
          if (!approval.id || approval.bookingId !== bookingId) throw new Error("Approval must identify its booking");
          if (existing.has(approval.id)) {
            await client.query("UPDATE booking_portal_v3.approvals SET data = $2 WHERE id = $1 AND booking_id = $3", [approval.id, approval, bookingId]);
          } else {
            await client.query("INSERT INTO booking_portal_v3.approvals (id, booking_id, data) VALUES ($1, $2, $3)", [approval.id, bookingId, approval]);
          }
        }
        return { ...result, booking };
      });
    },

    async create(booking) {
      return transaction(pool, (client) => insertBooking(client, booking));
    },

    async update(id, change) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query("SELECT reference, data FROM booking_portal_v3.bookings WHERE id = $1 FOR UPDATE", [id]);
        if (!rows.length) return null;
        const updated = await change(rows[0].data);
        if (!updated || typeof updated !== "object" || Array.isArray(updated)) throw new Error("Booking update must return an object");
        const data = { ...updated, id, reference: rows[0].reference };
        await client.query("UPDATE booking_portal_v3.bookings SET data = $2 WHERE id = $1", [id, data]);
        return data;
      });
    }
  };
}
