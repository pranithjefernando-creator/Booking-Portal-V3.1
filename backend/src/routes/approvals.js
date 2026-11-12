import { Router } from "../lib/http.js";
import { addAudit, canSeeBooking } from "../db.js";
import { bookingDatabase } from "../lib/bookingDatabase.js";
import { requirePermission } from "../rbac.js";

const router = Router();

router.get("/", requirePermission("booking.approve"), async (req, res) => {
  const status = (req.query.status || "PENDING").toUpperCase();
  const [approvals, bookings] = await Promise.all([bookingDatabase().listApprovals(), bookingDatabase().list()]);
  const byId = new Map(bookings.map((booking) => [booking.id, booking]));
  const items = approvals.filter((approval) => approval.status === status).flatMap((approval) => {
    const booking = byId.get(approval.bookingId);
    return booking && canSeeBooking(req.user, booking) ? [{ ...approval, mode: booking.mode, shipper: booking.shipper?.companyName }] : [];
  });
  res.json({ total: items.length, items });
});

async function decide(req, res, decision) {
  const comment = req.body?.comment || "";
  if (typeof comment !== "string") return res.status(400).json({ error: "Comment must be a string" });
  if (decision === "REJECTED" && !comment.trim()) return res.status(400).json({ error: "A comment is required when rejecting" });
  const stored = await bookingDatabase().getApproval(req.params.id);
  if (!stored) return res.status(404).json({ error: "Approval request not found" });
  let rejected;
  const result = await bookingDatabase().updateWithApproval(stored.bookingId, (booking, approvals) => {
    const approval = approvals.find((item) => item.id === req.params.id);
    if (!approval) { rejected = { status: 404, error: "Approval request not found" }; return { booking }; }
    if (!canSeeBooking(req.user, booking)) { rejected = { status: 403, error: "This booking is outside your assigned CW organizations" }; return { booking }; }
    if (approval.status !== "PENDING") { rejected = { status: 409, error: `Approval already ${approval.status}` }; return { booking }; }
    if (booking.status !== "PENDING_APPROVAL") { rejected = { status: 409, error: `Cannot decide approval for a ${booking.status} booking` }; return { booking }; }
    const now = new Date().toISOString();
    return {
      booking: { ...booking, status: decision === "APPROVED" ? "APPROVED" : "DRAFT", updatedAt: now },
      approval: { ...approval, status: decision, decidedBy: req.user.name, decidedAt: now, comment }
    };
  });
  if (!result) return res.status(404).json({ error: "Booking not found" });
  if (rejected) return res.status(rejected.status).json({ error: rejected.error });
  addAudit({ user: req.user, action: decision === "APPROVED" ? "APPROVE" : "REJECT", entityType: "Booking", entityId: result.approval.bookingReference });
  res.json({ status: decision, approval: result.approval, booking: result.booking });
}

router.post("/:id/approve", requirePermission("booking.approve"), (req, res) => decide(req, res, "APPROVED"));
router.post("/:id/reject", requirePermission("booking.approve"), (req, res) => decide(req, res, "REJECTED"));
export default router;
