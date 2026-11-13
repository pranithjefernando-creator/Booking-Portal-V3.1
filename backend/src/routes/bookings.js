import { Router } from "../lib/http.js";
import { uuid, canSeeBooking, canSeeOrder, defaultBookingOrg, bookingShipperOrgsFor, bookingConsigneeOrgsFor, toOptions, DOC_TYPES } from "../db.js";
import { findOrder } from "../lib/orderDb.js";
import { requestCan, requirePermission, effectiveModules } from "../rbac.js";
import { validateBooking } from "../validation.js";
import { orgLabel, orgDetails, scopedDirectory } from "../reference.js";
import { buildBookingXml, buildBookingUpdateXml } from "../lib/cwPayload.js";
import { sendBookingToCw } from "../lib/cwClient.js";
import { bookingDatabase } from "../lib/bookingDatabase.js";
const router = Router();
function summarise(b, orders) { const linkedOrders = orders.map((o) => o.orderNo + (o.orderNoSplit ? `-${o.orderNoSplit}` : "")).filter(Boolean); return { id: b.id, reference: b.reference, status: b.status, mode: b.mode, incotermCode: b.incotermCode, freightTerms: b.freightTerms || "", commodityCode: b.commodityCode || "", originCode: b.originCode, destCode: b.destCode, shipper: b.shipper?.companyName || orgLabel(b.shipperCode), shipperCode: b.shipperCode || "", consignee: b.consignee?.companyName || orgLabel(b.consigneeCode), consigneeCode: b.consigneeCode || "", goodsDescription: b.goodsDescription || "", marksAndNumbers: b.marksAndNumbers || "", shipperReferenceNo: b.shipperReferenceNo || "", cargoReadyDate: b.cargoReadyDate, cwOrgCode: b.cwOrgCode || "", cw1ShipmentRef: b.cw1ShipmentRef || "", cwStatus: b.cwStatus || "", cwConverted: !!b.cwConverted, cfsReceived: !!b.cfsReceived, isDg: !!b.isDg, documentCount: (b.documents || []).length, linkedOrders, createdAt: b.createdAt, updatedAt: b.updatedAt, createdBy: b.createdBy }; }
async function linkedOrdersByBooking(req) { const user = req.user; const grouped = new Map(); if (!requestCan(req, "order.view") || !effectiveModules(user, req.accessRole).includes("orders")) return grouped; for (const link of await bookingDatabase().listOrderLinks()) { const order = findOrder(link.orderId); if (!order || !canSeeOrder(user, order)) continue; if (!grouped.has(link.bookingId)) grouped.set(link.bookingId, []); grouped.get(link.bookingId).push(order); } return grouped; }
function docMeta(d) { return { id: d.id, type: d.type, typeName: d.typeName, fileName: d.fileName, size: d.size, mimeType: d.mimeType || mimeFromName(d.fileName), uploadedBy: d.uploadedBy }; }
function mimeFromName(name) { const ext = String(name || "").toLowerCase().split(".").pop(); const map = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", csv: "text/csv", xml: "application/xml", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }; return map[ext] || "application/octet-stream"; }
function buildXmlFor(b) { return b && b.cw1ShipmentRef ? buildBookingUpdateXml(b, b.cw1ShipmentRef) : buildBookingXml(b); }
const CW_MANAGED = ["cw1ShipmentRef", "cwStatus", "cwHttpStatus", "cwResponse", "cwSentAt", "cwConverted", "cwLastAction", "status", "completedAt", "createdByEmail"];
function sanitizeNewBooking(body) { const b = { ...(body || {}) }; for (const k of CW_MANAGED) delete b[k]; return b; }
async function pushToCw(b, user, action, appendAudit) { const isUpdate = !!b.cw1ShipmentRef; const xml = buildXmlFor(b); let cw; let sent = false; try { cw = await sendBookingToCw(xml, { isUpdate }); b.cwStatus = cw.ok ? "SENT" : "FAILED"; b.cwHttpStatus = cw.status; b.cwResponse = (cw.response || cw.error || "").slice(0, 20000); b.cwSentAt = new Date().toISOString(); b.cwLastAction = isUpdate ? "UPDATE" : "CREATE"; if (cw.cwBookingNumber) b.cw1ShipmentRef = cw.cwBookingNumber; sent = true; } catch (e) { cw = { ok: false, status: 0, error: String(e && e.message || e), response: "" }; b.cwStatus = "FAILED"; b.cwResponse = String(e && e.message || e); } if (sent) await appendAudit({ user, action: action || (isUpdate ? "CW_UPDATE" : "CW_SEND"), entityType: "Booking", entityId: b.reference, after: { httpStatus: cw.status, ok: cw.ok } }); b.updatedAt = new Date().toISOString(); return { cw, isUpdate }; }
function editableReason(b) { if (b.status === "CANCELLED") return "Cannot edit a cancelled booking"; if (b.status === "PENDING_APPROVAL") return "Cannot edit a booking while approval is pending"; if (b.status === "COMPLETED" && b.cwConverted) return "This booking has been converted to a shipment in CargoWise and can no longer be edited"; return null; }
router.get("/meta/orgs", requirePermission("booking.view"), (req, res) => { const shipperOrgs = toOptions(bookingShipperOrgsFor(req.user)); const consigneeOrgs = toOptions(bookingConsigneeOrgsFor(req.user)); res.json({ shipperOrgs, consigneeOrgs, directory: scopedDirectory([...shipperOrgs, ...consigneeOrgs]) }); });
const TF = ["mode","incotermCode","freightTerms","originCode","destCode","cargoReadyDate","commodityCode","goodsDescription","marksAndNumbers","shipperReferenceNo","notes","shipperCode","consigneeCode","shipper","consignee","cargoLines","containers","isDg","dg","pickupRequired","pickup","dates","clientRequestedEta","handlingRemarks","documentsAccompanying"];
function pickTemplate(src) { const out = {}; TF.forEach((k) => { if (src[k] !== undefined) out[k] = src[k]; }); for (const key of ["cargoLines", "containers"]) { if (out[key]) out[key] = out[key].map(({ id, ...item }) => item); } return out; }
router.get("/templates", requirePermission("booking.create"), async (req, res) => { const list = await bookingDatabase().listTemplates(req.user.email); res.json({ templates: list.map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, mode: t.data?.mode || "" })) }); });
router.get("/templates/:id", requirePermission("booking.create"), async (req, res) => { const t = await bookingDatabase().getTemplate(req.user.email, req.params.id); if (!t) return res.status(404).json({ error: "Template not found" }); res.json(t); });
router.post("/templates", requirePermission("booking.create"), async (req, res) => { const { name, data } = req.body || {}; if (!name || !String(name).trim()) return res.status(400).json({ error: "Template name is required" }); const { record, created } = await bookingDatabase().saveTemplate(req.user.email, { id: uuid(), name: String(name).trim(), data: pickTemplate(data || {}), createdAt: new Date().toISOString() }); res.status(created ? 201 : 200).json({ id: record.id, name: record.name }); });
router.delete("/templates/:id", requirePermission("booking.create"), async (req, res) => { await bookingDatabase().deleteTemplate(req.user.email, req.params.id); res.json({ ok: true }); });
router.get("/kpis", requirePermission("booking.view"), async (req, res) => { const all = (await bookingDatabase().list()).filter((b) => canSeeBooking(req.user, b)); res.json({ total: all.length, draft: all.filter((b) => b.status === "DRAFT").length, validated: all.filter((b) => b.status === "VALIDATED").length, pendingApproval: all.filter((b) => b.status === "PENDING_APPROVAL").length, completed: all.filter((b) => b.status === "COMPLETED").length }); });
router.get("/", requirePermission("booking.view"), async (req, res) => { let items = (await bookingDatabase().list()).filter((b) => canSeeBooking(req.user, b)); const { status, mode, origin, dest, q } = req.query; if (status) items = items.filter((b) => b.status === status); if (mode) items = items.filter((b) => b.mode === mode); if (origin) items = items.filter((b) => b.originCode === origin); if (dest) items = items.filter((b) => b.destCode === dest); if (q) { const s = String(q).toLowerCase(); items = items.filter((b) => [b.reference, b.shipper?.companyName, b.consignee?.companyName, b.goodsDescription, b.shipperReferenceNo, b.cw1ShipmentRef].filter(Boolean).some((v) => String(v).toLowerCase().includes(s))); } items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)); const orders = await linkedOrdersByBooking(req); res.json({ total: items.length, items: items.map((b) => summarise(b, orders.get(b.id) || [])) }); });
router.get("/:id", requirePermission("booking.view"), async (req, res) => { const b = await bookingDatabase().get(req.params.id); if (!b) return res.status(404).json({ error: "Booking not found" }); if (!canSeeBooking(req.user, b)) return res.status(403).json({ error: "This booking is outside your assigned CW organizations" }); const approval = (await bookingDatabase().listApprovals()).find((a) => a.bookingId === b.id && a.status === "PENDING"); const orders = (await linkedOrdersByBooking(req)).get(b.id) || []; const linkedOrders = orders.map((o) => ({ id: o.id, reference: o.reference, orderNo: o.orderNo, status: o.status })); res.json({ ...b, orderIds: orders.map((o) => o.id), documents: (b.documents || []).map(docMeta), editable: !editableReason(b), editBlockedReason: editableReason(b), pendingApproval: approval || null, requiresApproval: b.status === "VALIDATED" ? await req.evaluateBookingApproval(b) : null, linkedOrders }); });
function fillParty(party, code) { const d = orgDetails(code); return { ...(party || {}), code: d.code, companyName: d.name, name: d.name, address1: d.address1, address2: d.address2, city: d.city, state: d.state, postCode: d.postCode, country: d.country, phone: d.phone || "", email: d.email || "" }; }
function applyOrgs(b) { if (b.shipperCode) { b.shipper = fillParty(b.shipper, b.shipperCode); if (!b.cwOrgCode) b.cwOrgCode = b.shipperCode; } if (b.consigneeCode) { b.consignee = fillParty(b.consignee, b.consigneeCode); } }
function blankBooking(user) { return { status: "DRAFT", freightTerms: "Prepaid", notes: "", branchCode: user?.branchCode || "CMB", cwOrgCode: "", shipperCode: "", consigneeCode: "", marksAndNumbers: "", cfsReceived: false, shipper: {}, consignee: {}, cargoLines: [], containers: [], isDg: false, dg: { unNumber: "", properShippingName: "", dgClass: "", packingGroup: "", specialHandling: "" }, pickupRequired: false, pickup: { phone: "", contact: "", address: "", estimatedPickup: "", requiredDate: "", estimatedDelivery: "", deliveryRequiredBy: "" }, dates: { requiredPickup: "", requiredEtd: "", requiredEta: "", requestedDelivery: "" }, clientRequestedEta: "", handlingRemarks: "", documentsAccompanying: "", documents: [], cw1ShipmentRef: "", cwStatus: "", cwHttpStatus: 0, cwResponse: "", cwSentAt: "", cwConverted: false, cwLastAction: "", orderIds: [] }; }
router.post("/", requirePermission("booking.create"), async (req, res) => { const now = new Date().toISOString(); const b = { ...blankBooking(req.user), ...sanitizeNewBooking(req.body), id: uuid(), orderIds: [], documents: [], status: "DRAFT", cw1ShipmentRef: "", cwStatus: "", cwConverted: false, createdByUserId: req.user.id, createdByEmail: req.user.email, createdBy: req.user.name, updatedBy: req.user.name, createdAt: now, updatedAt: now }; applyOrgs(b); if (!b.cwOrgCode) b.cwOrgCode = defaultBookingOrg(req.user); (b.cargoLines || []).forEach((l) => { if (!l.id) l.id = uuid(); }); (b.containers || []).forEach((c) => { if (!c.id) c.id = uuid(); }); if (!canSeeBooking(req.user, b)) return res.status(403).json({ error: "This booking is outside your assigned CW organizations" }); const saved = await bookingDatabase().create(b, { user: req.user, action: "CREATE", entityType: "Booking" }); res.status(201).json(saved); });
router.put("/:id", requirePermission("booking.edit"), async (req, res) => { let rejected; const b = await bookingDatabase().update(req.params.id, async (current, appendAudit) => { if (!canSeeBooking(req.user, current)) { rejected = { status: 403, error: "This booking is outside your assigned CW organizations" }; return current; } const reason = editableReason(current); if (reason) { rejected = { status: 409, error: reason }; return current; } const wasCompleted = current.status === "COMPLETED"; const body = { ...(req.body || {}) }; for (const k of [...CW_MANAGED, "id", "reference", "documents", "createdAt", "createdBy", "createdByUserId", "orderIds"]) delete body[k]; const updated = { ...current, ...body, updatedBy: req.user.name, updatedAt: new Date().toISOString() }; applyOrgs(updated); if (!canSeeBooking(req.user, updated)) { rejected = { status: 403, error: "This booking is outside your assigned CW organizations" }; return current; } if (updated.status === "VALIDATED") updated.status = "DRAFT"; (updated.cargoLines || []).forEach((l) => { if (!l.id) l.id = uuid(); }); (updated.containers || []).forEach((c) => { if (!c.id) c.id = uuid(); }); await appendAudit({ user: req.user, action: wasCompleted ? "EDIT_COMPLETED" : "UPDATE", entityType: "Booking", entityId: current.reference }); return updated; }); if (!b) return res.status(404).json({ error: "Booking not found" }); if (rejected) return res.status(rejected.status).json({ error: rejected.error }); const orders = (await linkedOrdersByBooking(req)).get(b.id) || []; res.json({ ...b, orderIds: orders.map((o) => o.id), documents: (b.documents || []).map(docMeta), editable: !editableReason(b) }); });
async function mutateBooking(req, res, change) { let response; const b = await bookingDatabase().update(req.params.id, async (current, appendAudit) => { if (!canSeeBooking(req.user, current)) { response = { status: 403, body: { error: "This booking is outside your assigned CW organizations" } }; return current; } response = await change(current, appendAudit); return current; }); if (!b) { res.status(404).json({ error: "Booking not found" }); return; } res.status(response.status || 200).json(response.body); }
router.post("/:id/validate", requirePermission("booking.validate"), async (req, res) => mutateBooking(req, res, async (b) => { if (b.status === "PENDING_APPROVAL") return { status: 409, body: { error: "Cannot validate a booking while approval is pending" } }; const errors = validateBooking(b); if (errors.length) return { status: 400, body: { status: "INVALID", errors } }; b.status = "VALIDATED"; b.updatedAt = new Date().toISOString(); return { body: { status: "VALIDATED", requiresApproval: await req.evaluateBookingApproval(b), booking: b } }; }));
router.post("/:id/submit-approval", requirePermission("booking.validate"), async (req, res) => {
  let rejected;
  const result = await bookingDatabase().updateWithApproval(req.params.id, async (b, approvals) => {
    if (!canSeeBooking(req.user, b)) { rejected = { status: 403, error: "This booking is outside your assigned CW organizations" }; return { booking: b }; }
    if (b.status !== "VALIDATED" || approvals.some((a) => a.status === "PENDING")) { rejected = { status: 409, error: "Only VALIDATED bookings without a pending approval can be submitted" }; return { booking: b }; }
    const matchedRules = await req.evaluateBookingApproval(b) || [];
    if (!matchedRules.length) { rejected = { status: 422, error: "Does not require approval" }; return { booking: b }; }
    const ruleName = matchedRules.join("; ");
    const now = new Date().toISOString();
    const approval = { id: uuid(), bookingId: b.id, bookingReference: b.reference, status: "PENDING", ruleName, matchedRules, requestedBy: req.user.name, requestedAt: now, decidedBy: null, decidedAt: null, comment: null };
    return { booking: { ...b, status: "PENDING_APPROVAL", updatedAt: now }, approval };
  });
  if (!result) return res.status(404).json({ error: "Booking not found" });
  if (rejected) return res.status(rejected.status).json({ error: rejected.error });
  res.json({ status: "PENDING_APPROVAL", ruleName: result.approval.ruleName, matchedRules: result.approval.matchedRules, booking: result.booking });
});
async function sendTrackedBooking(req, res, complete) {
  const store = bookingDatabase();
  const existing = await store.get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Booking not found" });
  if (!canSeeBooking(req.user, existing)) return res.status(403).json({ error: "This booking is outside your assigned CW organizations" });
  const response = await store.runExternalOperation({
    key: `cw:${existing.id}`, kind: complete ? "CW_COMPLETE" : "CW_SEND",
    entityId: existing.id, entityRef: existing.reference, user: req.user,
    details: { isUpdate: !!existing.cw1ShipmentRef, previousStatus: existing.status }
  }, async (operation) => {
    let response;
    let successful = false;
    const saved = await store.update(existing.id, async (b, appendAudit) => {
      if (!canSeeBooking(req.user, b)) { response = { status: 403, body: { error: "This booking is outside your assigned CW organizations" } }; return b; }
      if (b.status !== existing.status || b.cw1ShipmentRef !== existing.cw1ShipmentRef) { response = { status: 409, body: { error: "The booking changed. Refresh it before sending to CargoWise." } }; return b; }
      if (complete) {
        if (b.status === "VALIDATED") {
          const rule = await req.evaluateBookingApproval(b);
          if (rule) { response = { status: 409, body: { error: `Approval required (${rule})`, requiresApproval: rule } }; return b; }
        } else if (b.status !== "APPROVED") { response = { status: 409, body: { error: `Cannot complete a booking in status ${b.status}` } }; return b; }
        b.status = "COMPLETED"; b.completedAt = new Date().toISOString();
      } else {
        if (!["COMPLETED", "APPROVED", "VALIDATED"].includes(b.status)) { response = { status: 409, body: { error: `Cannot send in status ${b.status}` } }; return b; }
        if (b.status === "COMPLETED" && b.cwConverted) { response = { status: 409, body: { error: "Converted to a shipment — updates no longer accepted" } }; return b; }
      }
      const { cw, isUpdate } = await pushToCw(b, req.user, complete ? "CW_SEND" : undefined, appendAudit);
      successful = cw.ok && !!b.cw1ShipmentRef;
      const result = successful ? cw : { ...cw, ok: false, error: "CargoWise outcome requires administrator reconciliation. Do not retry." };
      response = { body: { status: b.status, cw: result, ...(complete ? {} : { isUpdate }), cw1ShipmentRef: b.cw1ShipmentRef, booking: { ...b, documents: (b.documents || []).map(docMeta) }, ...(!successful ? { reconciliationRequired: true } : {}) } };
      return b;
    }, { operationId: operation.id, client: operation.client, shouldComplete: () => successful });
    if (!saved || response.status) {
      await operation.abort();
      return response || { status: 404, body: { error: "Booking not found" } };
    }
    return response;
  });
  return res.status(response.status || 200).json(response.body);
}
router.post("/:id/complete", requirePermission("booking.complete"), (req, res) => sendTrackedBooking(req, res, true));
router.post("/:id/resend-cw", requirePermission("booking.complete"), (req, res) => sendTrackedBooking(req, res, false));
router.get("/:id/cw-xml", requirePermission("booking.view"), async (req, res) => { const b = await bookingDatabase().get(req.params.id); if (!b) return res.status(404).json({ error: "Booking not found" }); if (!canSeeBooking(req.user, b)) return res.status(403).json({ error: "This booking is outside your assigned CW organizations" }); res.setHeader("Content-Type", "application/xml"); res.send(buildXmlFor(b)); });
router.post("/:id/mark-converted", requirePermission("booking.complete"), async (req, res) => mutateBooking(req, res, (b) => { if (b.status !== "COMPLETED" || !b.cw1ShipmentRef) return { status: 409, body: { error: "Only completed bookings with a CW number" } }; b.cwConverted = req.body?.converted !== false; b.updatedAt = new Date().toISOString(); return { body: { cwConverted: b.cwConverted, editable: !editableReason(b) } }; }));
router.post("/:id/cancel", requirePermission("booking.cancel"), async (req, res) => mutateBooking(req, res, (b) => { if (["COMPLETED", "CANCELLED", "PENDING_APPROVAL"].includes(b.status)) return { status: 409, body: { error: `Cannot cancel a ${b.status} booking` } }; if (!((req.body && req.body.reason) || "").trim()) return { status: 400, body: { error: "Cancellation reason is required" } }; b.status = "CANCELLED"; b.updatedAt = new Date().toISOString(); return { body: { status: "CANCELLED", booking: b } }; }));
router.post("/:id/cfs-received", requirePermission("booking.edit"), async (req, res) => mutateBooking(req, res, (b) => { b.cfsReceived = req.body?.received !== false; b.cfsReceivedAt = b.cfsReceived ? new Date().toISOString().slice(0, 10) : ""; return { body: { cfsReceived: b.cfsReceived } }; }));
router.post("/:id/documents", requirePermission("booking.document"), async (req, res) => mutateBooking(req, res, (b) => { if (!req.file) return { status: 400, body: { error: "No file provided" } }; let type = String(req.body?.type || "DOC").toUpperCase(); if (!DOC_TYPES[type]) type = "DOC"; const fileName = req.file.originalname || `${type}.bin`; const doc = { id: uuid(), type, typeName: DOC_TYPES[type], fileName, size: req.file.buffer.length, mimeType: mimeFromName(fileName), contentBase64: req.file.buffer.toString("base64"), uploadedBy: req.user.name }; b.documents = b.documents || []; b.documents.push(doc); return { status: 201, body: { document: docMeta(doc) } }; }));
async function sendDocument(req, res, inline) { const b = await bookingDatabase().get(req.params.id); if (!b) return res.status(404).json({ error: "Booking not found" }); if (!canSeeBooking(req.user, b)) return res.status(403).json({ error: "This booking is outside your assigned CW organizations" }); const d = (b.documents || []).find((x) => x.id === req.params.docId); if (!d) return res.status(404).json({ error: "Document not found" }); res.setHeader("Content-Type", inline ? (d.mimeType || mimeFromName(d.fileName)) : "application/octet-stream"); res.setHeader("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${d.fileName}"`); res.send(Buffer.from(d.contentBase64, "base64")); }
router.get("/:id/documents/:docId/content", requirePermission("booking.view"), async (req, res) => sendDocument(req, res, true));
router.get("/:id/documents/:docId/download", requirePermission("booking.view"), async (req, res) => sendDocument(req, res, false));
router.delete("/:id/documents/:docId", requirePermission("booking.document"), async (req, res) => mutateBooking(req, res, (b) => { b.documents = (b.documents || []).filter((x) => x.id !== req.params.docId); return { body: { ok: true, documents: b.documents.map(docMeta) } }; }));
router.get("/layouts/list", requirePermission("booking.view"), async (req, res) => res.json({ layouts: await bookingDatabase().getPreferences(req.user.email, "layouts") }));
router.post("/layouts", requirePermission("booking.view"), async (req, res) => { const { name, columns } = req.body || {}; if (!name || !String(name).trim()) return res.status(400).json({ error: "Layout name is required" }); if (!Array.isArray(columns)) return res.status(400).json({ error: "columns must be an array" }); const layouts = await bookingDatabase().updatePreferences(req.user.email, "layouts", (items) => { const ex = items.find((l) => l.name.toLowerCase() === String(name).trim().toLowerCase()); if (ex) ex.columns = columns; else items.push({ id: uuid(), name: String(name).trim(), columns, createdAt: new Date().toISOString() }); return items; }); res.status(201).json({ layouts }); });
router.delete("/layouts/:id", requirePermission("booking.view"), async (req, res) => { const layouts = await bookingDatabase().updatePreferences(req.user.email, "layouts", (items) => items.filter((l) => l.id !== req.params.id)); res.json({ layouts }); });
router.get("/filters/list", requirePermission("booking.view"), async (req, res) => res.json({ layouts: await bookingDatabase().getPreferences(req.user.email, "filters") }));
router.post("/filters", requirePermission("booking.view"), async (req, res) => {
  const key = req.user.email;
  const name = String(req.body?.name || "").trim();
  const filters = req.body?.filters;
  if (!name) return res.status(400).json({ error: "Filter layout name is required" });
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 20 || filters.some((filter) => !filter || typeof filter.field !== "string" || typeof filter.operator !== "string" || filter.value == null)) return res.status(400).json({ error: "Provide between 1 and 20 valid filters" });
  const layouts = await bookingDatabase().updatePreferences(key, "filters", (items) => {
    const existing = items.find((layout) => layout.name.toLowerCase() === name.toLowerCase());
    if (existing) existing.filters = filters;
    else items.push({ id: uuid(), name, filters, createdAt: new Date().toISOString() });
    return items;
  });
  res.status(201).json({ layouts });
});
router.delete("/filters/:id", requirePermission("booking.view"), async (req, res) => {
  const layouts = await bookingDatabase().updatePreferences(req.user.email, "filters", (items) => items.filter((layout) => layout.id !== req.params.id));
  res.json({ layouts });
});
export default router;
