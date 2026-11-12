import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createBookingPool, createBookingStore } from "../src/lib/bookingStore.js";

test("booking and approval transitions are atomic and serialized", { skip: process.env.BOOKING_DB_TEST !== "1" }, async () => {
  const pool = createBookingPool();
  const store = createBookingStore(pool);
  const id = randomUUID();
  const approvalId = randomUUID();
  try {
    await store.create({ id, status: "VALIDATED" });
    const approval = { id: approvalId, bookingId: id, status: "PENDING" };
    const submitted = await store.updateWithApproval(id, (booking, approvals) => {
      assert.deepEqual(approvals, []);
      return { booking: { ...booking, status: "PENDING_APPROVAL" }, approval };
    });
    assert.equal(submitted.booking.status, "PENDING_APPROVAL");
    assert.deepEqual(await store.getApproval(approvalId), approval);
    await assert.rejects(store.updateWithApproval(id, (booking) => ({
      booking: { ...booking, status: "APPROVED" },
      approval: { id: randomUUID(), bookingId: randomUUID() }
    })), /Approval must identify its booking/);
    assert.equal((await store.get(id)).status, "PENDING_APPROVAL");
    const decide = () => store.updateWithApproval(id, async (booking, approvals) => {
      const current = approvals.find((item) => item.id === approvalId);
      if (current.status !== "PENDING") throw new Error("already decided");
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { booking: { ...booking, status: "APPROVED" }, approval: { ...current, status: "APPROVED" } };
    });
    const decisions = await Promise.allSettled([decide(), decide()]);
    assert.equal(decisions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(decisions.filter((result) => result.status === "rejected").length, 1);
    assert.equal((await store.get(id)).status, "APPROVED");
    assert.equal((await store.getApproval(approvalId)).status, "APPROVED");
    assert.ok((await store.listApprovals()).some((item) => item.id === approvalId));
    assert.equal(await store.updateWithApproval(randomUUID(), () => { throw new Error("unexpected"); }), null);
  } finally {
    try {
      await pool.query("DELETE FROM booking_portal_v3.approvals WHERE booking_id = $1", [id]);
      await pool.query("DELETE FROM booking_portal_v3.bookings WHERE id = $1", [id]);
    } finally {
      await pool.end();
    }
  }
});
