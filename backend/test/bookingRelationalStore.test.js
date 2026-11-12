import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../src/lib/bookingRelationalStore.js";
import { FIELD_CATALOG } from "../src/fieldVisibilityCatalog.js";

const execFileAsync = promisify(execFile);

test("booking form fields are stored in their relational columns", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const id = randomUUID();
  const pool = createBookingPool();
  const store = createRelationalBookingStore(pool);
  const booking = { id, reference: `TEST-${id}`, status: "DRAFT", shipper: {}, consignee: {}, dg: {}, pickup: {}, dates: {}, cargoLines: [{ id: "line" }], containers: [{ id: "container" }], documents: [] };
  const snake = (name) => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  const numeric = new Set(["cargoLines.packages", "cargoLines.grossWeight", "cargoLines.volume", "containers.count"]);
  const booleans = new Set(["isDg", "pickupRequired"]);
  const dateFields = new Set(["cargoReadyDate", "clientRequestedEta", "pickup.estimatedPickup", "pickup.requiredDate", "pickup.estimatedDelivery", "pickup.deliveryRequiredBy", "dates.requiredPickup", "dates.requiredEtd", "dates.requiredEta", "dates.requestedDelivery"]);
  try {
    for (const { key } of FIELD_CATALOG.booking) {
      if (key === "documents") continue;
      const value = numeric.has(key) ? 2 : booleans.has(key) ? true : dateFields.has(key) ? "2028-04-05" : `value-${key}`;
      const [group, field] = key.split(".");
      if (!field) booking[group] = value;
      else if (group === "cargoLines" || group === "containers") booking[group][0][field] = value;
      else booking[group][field] = value;
    }
    assert.deepEqual(await store.create(booking), booking);
    const records = {};
    for (const [name, table, extra] of [
      ["bookings", "bookings", ""], ["shipper", "booking_parties", " AND party_type = 'shipper'"],
      ["consignee", "booking_parties", " AND party_type = 'consignee'"], ["cargoLines", "booking_cargo_lines", ""],
      ["containers", "booking_containers", ""]
    ]) {
      const key = name === "bookings" ? "id" : "booking_id";
      records[name] = (await pool.query(`SELECT to_jsonb(t) AS data FROM booking_portal_v4.${table} t WHERE ${key} = $1${extra}`, [id])).rows[0].data;
    }
    for (const { key } of FIELD_CATALOG.booking) {
      if (key === "documents") continue;
      const [group, field] = key.split(".");
      let table = "bookings";
      let name = snake(group);
      if (field) {
        if (["shipper", "consignee", "cargoLines", "containers"].includes(group)) { table = group; name = snake(field); }
        else if (group === "dates") name = snake(field);
        else if (key === "dg.dgClass") name = "dg_class";
        else name = `${snake(group)}_${snake(field)}`;
      }
      const expected = field ? (group === "cargoLines" || group === "containers" ? booking[group][0][field] : booking[group][field]) : booking[group];
      assert.equal(records[table][name], expected, `${key} should use ${table}.${name}`);
    }
  } finally {
    await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = $1", [id]);
    await pool.end();
  }
});

test("staged relational booking records round-trip, serialize edits and survive a process restart", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const id = randomUUID();
  const draftId = randomUUID();
  const pool = createBookingPool();
  const store = createRelationalBookingStore(pool);
  const reference = `TEST-${id}`;
  const booking = {
    id, reference, status: "DRAFT", mode: "", cwOrgCode: "TEST",
    cargoReadyDate: "", clientRequestedEta: "2027-01-03", cfsReceived: false,
    createdAt: "2027-01-01T10:00:00+05:30", cwSentAt: "", cwHttpStatus: 0,
    shipper: { code: "SHIP", companyName: "Sender", phone: "", extraParty: "kept" },
    consignee: {},
    dg: { unNumber: "1234", dgClass: "3", extraDg: true },
    pickup: { requiredDate: "", phone: "123" },
    dates: { requiredPickup: "2027-01-04", requiredEta: null },
    cargoLines: [
      { id: "line-1", packages: "3.00", grossWeight: 10.5, volume: "", hsCode: "001", extraLine: { x: 1 } },
      { id: "line-2", packages: 0, grossWeight: null }
    ],
    containers: [{ id: "container-1", count: "1", containerTypeCode: "40HC" }],
    documents: [{ id: "doc-1", type: "DOC", fileName: "test.txt", size: 4, contentBase64: Buffer.from("test").toString("base64"), uploadedBy: "User", extraDocument: true }],
    orderIds: ["order-1"], customField: { keep: true }, counter: 0
  };
  try {
    await assert.rejects(store.create({ id: randomUUID(), status: "DRAFT" }), /explicit reference/);
    const emptyDraft = { id: draftId, reference: `TEST-${draftId}`, status: "DRAFT", shipper: null, cargoLines: [], containers: null, dates: {} };
    assert.deepEqual(await store.create(emptyDraft), emptyDraft);
    assert.deepEqual(await store.get(draftId), emptyDraft);
    assert.deepEqual(await store.create(booking), booking);
    const raw = await pool.query("SELECT cargo_ready_date::text, client_requested_eta::text, created_at, additional_data FROM booking_portal_v4.bookings WHERE id = $1", [id]);
    assert.equal(raw.rows[0].cargo_ready_date, null);
    assert.equal(raw.rows[0].client_requested_eta, "2027-01-03");
    assert.equal(raw.rows[0].created_at.toISOString(), "2027-01-01T04:30:00.000Z");
    assert.equal(raw.rows[0].additional_data.extra.customField.keep, true);
    assert.equal(raw.rows[0].additional_data.extra.mode, undefined);
    assert.equal((await pool.query("SELECT content FROM booking_portal_v4.booking_documents WHERE booking_id = $1", [id])).rows[0].content.toString(), "test");
    assert.ok((await store.list()).some((item) => item.id === id));
    assert.equal(await store.get(randomUUID()), null);
    assert.equal(await store.update(randomUUID(), (item) => item), null);

    await pool.query("UPDATE booking_portal_v4.bookings SET cargo_ready_date = $2, client_requested_eta = $3, created_at = $4 WHERE id = $1", [id, "2028-02-01", "2028-02-02", "2028-02-03T00:00:00Z"]);
    await pool.query("UPDATE booking_portal_v4.booking_cargo_lines SET packages = $2 WHERE booking_id = $1 AND id = 'line-1'", [id, "9.50"]);
    const directlyEdited = await store.get(id);
    assert.equal(directlyEdited.cargoReadyDate, "2028-02-01");
    assert.equal(directlyEdited.clientRequestedEta, "2028-02-02");
    assert.equal(directlyEdited.createdAt, "2028-02-03T00:00:00.000Z");
    assert.equal(directlyEdited.cargoLines[0].packages, "9.50");

    await Promise.all(Array.from({ length: 5 }, () => store.update(id, async (current) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...current, id: "changed", reference: "changed", counter: current.counter + 1 };
    })));
    const afterConcurrency = await store.get(id);
    assert.equal(afterConcurrency.counter, 5);
    assert.equal(afterConcurrency.reference, reference);
    assert.equal(afterConcurrency.id, id);
    assert.deepEqual(afterConcurrency.documents, booking.documents);
    await assert.rejects(store.update(id, (current) => ({ ...current, cargoLines: [current.cargoLines[0], current.cargoLines[0]] })), { code: "23505" });
    await assert.rejects(store.update(id, (current) => ({ ...current, documents: [{ ...current.documents[0], size: 5 }] })), { code: "23514" });
    await assert.rejects(store.update(id, (current) => ({ ...current, documents: [{ ...current.documents[0], contentBase64: "AB==" }] })), /canonical base64/);
    await assert.rejects(store.update(id, () => { throw new Error("cancel update"); }), /cancel update/);
    assert.deepEqual(await store.get(id), afterConcurrency);

    const edited = await store.update(id, (current) => {
      assert.equal(current.cwOrgCode, "TEST");
      return { ...current, notes: "edited", shipper: { companyName: "Changed" }, dg: null, pickup: {}, dates: null, cargoLines: [current.cargoLines[1], current.cargoLines[0]], containers: [], customField: { keep: "edited" } };
    });
    assert.deepEqual(edited.cargoLines.map((line) => line.id), ["line-2", "line-1"]);
    assert.deepEqual(edited.shipper, { companyName: "Changed" });
    assert.equal(edited.dg, null);
    assert.deepEqual(edited.pickup, {});
    assert.deepEqual(edited.documents, booking.documents);
    const stale = await pool.query("SELECT dg_un_number, pickup_phone, required_pickup FROM booking_portal_v4.bookings WHERE id = $1", [id]);
    assert.deepEqual(stale.rows[0], { dg_un_number: null, pickup_phone: null, required_pickup: null });
    await assert.rejects(store.update(id, (current) => {
      if (current.cwOrgCode !== "OTHER") throw new Error("outside scope");
      return { ...current, notes: "unauthorized" };
    }), /outside scope/);
    assert.deepEqual(await store.get(id), edited);

    const moduleUrl = new URL("../src/lib/bookingRelationalStore.js", import.meta.url).href;
    const poolUrl = new URL("../src/lib/bookingStore.js", import.meta.url).href;
    const script = `import {createBookingPool} from ${JSON.stringify(poolUrl)}; import {createRelationalBookingStore} from ${JSON.stringify(moduleUrl)}; const pool=createBookingPool(); try { console.log(JSON.stringify(await createRelationalBookingStore(pool).get(process.argv[1]))); } finally { await pool.end(); }`;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, id], { env: process.env });
    assert.deepEqual(JSON.parse(stdout), edited);
  } finally {
    await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [[id, draftId]]);
    await pool.end();
  }
});
