import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { createBookingPool } from "../src/lib/bookingStore.js";
import { createRelationalBookingStore } from "../src/lib/bookingRelationalStore.js";

const execFileAsync = promisify(execFile);

test("staged v4 documents, approvals, imports and order links are atomic and restart-safe", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const store = createRelationalBookingStore(pool);
  const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [id, otherId, importedId, secondImportedId] = ids;
  const approvalId = randomUUID();
  const importId = randomUUID();
  const orderId = `sql-${Buffer.from(`TEST-${randomUUID()}`).toString("base64url")}`;
  const reference = `TEST-${id}`;
  const check = (booking) => booking.cwOrgCode === "VISIBLE";
  const doc = { id: randomUUID(), type: "DOC", typeName: "Document", fileName: "file.txt", size: 4, mimeType: "text/plain", contentBase64: Buffer.from("data").toString("base64"), uploadedBy: "User" };
  const importing = createRelationalBookingStore(pool, { allocateReference: async (_client, booking) => `TEST-IMPORT-${booking.id}` });
  try {
    await store.create({ id, reference, status: "VALIDATED", cwOrgCode: "VISIBLE", cargoLines: [{ id: "line", packages: 1 }], documents: [] });
    await store.create({ id: otherId, reference: `TEST-${otherId}`, status: "DRAFT", cwOrgCode: "OTHER" });

    await store.update(id, (booking) => { booking.documents.push(doc); return booking; });
    assert.deepEqual((await store.get(id)).documents, [doc]);
    assert.equal((await pool.query("SELECT content FROM booking_portal_v4.booking_documents WHERE booking_id = $1 AND id = $2", [id, doc.id])).rows[0].content.toString(), "data");
    await assert.rejects(store.update(id, (booking) => { booking.documents.push({ ...doc, id: randomUUID(), size: 5 }); return booking; }), { code: "23514" });
    assert.deepEqual((await store.get(id)).documents, [doc]);

    const approval = { id: approvalId, bookingId: id, bookingReference: reference, status: "PENDING" };
    const submitted = await store.updateWithApproval(id, (booking, approvals) => {
      assert.deepEqual(approvals, []);
      return { booking: { ...booking, status: "PENDING_APPROVAL", reference: "forged" }, approval };
    });
    assert.equal(submitted.booking.reference, reference);
    assert.deepEqual(submitted.booking.documents, [doc]);
    assert.deepEqual(await store.getApproval(approvalId), approval);
    await assert.rejects(store.updateWithApproval(id, (booking) => ({ booking: { ...booking, status: "APPROVED" }, approval: { id: randomUUID(), bookingId: otherId } })), /Approval must identify its booking/);
    assert.equal((await store.get(id)).status, "PENDING_APPROVAL");
    assert.equal((await store.getApproval(approvalId)).status, "PENDING");
    const decide = () => store.updateWithApproval(id, async (booking, approvals) => {
      const current = approvals.find((item) => item.id === approvalId);
      if (current.status !== "PENDING") throw new Error("already decided");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { booking: { ...booking, status: "APPROVED" }, approval: { ...current, status: "APPROVED" } };
    });
    const results = await Promise.allSettled([decide(), decide()]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.get(id)).status, "APPROVED");
    assert.equal((await store.getApproval(approvalId)).status, "APPROVED");
    assert.ok((await store.listApprovals()).some((item) => item.id === approvalId));
    assert.equal(await store.updateWithApproval(randomUUID(), () => { throw new Error("unexpected"); }), null);

    const batch = { id: importId, ownerEmail: "test@example.invalid", valid: 1, rows: [
      { rowNo: 1, status: "ERROR", bookingId: importedId, booking: { notes: "needs edit" } },
      { rowNo: 2, status: "VALID", bookingId: secondImportedId, booking: { notes: "second" } }
    ] };
    await store.createImport(batch);
    await assert.rejects(store.updateImport(importId, () => { throw new Error("not owner"); }), /not owner/);
    await store.updateImport(importId, (current) => { current.rows[0].booking.notes = "edited"; current.rows[0].status = "VALID"; current.valid = 2; return current; });
    assert.equal((await store.getImport(importId)).rows[0].booking.notes, "edited");
    await assert.rejects(store.commitImport(importId, () => { throw new Error("must not execute"); }), /reference allocator is not configured/);
    const makeBooking = (row) => ({ id: row.bookingId, status: "VALIDATED", cwOrgCode: "VISIBLE", notes: row.booking.notes, documents: [], cargoLines: [{ id: `cargo-${row.rowNo}`, packages: row.rowNo }] });
    await assert.rejects(importing.commitImport(importId, makeBooking, () => { throw new Error("not owner"); }), /not owner/);
    await assert.rejects(importing.commitImport(importId, (row) => {
      if (row.rowNo === 2) throw new Error("row failure");
      return makeBooking(row);
    }), /row failure/);
    assert.equal(await store.get(importedId), null);
    assert.equal((await store.getImport(importId)).rows[0].status, "VALID");
    const commits = await Promise.all([importing.commitImport(importId, makeBooking), importing.commitImport(importId, makeBooking)]);
    assert.deepEqual(commits.map((result) => result.bookings.length).sort(), [0, 2]);
    assert.equal((await store.getImport(importId)).valid, 0);
    assert.ok((await store.getImport(importId)).rows.every((row) => row.status === "COMMITTED"));
    assert.equal((await store.get(importedId)).cargoLines[0].packages, 1);
    assert.equal(await store.commitImport(randomUUID(), makeBooking), null);
    assert.equal(await store.updateImport(randomUUID(), (value) => value), null);

    assert.deepEqual(await store.linkOrder(orderId, randomUUID(), check), { status: "not_found" });
    assert.deepEqual(await store.linkOrder(orderId, otherId, check), { status: "forbidden" });
    assert.deepEqual(await store.linkOrder(orderId, id, check), { status: "linked", bookingRef: reference });
    assert.deepEqual(await store.linkOrder(orderId, id, check), { status: "linked", bookingRef: reference });
    assert.deepEqual(await store.linkOrder(orderId, otherId, () => true), { status: "conflict" });
    assert.deepEqual(await store.unlinkOrder(orderId, () => false), { status: "forbidden" });
    assert.deepEqual(await store.unlinkOrder(orderId, check, otherId), { status: "conflict" });
    assert.deepEqual((await store.listOrderLinks()).find((link) => link.orderId === orderId), { orderId, bookingId: id, bookingRef: reference, booking: { cwOrgCode: "VISIBLE" } });

    const moduleUrl = new URL("../src/lib/bookingRelationalStore.js", import.meta.url).href;
    const poolUrl = new URL("../src/lib/bookingStore.js", import.meta.url).href;
    const script = `import {createBookingPool} from ${JSON.stringify(poolUrl)}; import {createRelationalBookingStore} from ${JSON.stringify(moduleUrl)}; const pool=createBookingPool(); try { const s=createRelationalBookingStore(pool); console.log(JSON.stringify({booking:await s.get(process.argv[1]), approval:await s.getApproval(process.argv[2]), batch:await s.getImport(process.argv[3]), links:await s.listOrderLinks()})); } finally { await pool.end(); }`;
    const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script, id, approvalId, importId], { env: process.env });
    const restarted = JSON.parse(stdout);
    assert.deepEqual(restarted.booking.documents, [doc]);
    assert.equal(restarted.booking.status, "APPROVED");
    assert.equal(restarted.approval.status, "APPROVED");
    assert.ok(restarted.batch.rows.every((row) => row.status === "COMMITTED"));
    assert.ok(restarted.links.some((link) => link.orderId === orderId && link.bookingId === id));
    await store.update(id, (booking) => { booking.documents = []; return booking; });
    assert.deepEqual((await store.get(id)).documents, []);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM booking_portal_v4.booking_documents WHERE booking_id = $1", [id])).rows[0].count, 0);
    assert.deepEqual(await store.unlinkOrder(orderId, check, id), { status: "unlinked" });
    assert.deepEqual(await store.unlinkOrder(orderId, check), { status: "unlinked" });
  } finally {
    try {
      await pool.query("DELETE FROM booking_portal_v4.order_links WHERE order_id = $1", [orderId]);
      await pool.query("DELETE FROM booking_portal_v4.approvals WHERE id = $1", [approvalId]);
      await pool.query("DELETE FROM booking_portal_v4.imports WHERE id = $1", [importId]);
      await pool.query("DELETE FROM booking_portal_v4.bookings WHERE id = ANY($1::text[])", [ids]);
    } finally { await pool.end(); }
  }
});
