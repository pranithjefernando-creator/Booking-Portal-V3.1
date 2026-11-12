const bookingFields = [
  ["status"], ["mode"], ["incotermCode"], ["freightTerms"], ["originCode"], ["destCode"],
  ["cargoReadyDate", "date"], ["commodityCode"], ["goodsDescription"], ["marksAndNumbers"],
  ["shipperReferenceNo"], ["notes"], ["branchCode"], ["cwOrgCode"], ["shipperCode"],
  ["consigneeCode"], ["cfsReceived", "boolean"], ["cfsReceivedAt", "date"], ["isDg", "boolean"],
  ["pickupRequired", "boolean"], ["clientRequestedEta", "date"], ["handlingRemarks"],
  ["documentsAccompanying"], ["cw1ShipmentRef"], ["cwStatus"], ["cwHttpStatus", "integer"],
  ["cwResponse"], ["cwSentAt", "timestamp"], ["cwConverted", "boolean"], ["cwLastAction"],
  ["createdByUserId"], ["createdByEmail"], ["createdBy"], ["updatedBy"],
  ["createdAt", "timestamp"], ["updatedAt", "timestamp"], ["completedAt", "timestamp"]
];
const groupFields = {
  dg: [["unNumber"], ["properShippingName"], ["dgClass", "text", "dg_class"], ["packingGroup"], ["specialHandling"]],
  pickup: [["phone"], ["contact"], ["address"], ["estimatedPickup", "date"], ["requiredDate", "date"], ["estimatedDelivery", "date"], ["deliveryRequiredBy", "date"]],
  dates: [["requiredPickup", "date"], ["requiredEtd", "date"], ["requiredEta", "date"], ["requestedDelivery", "date"]]
};
const partyFields = [["code"], ["companyName"], ["name"], ["address1"], ["address2"], ["city"], ["state"], ["postCode"], ["country"], ["phone"], ["email"]];
const cargoFields = [["id"], ["packages", "numeric"], ["packageTypeCode"], ["grossWeight", "numeric"], ["weightUnit"], ["volume", "numeric"], ["volumeUnit"], ["hsCode"], ["poNumbers"], ["orderId"], ["commodityCode"], ["unNumber"], ["dgClass"]];
const containerFields = [["id"], ["containerTypeCode"], ["count", "numeric"]];
const documentFields = [["id"], ["type"], ["typeName"], ["fileName"], ["size", "integer"], ["mimeType"], ["contentBase64", "bytes", "content"], ["uploadedBy"]];
const relations = { shipper: ["booking_parties", partyFields], consignee: ["booking_parties", partyFields], cargoLines: ["booking_cargo_lines", cargoFields], containers: ["booking_containers", containerFields], documents: ["booking_documents", documentFields] };
const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const column = ([key, , name], prefix = "") => name || `${prefix}${snake(key)}`;

function pack(object, fields, excluded = []) {
  if (!isObject(object)) throw new Error("Booking data must contain objects where expected");
  const keys = [], originals = {}, values = {};
  const mapped = new Set([...fields.map(([key]) => key), ...excluded]);
  const extra = Object.fromEntries(Object.entries(object).filter(([key, value]) => !mapped.has(key) && value !== undefined));
  for (const [key, type = "text"] of fields) {
    if (!has(object, key)) continue;
    keys.push(key);
    const value = object[key];
    if (value === null) { values[key] = null; continue; }
    if (type === "date" || type === "timestamp") {
      if (typeof value !== "string") throw new Error(`${key} must be a date string`);
      originals[key] = value;
      values[key] = value === "" ? null : value;
    } else if (type === "numeric" || type === "integer") {
      if (value === "") { originals[key] = value; values[key] = null; continue; }
      if ((typeof value !== "number" && typeof value !== "string") || !Number.isFinite(Number(value)) || (type === "integer" && !Number.isInteger(Number(value)))) throw new Error(`${key} must be numeric`);
      if (typeof value === "string") originals[key] = value;
      values[key] = value;
    } else if (type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
      values[key] = value;
    } else if (type === "bytes") {
      if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error(`${key} must be canonical base64`);
      values[key] = Buffer.from(value, "base64");
      if (values[key].toString("base64") !== value) throw new Error(`${key} must be canonical base64`);
    } else {
      if (typeof value !== "string") throw new Error(`${key} must be a string`);
      values[key] = value;
    }
  }
  return { values, meta: { extra, keys, originals } };
}

function unpack(row, fields, meta, prefix = "") {
  if (!isObject(meta) || !isObject(meta.extra) || !Array.isArray(meta.keys) || !isObject(meta.originals)) throw new Error("Invalid relational booking metadata");
  const result = { ...meta.extra };
  for (const field of fields) {
    const [key, type = "text"] = field;
    if (!meta.keys.includes(key)) continue;
    let value = row[column(field, prefix)];
    const original = meta.originals[key];
    if (has(meta.originals, key) && (
      (original === "" && value === null) ||
      (value !== null && type === "timestamp" && new Date(original).getTime() === value.getTime()) ||
      (value !== null && type !== "timestamp" && String(value) === original)
    )) value = original;
    else if (value !== null && (type === "numeric" || type === "integer")) {
      value = has(meta.originals, key) ? String(value) : Number(value);
      if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${key} is outside the supported numeric range`);
    }
    else if (value !== null && type === "bytes") value = value.toString("base64");
    else if (value !== null && type === "timestamp") value = value.toISOString();
    result[key] = value;
  }
  return result;
}

function projections(fields, prefix = "") {
  return fields.map((field) => {
    const name = column(field, prefix);
    return field[1] === "date" ? `${name}::text AS ${name}` : name;
  });
}

async function transaction(pool, operation, readOnly = false) {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    started = true;
    const result = await operation(client);
    await client.query("COMMIT");
    started = false;
    return result;
  } catch (error) {
    if (started) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { console.error("Relational booking transaction rollback failed:", rollbackError.message); }
    }
    throw error;
  } finally { client.release(); }
}

async function writeBooking(client, booking, insert) {
  if (typeof booking.id !== "string" || !booking.id.trim() || typeof booking.reference !== "string" || !booking.reference.trim()) throw new Error("Booking id and explicit reference are required");
  const root = pack(booking, bookingFields, ["id", "reference", ...Object.keys(groupFields), ...Object.keys(relations)]);
  const columns = ["id", "reference", ...bookingFields.map((field) => column(field))];
  const values = [booking.id, booking.reference, ...bookingFields.map(([key]) => root.values[key] ?? null)];
  if (!has(booking, "status")) values[columns.indexOf("status")] = "DRAFT";
  root.meta.groups = {};
  root.meta.relations = {};
  for (const [name, fields] of Object.entries(groupFields)) {
    if (!has(booking, name)) continue;
    if (booking[name] === null) { root.meta.groups[name] = null; continue; }
    const group = pack(booking[name], fields);
    root.meta.groups[name] = group.meta;
    const prefix = name === "dates" ? "" : `${name}_`;
    for (const field of fields) { columns.push(column(field, prefix)); values.push(group.values[field[0]] ?? null); }
  }
  for (const name of Object.keys(relations)) {
    if (!has(booking, name)) continue;
    const value = booking[name];
    if (value === null) { root.meta.relations[name] = null; continue; }
    const party = name === "shipper" || name === "consignee";
    if (party ? !isObject(value) : !Array.isArray(value)) throw new Error(`${name} must be ${party ? "an object" : "an array"}`);
    root.meta.relations[name] = true;
  }
  columns.push("additional_data");
  values.push(root.meta);
  if (insert) {
    await client.query(`INSERT INTO booking_portal_v4.bookings (${columns.join(", ")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`, values);
  } else {
    // Include absent groups so replacing a nested object cannot retain stale columns.
    for (const [name, fields] of Object.entries(groupFields)) {
      if (root.meta.groups[name] && isObject(root.meta.groups[name])) continue;
      const prefix = name === "dates" ? "" : `${name}_`;
      for (const field of fields) { columns.push(column(field, prefix)); values.push(null); }
    }
    await client.query(`UPDATE booking_portal_v4.bookings SET ${columns.slice(2).map((name, i) => `${name} = $${i + 3}`).join(", ")} WHERE id = $1 AND reference = $2`, values);
    for (const table of ["booking_parties", "booking_cargo_lines", "booking_containers", "booking_documents"]) await client.query(`DELETE FROM booking_portal_v4.${table} WHERE booking_id = $1`, [booking.id]);
  }
  for (const [name, [table, fields]] of Object.entries(relations)) {
    if (root.meta.relations[name] !== true) continue;
    const party = name === "shipper" || name === "consignee";
    const items = party ? [booking[name]] : booking[name];
    for (const [position, item] of items.entries()) {
      const record = pack(item, fields);
      const childColumns = ["booking_id", party ? "party_type" : "position", ...fields.map((field) => column(field)), "additional_data"];
      const childValues = [booking.id, party ? name : position, ...fields.map(([key]) => record.values[key] ?? null), record.meta];
      await client.query(`INSERT INTO booking_portal_v4.${table} (${childColumns.join(", ")}) VALUES (${childValues.map((_, i) => `$${i + 1}`).join(", ")})`, childValues);
    }
  }
}

async function readBookings(client, id, lock = false, includeDocuments = true) {
  const fields = [...projections(bookingFields), ...Object.entries(groupFields).flatMap(([name, list]) => projections(list, name === "dates" ? "" : `${name}_`))];
  const { rows } = await client.query(`SELECT id, reference, additional_data, ${fields.join(", ")} FROM booking_portal_v4.bookings${id === undefined ? "" : " WHERE id = $1"}${lock ? " FOR UPDATE" : ""}`, id === undefined ? [] : [id]);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const children = {};
  for (const [table, fields] of [["booking_parties", partyFields], ["booking_cargo_lines", cargoFields], ["booking_containers", containerFields], ["booking_documents", documentFields]]) {
    if (!includeDocuments && table === "booking_documents") continue;
    const order = table === "booking_parties" ? "party_type" : "position";
    children[table] = (await client.query(`SELECT booking_id, ${order}, additional_data, ${projections(fields).join(", ")} FROM booking_portal_v4.${table} WHERE booking_id = ANY($1::text[]) ORDER BY booking_id, ${order}`, [ids])).rows;
  }
  return rows.map((row) => {
    const meta = row.additional_data;
    const booking = { ...unpack(row, bookingFields, meta), id: row.id, reference: row.reference };
    if (!isObject(meta.groups) || !isObject(meta.relations)) throw new Error("Invalid relational booking metadata");
    for (const [name, fields] of Object.entries(groupFields)) {
      if (has(meta.groups, name)) booking[name] = meta.groups[name] === null ? null : unpack(row, fields, meta.groups[name], name === "dates" ? "" : `${name}_`);
    }
    for (const [name, [table, fields]] of Object.entries(relations)) {
      if (!includeDocuments && name === "documents") continue;
      if (!has(meta.relations, name)) continue;
      if (meta.relations[name] === null) { booking[name] = null; continue; }
      if (meta.relations[name] !== true) throw new Error("Invalid relational booking relation metadata");
      const party = name === "shipper" || name === "consignee";
      const matching = children[table].filter((child) => child.booking_id === row.id && (!party || child.party_type === name));
      if (party && matching.length !== 1) throw new Error(`Missing ${name} record for booking ${row.id}`);
      booking[name] = party ? unpack(matching[0], fields, matching[0].additional_data) : matching.map((child) => unpack(child, fields, child.additional_data));
    }
    return booking;
  });
}

export function createRelationalBookingStore(pool, { allocateReference } = {}) {
  if (allocateReference !== undefined && typeof allocateReference !== "function") throw new Error("Reference allocator must be a function");
  return {
    async create(booking) {
      return transaction(pool, async (client) => {
        if (!isObject(booking)) throw new Error("Booking must be an object");
        const data = allocateReference ? { ...booking, reference: await allocateReference(client, booking) } : booking;
        await writeBooking(client, data, true);
        return (await readBookings(client, data.id))[0];
      });
    },
    async get(id) { return transaction(pool, async (client) => (await readBookings(client, id))[0] || null, true); },
    async list() { return transaction(pool, (client) => readBookings(client), true); },
    async listNotificationSnapshot() {
      return transaction(pool, async (client) => {
        const bookings = await readBookings(client, undefined, false, false);
        const { rows } = await client.query("SELECT booking_id, data FROM booking_portal_v4.approvals");
        const approvalsByBooking = new Map();
        for (const row of rows) {
          if (!approvalsByBooking.has(row.booking_id)) approvalsByBooking.set(row.booking_id, []);
          approvalsByBooking.get(row.booking_id).push(row.data);
        }
        return bookings.map((booking) => ({ booking, approvals: approvalsByBooking.get(booking.id) || [] }));
      }, true);
    },
    async update(id, change) {
      return transaction(pool, async (client) => {
        const [current] = await readBookings(client, id, true);
        if (!current) return null;
        const reference = current.reference;
        const updated = await change(current);
        if (!isObject(updated)) throw new Error("Booking update must return an object");
        const booking = { ...updated, id, reference };
        await writeBooking(client, booking, false);
        return (await readBookings(client, id))[0];
      });
    },

    async getPreferences(owner, type) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v4.preferences WHERE owner_email = $1 AND preference_type = $2", [owner, type]);
      return rows.length ? rows[0].data : [];
    },
    async updatePreferences(owner, type, change) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [owner, `preference:${type}`]);
        const { rows } = await client.query("SELECT data FROM booking_portal_v4.preferences WHERE owner_email = $1 AND preference_type = $2 FOR UPDATE", [owner, type]);
        const updated = await change(rows.length ? rows[0].data : []);
        if (!Array.isArray(updated)) throw new Error("Booking preferences must be an array");
        await client.query("INSERT INTO booking_portal_v4.preferences (owner_email, preference_type, data) VALUES ($1, $2, $3::jsonb) ON CONFLICT (owner_email, preference_type) DO UPDATE SET data = EXCLUDED.data", [owner, type, JSON.stringify(updated)]);
        return updated;
      });
    },
    async listTemplates(owner) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v4.templates WHERE owner_email = $1 ORDER BY data->>'createdAt', id", [owner]);
      return rows.map((row) => row.data);
    },
    async getTemplate(owner, id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v4.templates WHERE owner_email = $1 AND id = $2", [owner, id]);
      return rows.length ? rows[0].data : null;
    },
    async saveTemplate(owner, template) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext(lower($2)))", [owner, template.name]);
        const { rows } = await client.query("SELECT id, data FROM booking_portal_v4.templates WHERE owner_email = $1 AND lower(data->>'name') = lower($2) ORDER BY id LIMIT 1 FOR UPDATE", [owner, template.name]);
        const existing = rows[0];
        const record = { ...template, id: existing?.id || template.id, createdAt: existing?.data.createdAt || template.createdAt };
        if (existing) await client.query("UPDATE booking_portal_v4.templates SET data = $2 WHERE id = $1", [record.id, record]);
        else await client.query("INSERT INTO booking_portal_v4.templates (id, owner_email, data) VALUES ($1, $2, $3)", [record.id, owner, record]);
        return { record, created: !existing };
      });
    },
    async deleteTemplate(owner, id) {
      await pool.query("DELETE FROM booking_portal_v4.templates WHERE owner_email = $1 AND id = $2", [owner, id]);
    },

    async listApprovals() {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v4.approvals");
      return rows.map((row) => row.data);
    },
    async getApproval(id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v4.approvals WHERE id = $1", [id]);
      return rows.length ? rows[0].data : null;
    },
    async updateWithApproval(bookingId, change) {
      return transaction(pool, async (client) => {
        const [current] = await readBookings(client, bookingId, true);
        if (!current) return null;
        const reference = current.reference;
        const { rows } = await client.query("SELECT data FROM booking_portal_v4.approvals WHERE booking_id = $1", [bookingId]);
        const existing = new Map(rows.map((row) => [row.data.id, row.data]));
        const result = await change(current, [...existing.values()]);
        if (!isObject(result?.booking)) throw new Error("Approval transition must return a booking");
        const booking = { ...result.booking, id: bookingId, reference };
        await writeBooking(client, booking, false);
        if (result.approval) {
          const approval = result.approval;
          if (!approval.id || approval.bookingId !== bookingId) throw new Error("Approval must identify its booking");
          if (existing.has(approval.id)) {
            await client.query("UPDATE booking_portal_v4.approvals SET data = $2 WHERE id = $1 AND booking_id = $3", [approval.id, approval, bookingId]);
          } else {
            await client.query("INSERT INTO booking_portal_v4.approvals (id, booking_id, data) VALUES ($1, $2, $3)", [approval.id, bookingId, approval]);
          }
        }
        return { ...result, booking: (await readBookings(client, bookingId))[0] };
      });
    },

    async createImport(batch) {
      if (!batch?.id || !Array.isArray(batch.rows)) throw new Error("Import batch id and rows are required");
      await pool.query("INSERT INTO booking_portal_v4.imports (id, data) VALUES ($1, $2)", [batch.id, batch]);
      return batch;
    },
    async getImport(id) {
      const { rows } = await pool.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1", [id]);
      return rows.length ? rows[0].data : null;
    },
    async updateImport(id, change) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1 FOR UPDATE", [id]);
        if (!rows.length) return null;
        const batch = await change(rows[0].data);
        if (!batch || batch.id !== id || !Array.isArray(batch.rows)) throw new Error("Invalid updated import batch");
        await client.query("UPDATE booking_portal_v4.imports SET data = $2 WHERE id = $1", [id, batch]);
        return batch;
      });
    },
    async commitImport(id, makeBooking, checkBatch = () => {}) {
      return transaction(pool, async (client) => {
        const { rows } = await client.query("SELECT data FROM booking_portal_v4.imports WHERE id = $1 FOR UPDATE", [id]);
        if (!rows.length) return null;
        const batch = rows[0].data;
        await checkBatch(batch);
        const bookings = [];
        for (const row of batch.rows) {
          if (row.status !== "VALID") continue;
          if (!allocateReference) throw new Error("Relational booking reference allocator is not configured");
          const draft = await makeBooking(row);
          if (!isObject(draft)) throw new Error("Import must produce a booking object");
          const reference = await allocateReference(client, draft);
          const booking = { ...draft, reference };
          await writeBooking(client, booking, true);
          bookings.push((await readBookings(client, booking.id))[0]);
          row.status = "COMMITTED";
          row.committedBookingId = booking.id;
        }
        batch.valid = batch.rows.filter((row) => row.status === "VALID").length;
        await client.query("UPDATE booking_portal_v4.imports SET data = $2 WHERE id = $1", [id, batch]);
        return { batch, bookings };
      });
    },

    async listOrderLinks() {
      const { rows } = await pool.query("SELECT l.order_id, l.booking_id, b.reference, b.cw_org_code FROM booking_portal_v4.order_links l JOIN booking_portal_v4.bookings b ON b.id = l.booking_id");
      return rows.map((row) => ({ orderId: row.order_id, bookingId: row.booking_id, bookingRef: row.reference, booking: { cwOrgCode: row.cw_org_code } }));
    },
    async linkOrder(orderId, bookingId, checkBooking) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["booking-order-link", orderId]);
        const [booking] = await readBookings(client, bookingId, true);
        if (!booking) return { status: "not_found" };
        if (!checkBooking(booking)) return { status: "forbidden" };
        const { rows } = await client.query("SELECT booking_id FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]);
        if (rows.length && rows[0].booking_id !== bookingId) return { status: "conflict" };
        if (!rows.length) await client.query("INSERT INTO booking_portal_v4.order_links (order_id, booking_id) VALUES ($1, $2)", [orderId, bookingId]);
        return { status: "linked", bookingRef: booking.reference };
      });
    },
    async unlinkOrder(orderId, checkBooking, expectedBookingId) {
      return transaction(pool, async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", ["booking-order-link", orderId]);
        const { rows } = await client.query("SELECT booking_id FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]);
        if (!rows.length) return { status: "unlinked" };
        const bookingId = rows[0].booking_id;
        const [booking] = await readBookings(client, bookingId, true);
        if (!booking) throw new Error("Linked booking not found");
        if (!checkBooking(booking)) return { status: "forbidden" };
        if (expectedBookingId && expectedBookingId !== bookingId) return { status: "conflict" };
        await client.query("DELETE FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]);
        return { status: "unlinked" };
      });
    }
  };
}
