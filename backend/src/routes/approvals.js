import { Router } from "../lib/http.js";
import { db, addAudit } from "../db.js";
import { requirePermission } from "../rbac.js";
const router = Router();
router.get("/", requirePermission("booking.approve"), (req, res) => { const status = (req.query.status || "PENDING").toUpperCase(); const items = db.approvals.filter((a) => a.status === status).map((a) => { const b = db.bookings.find((x) => x.id === a.bookingId); return { ...a, mode: b?.mode, shipper: b?.shipper?.companyName }; }); res.json({ total: items.length, items }); });
function decide(req, res, decision) { const a = db.approvals.find((x) => x.id === req.params.id); if (!a) return res.status(404).json({ error: "Approval request not found" }); if (a.status !== "PENDING") return res.status(409).json({ error: `Approval already ${a.status}` }); const comment = (req.body && req.body.comment) || ""; if (decision === "REJECTED" && !comment.trim()) return res.status(400).json({ error: "A comment is required when rejecting" }); const b = db.bookings.find((x) => x.id === a.bookingId); a.status = decision; a.decidedBy = req.user.name; a.decidedAt = new Date().toISOString(); a.comment = comment; if (b) { b.status = decision === "APPROVED" ? "APPROVED" : "DRAFT"; b.updatedAt = new Date().toISOString(); } addAudit({ user: req.user, action: decision === "APPROVED" ? "APPROVE" : "REJECT", entityType: "Booking", entityId: a.bookingReference }); res.json({ status: decision, approval: a, booking: b }); }
router.post("/:id/approve", requirePermission("booking.approve"), (req, res) => decide(req, res, "APPROVED"));
router.post("/:id/reject", requirePermission("booking.approve"), (req, res) => decide(req, res, "REJECTED"));
export default router;
