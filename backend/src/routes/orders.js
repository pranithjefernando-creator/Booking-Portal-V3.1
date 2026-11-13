import { Router } from "../lib/http.js";
import { db, uuid, canSeeOrder, canSeeBooking, userHasOrderAccess, makeOrder, defaultOrderOrg, orderSupplierOrgsFor, orderBuyerOrgsFor, toOptions } from "../db.js";
import { requestCan, requirePermission, hasBookingModule, requireBookingModule } from "../rbac.js";
import { validateOrder } from "../validation.js";
import { readXlsx, sheetToObjects } from "../lib/xlsx.js";
import { orgLabel, orgDetails, scopedDirectory } from "../reference.js";
import { allOrders, findOrder, isSqlOrder } from "../lib/orderDb.js";
import { bookingDatabase } from "../lib/bookingDatabase.js";
const router = Router();
const LIST_LIMIT = parseInt(process.env.ORDER_LIST_LIMIT || "2000", 10);
export const DATE_FIELDS = [{ code: "orderDate", label: "Order Date" }, { code: "requiredDeliveryDate", label: "Required Delivery" }, { code: "etd", label: "ETD" }, { code: "eta", label: "ETA" }];
function isOverdue(o) { if (!o.requiredDeliveryDate || o.status === "SHIPPED" || o.status === "CANCELLED") return false; const d = new Date(o.requiredDeliveryDate); const t = new Date(); t.setHours(0, 0, 0, 0); return !isNaN(d.getTime()) && d < t; }
function summarise(o) { return { id: o.id, reference: o.reference, orderNo: o.orderNo, orderNoSplit: o.orderNoSplit || "", orderDate: o.orderDate, transportMode: o.transportMode, supplierName: o.supplierName, supplierCode: o.supplierCode || "", buyerName: o.buyerName, buyerCode: o.buyerCode || "", originCode: o.originCode, destCode: o.destCode, loadPort: o.loadPort || "", dischargePort: o.dischargePort || "", containerMode: o.containerMode || "", clientCode: o.clientCode || "", bookingConfRef: o.bookingConfRef || "", incoTerms: o.incoTerms || "", requiredDeliveryDate: o.requiredDeliveryDate, serviceLevel: o.serviceLevel, weight: o.weight, volume: o.volume, quantity: o.quantity, goodsDescription: o.goodsDescription, status: o.status, cwShipmentNumber: o.cwShipmentNumber, etd: o.etd, eta: o.eta, bookingId: o.bookingId || "", bookingRef: o.bookingRef || "", cwOrgCode: o.cwOrgCode || "", overdue: isOverdue(o), updatedAt: o.updatedAt }; }
const withLink = (order, links) => { const link = links.get(order.id); return { ...order, bookingId: link?.bookingId || "", bookingRef: link?.bookingRef || "" }; };
async function orderLinks(req) { const user = req.user; if (!requestCan(req, "booking.view") || !hasBookingModule(req)) return new Map(); const links = await bookingDatabase().listOrderLinks(); return new Map(links.filter((link) => canSeeBooking(user, link.booking)).map((link) => [link.orderId, link])); }
const SEARCHABLE_ORDER_FIELDS = new Set(["reference", "orderNo", "orderDate", "transportMode", "supplierName", "supplierCode", "buyerName", "buyerCode", "originCode", "destCode", "loadPort", "dischargePort", "containerMode", "clientCode", "bookingConfRef", "incoTerms", "requiredDeliveryDate", "serviceLevel", "weight", "volume", "quantity", "goodsDescription", "cwShipmentNumber", "bookingRef", "status", "cwOrgCode", "overdue", "updatedAt"]);
function matchesSearchFilter(order, filter) {
  let actual = filter.field === "orderNo" ? `${order.orderNo || ""}${order.orderNoSplit ? `-${order.orderNoSplit}` : ""}` : filter.field === "overdue" ? isOverdue(order) : filter.field === "status" && isOverdue(order) ? "OVERDUE" : order[filter.field];
  if (actual == null || actual === "") return false;
  const expected = String(filter.value).trim();
  if (filter.type === "number") {
    const actualNumber = Number(actual); const expectedNumber = Number(expected);
    if (!Number.isFinite(actualNumber) || !Number.isFinite(expectedNumber)) return false;
    return { eq: actualNumber === expectedNumber, neq: actualNumber !== expectedNumber, gt: actualNumber > expectedNumber, gte: actualNumber >= expectedNumber, lt: actualNumber < expectedNumber, lte: actualNumber <= expectedNumber }[filter.operator] ?? false;
  }
  const actualText = String(actual);
  const left = (filter.type === "date" ? actualText.slice(0, 10) : actualText).toLowerCase();
  const right = (filter.type === "date" ? expected.slice(0, 10) : expected).toLowerCase();
  if (filter.operator === "contains") return left.includes(right);
  if (filter.operator === "neq") return left !== right;
  if (filter.operator === "gt") return left > right;
  if (filter.operator === "gte") return left >= right;
  if (filter.operator === "lt") return left < right;
  if (filter.operator === "lte") return left <= right;
  return left === right;
}
function docMeta(d) { return { id: d.id, fileName: d.fileName, size: d.size, uploadedBy: d.uploadedBy }; }
const codeOf = (v) => { const s = String(v ?? "").trim(); const m = /^([A-Za-z0-9/]+)\s*-\s*/.exec(s); return m ? m[1] : s; };
function normDate(v) { if (!v) return ""; const s = String(v).trim(); const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s); if (dmy) { const yr = dmy[3].length === 2 ? "20" + dmy[3] : dmy[3]; return `${yr}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`; } const d = new Date(s); return isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10); }
router.get("/kpis", requirePermission("order.view"), (req, res) => { const all = allOrders().filter((o) => canSeeOrder(req.user, o)); res.json({ total: all.length, pending: all.filter((o) => o.status === "PENDING").length, overdue: all.filter(isOverdue).length, shipped: all.filter((o) => o.status === "SHIPPED").length }); });
router.get("/meta/orgs", requirePermission("order.view"), (req, res) => { const supplierOrgs = toOptions(orderSupplierOrgsFor(req.user)); const buyerOrgs = toOptions(orderBuyerOrgsFor(req.user)); res.json({ hasAccess: userHasOrderAccess(req.user), supplierOrgs, buyerOrgs, dateFields: DATE_FIELDS, directory: scopedDirectory([...supplierOrgs, ...buyerOrgs]) }); });
router.get("/meta/bookings", requirePermission("order.view"), requirePermission("booking.view"), requireBookingModule, async (req, res) => { const items = (await bookingDatabase().list()).filter((b) => canSeeBooking(req.user, b)).map((b) => ({ id: b.id, reference: b.reference, mode: b.mode, shipper: b.shipper?.companyName, status: b.status })); res.json({ total: items.length, items }); });
router.get("/", requirePermission("order.view"), async (req, res) => {
  let searchFilters = [];
  if (req.query.filters) {
    try { searchFilters = JSON.parse(String(req.query.filters)); } catch { return res.status(400).json({ error: "Filter data must be valid JSON" }); }
    if (!Array.isArray(searchFilters) || searchFilters.length > 20 || searchFilters.some((filter) => {
      if (!filter || !SEARCHABLE_ORDER_FIELDS.has(filter.field) || filter.value == null || !["text", "number", "date", "boolean"].includes(filter.type)) return true;
      const allowed = filter.type === "number" || filter.type === "date" ? ["eq", "neq", "gt", "gte", "lt", "lte"] : filter.type === "boolean" ? ["eq", "neq"] : ["contains", "eq", "neq"];
      return !allowed.includes(filter.operator);
    })) return res.status(400).json({ error: "Provide up to 20 valid search filters" });
  }
  const links = await orderLinks(req);
  let items = allOrders().filter((o) => canSeeOrder(req.user, o)).map((o) => withLink(o, links));
  const { mode, orderNo, status, q, overdue } = req.query;
  const like = (v, s) => String(v || "").toLowerCase().includes(String(s).toLowerCase());
  if (mode) items = items.filter((o) => o.transportMode === mode);
  if (status) items = items.filter((o) => o.status === status);
  if (orderNo) items = items.filter((o) => like(o.orderNo, orderNo));
  if (overdue === "true") items = items.filter(isOverdue);
  if (q) { const s = String(q).toLowerCase(); items = items.filter((o) => [o.reference, o.orderNo, o.supplierName, o.buyerName, o.goodsDescription, o.cwShipmentNumber].filter(Boolean).some((v) => String(v).toLowerCase().includes(s))); }
  if (searchFilters.length) items = items.filter((order) => searchFilters.every((filter) => matchesSearchFilter(order, filter)));
  items.sort((a, b) => (a.updatedAt === b.updatedAt ? 0 : String(b.updatedAt) > String(a.updatedAt) ? 1 : -1));
  res.json({ total: items.length, limited: items.length > LIST_LIMIT, items: items.slice(0, LIST_LIMIT).map(summarise) });
});
router.get("/:id", requirePermission("order.view"), async (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "This order is outside your assigned CW organizations" }); res.json({ ...withLink(o, await orderLinks(req)), documents: (o.documents || []).map(docMeta), overdue: isOverdue(o) }); });
function applyPartners(o) { if (o.supplierCode) { const d = orgDetails(o.supplierCode); o.supplierName = orgLabel(o.supplierCode); o.supplier = { ...(o.supplier || {}), name: d.name, address: o.supplier?.address || [d.address1, d.address2, d.city, d.state, d.postCode, d.country].filter(Boolean).join(", ") }; } if (o.buyerCode) { const d = orgDetails(o.buyerCode); o.buyerName = orgLabel(o.buyerCode); o.delivery = { ...(o.delivery || {}), name: d.name, address: o.delivery?.address || [d.address1, d.address2, d.city, d.state, d.postCode, d.country].filter(Boolean).join(", ") }; } if (!o.cwOrgCode && o.supplierCode) o.cwOrgCode = o.supplierCode; }
router.post("/", requirePermission("order.create"), async (req, res) => {
  if (!userHasOrderAccess(req.user)) return res.status(403).json({ error: "You have no Order data scope configured." });
  const body = req.body || {}; const errors = validateOrder(body);
  if (errors.length) return res.status(400).json({ status: "INVALID", errors });
  const o = makeOrder({ ...body, bookingId: "", bookingRef: "", createdBy: req.user.name });
  applyPartners(o); if (!o.cwOrgCode) o.cwOrgCode = defaultOrderOrg(req.user);
  if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" });
  o.updatedBy = req.user.name; (o.orderLines || []).forEach((l) => { if (!l.id) l.id = uuid(); }); o.documents = o.documents || [];
  const identity = [o.orderNo, o.orderNoSplit].map((value) => String(value || "").trim().toUpperCase());
  await bookingDatabase().runExternalOperation({
    key: `order:create:${JSON.stringify(identity)}`, kind: "ORDER_CREATE", entityId: o.id, entityRef: o.reference, user: req.user,
    details: { orderNo: o.orderNo, orderNoSplit: o.orderNoSplit, supplierCode: o.supplierCode, buyerCode: o.buyerCode }
  }, async (operation) => {
    db.orders.push(o);
    await operation.complete({ user: req.user, action: "ORDER_CREATE", entityType: "Order", entityId: o.reference });
  });
  res.status(201).json(o);
});
router.put("/:id", requirePermission("order.create"), async (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" }); const links = await orderLinks(req); const updated = { ...o, ...req.body, id: o.id, reference: o.reference, bookingId: "", bookingRef: "", documents: o.documents, createdAt: o.createdAt, createdBy: o.createdBy, updatedBy: req.user.name, updatedAt: new Date().toISOString() }; applyPartners(updated); if (!canSeeOrder(req.user, updated)) return res.status(403).json({ error: "Outside your CW organizations" }); Object.assign(o, updated); (o.orderLines || []).forEach((l) => { if (!l.id) l.id = uuid(); }); res.json({ ...withLink(o, links), documents: (o.documents || []).map(docMeta) }); });
router.delete("/:id", requirePermission("order.delete"), async (req, res) => {
  if (isSqlOrder(findOrder(req.params.id))) return res.status(400).json({ error: "Orders sourced from the SQL database cannot be deleted in the portal" });
  const o = db.orders.find((item) => item.id === req.params.id);
  if (!o) return res.status(404).json({ error: "Order not found" });
  if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" });
  const response = await bookingDatabase().runExternalOperation({
    key: `order:delete:${o.id}`, kind: "ORDER_DELETE", entityId: o.id, entityRef: o.reference, user: req.user,
    details: { orderNo: o.orderNo, orderNoSplit: o.orderNoSplit, supplierCode: o.supplierCode, buyerCode: o.buyerCode }
  }, async (operation) => {
    if (!db.orders.some((item) => item.id === o.id)) { await operation.abort(); return { status: 404, body: { error: "Order not found" } }; }
    const result = await bookingDatabase().unlinkOrder(o.id, (b) => requestCan(req, "booking.view") && hasBookingModule(req) && canSeeBooking(req.user, b), undefined, { client: operation.client });
    if (result.status === "forbidden") { await operation.abort(); return { status: 403, body: { error: "Outside your booking organizations" } }; }
    const index = db.orders.findIndex((item) => item.id === o.id);
    if (index >= 0) db.orders.splice(index, 1);
    await operation.complete({ user: req.user, action: "ORDER_DELETE", entityType: "Order", entityId: o.reference });
    return { status: 200, body: { ok: true } };
  });
  res.status(response.status).json(response.body);
});
router.post("/:id/link-booking", requirePermission("order.create"), requirePermission("booking.view"), requireBookingModule, async (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" }); if (typeof req.body?.bookingId !== "string" || !req.body.bookingId) return res.status(400).json({ error: "Booking id is required" }); const result = await bookingDatabase().linkOrder(o.id, req.body.bookingId, (b) => canSeeBooking(req.user, b)); if (result.status === "not_found") return res.status(404).json({ error: "Booking not found" }); if (result.status === "forbidden") return res.status(403).json({ error: "Outside your booking organizations" }); if (result.status === "conflict") return res.status(409).json({ error: "Order is already linked to another booking. Unlink it before linking to another booking." }); res.json({ ok: true, bookingRef: result.bookingRef }); });
router.post("/:id/unlink-booking", requirePermission("order.create"), requirePermission("booking.view"), requireBookingModule, async (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" }); if (req.body?.bookingId !== undefined && (typeof req.body.bookingId !== "string" || !req.body.bookingId)) return res.status(400).json({ error: "Invalid booking id" }); const result = await bookingDatabase().unlinkOrder(o.id, (b) => canSeeBooking(req.user, b), req.body?.bookingId); if (result.status === "forbidden") return res.status(403).json({ error: "Outside your booking organizations" }); if (result.status === "conflict") return res.status(409).json({ error: "Order is linked to a different booking" }); res.json({ ok: true }); });
router.post("/:id/documents", requirePermission("order.create"), (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" }); if (!req.file) return res.status(400).json({ error: "No file provided" }); const doc = { id: uuid(), fileName: req.file.originalname || "document.bin", size: req.file.buffer.length, contentBase64: req.file.buffer.toString("base64"), uploadedBy: req.user.name }; o.documents = o.documents || []; o.documents.push(doc); res.status(201).json({ document: docMeta(doc) }); });
router.get("/:id/documents/:docId/download", requirePermission("order.view"), (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" }); const d = (o.documents || []).find((x) => x.id === req.params.docId); if (!d) return res.status(404).json({ error: "Document not found" }); res.setHeader("Content-Type", "application/octet-stream"); res.setHeader("Content-Disposition", `attachment; filename="${d.fileName}"`); res.send(Buffer.from(d.contentBase64, "base64")); });
router.delete("/:id/documents/:docId", requirePermission("order.create"), (req, res) => { const o = findOrder(req.params.id); if (!o) return res.status(404).json({ error: "Order not found" }); if (!canSeeOrder(req.user, o)) return res.status(403).json({ error: "Outside your CW organizations" }); o.documents = (o.documents || []).filter((x) => x.id !== req.params.docId); res.json({ ok: true, documents: o.documents.map(docMeta) }); });
const ORDER_COLUMNS = ["orderNo","orderNoSplit","orderDate","transportMode","supplierCode","buyerCode","originCode","destCode","requiredDeliveryDate","serviceLevel","status","weight","volume","quantity","goodsDescription","cwShipmentNumber","housebillNumber","etd","eta","lineNo","partNumber","partDescription","itemPrice","notes"];
function parseCSV(text) { const rows = []; let row = [], field = "", q = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; } else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else if (c !== "\r") field += c; } } if (field.length || row.length) { row.push(field); rows.push(row); } if (!rows.length) return []; const h = rows[0].map((x) => x.trim()); return rows.slice(1).filter((r) => r.some((c) => String(c).trim() !== "")).map((r) => Object.fromEntries(h.map((hh, i) => [hh, (r[i] ?? "").trim()]))); }
function rowToOrder(row) { const g = (k) => row[k] ?? ""; const sc = codeOf(g("supplierCode")); const bc = codeOf(g("buyerCode")); const o = { orderNo: g("orderNo"), orderNoSplit: g("orderNoSplit"), orderDate: normDate(g("orderDate")), transportMode: g("transportMode"), supplierCode: sc, buyerCode: bc, supplierName: orgLabel(sc), buyerName: orgLabel(bc), originCode: codeOf(g("originCode")), destCode: codeOf(g("destCode")), requiredDeliveryDate: normDate(g("requiredDeliveryDate")), serviceLevel: g("serviceLevel"), status: (g("status") || "PENDING").toUpperCase(), weight: g("weight"), volume: g("volume"), quantity: g("quantity"), goodsDescription: g("goodsDescription"), notes: g("notes"), cwShipmentNumber: g("cwShipmentNumber"), housebillNumber: g("housebillNumber"), etd: normDate(g("etd")), eta: normDate(g("eta")), orderLines: [] }; if (g("partNumber") || g("lineNo")) o.orderLines.push({ id: uuid(), lineNo: g("lineNo"), partNumber: g("partNumber"), partDescription: g("partDescription"), itemPrice: g("itemPrice") }); return o; }
router.post("/import", requirePermission("order.import"), (req, res) => { if (!userHasOrderAccess(req.user)) return res.status(403).json({ error: "You have no Order data scope configured." }); let raw = []; try { if (req.file) { if (/\.xlsx$/i.test(req.file.originalname || "")) { const wb = readXlsx(req.file.buffer); const sheet = wb.sheetNames.find((n) => /order/i.test(n)) || wb.sheetNames[0]; raw = sheetToObjects(wb.sheets[sheet] || []); } else raw = parseCSV(req.file.buffer.toString("utf8")); } else if (req.body?.csv) raw = parseCSV(req.body.csv); else return res.status(400).json({ error: "No file provided" }); } catch (e) { return res.status(400).json({ error: "Could not read: " + e.message }); } if (!raw.length) return res.status(400).json({ error: "No rows found" }); const defaultOrg = defaultOrderOrg(req.user); const batch = { id: uuid(), ownerId: req.user.id, fileName: req.file?.originalname || "orders.csv", total: raw.length, valid: 0, errorCount: 0, rows: [] }; raw.forEach((r, i) => { const data = rowToOrder(r); const errors = validateOrder(data); const status = errors.length ? "ERROR" : "VALID"; if (status === "VALID") batch.valid++; else batch.errorCount++; batch.rows.push({ rowNo: i + 1, data, errors, status, cwOrgCode: defaultOrg }); }); db.orderImports.push(batch); res.status(201).json(batch); });
router.patch("/import/:batchId/rows/:rowNo", requirePermission("order.import"), (req, res) => { const batch = db.orderImports.find((x) => x.id === req.params.batchId); if (!batch) return res.status(404).json({ error: "Import batch not found" }); if (batch.ownerId !== req.user.id) return res.status(403).json({ error: "This import batch belongs to another user" }); const row = batch.rows.find((x) => x.rowNo === Number(req.params.rowNo)); if (!row) return res.status(404).json({ error: "Row not found" }); if (row.status === "COMMITTED") return res.status(400).json({ error: "Row already committed" }); const updates = req.body?.data || {}; row.data = { ...row.data, ...updates, supplierCode: codeOf(updates.supplierCode ?? row.data.supplierCode), buyerCode: codeOf(updates.buyerCode ?? row.data.buyerCode) }; row.data.supplierName = orgLabel(row.data.supplierCode); row.data.buyerName = orgLabel(row.data.buyerCode); const wasError = row.status === "ERROR"; row.errors = validateOrder(row.data); row.status = row.errors.length ? "ERROR" : "VALID"; if (wasError && row.status === "VALID") { batch.valid++; batch.errorCount--; } else if (!wasError && row.status === "ERROR") { batch.valid--; batch.errorCount++; } res.json(batch); });
router.post("/import/:batchId/commit", requirePermission("order.create"), (req, res) => { const batch = db.orderImports.find((x) => x.id === req.params.batchId); if (!batch) return res.status(404).json({ error: "Import batch not found" }); if (batch.ownerId !== req.user.id) return res.status(403).json({ error: "This import batch belongs to another user" }); if (!userHasOrderAccess(req.user)) return res.status(403).json({ error: "You have no Order data scope configured." }); if (batch.rows.some((row) => row.status === "VALID" && !canSeeOrder(req.user, { ...row.data, cwOrgCode: row.data.supplierCode || row.cwOrgCode }))) return res.status(403).json({ error: "Outside your CW organizations" }); let committed = 0; batch.rows.filter((r) => r.status === "VALID").forEach((row) => { const o = makeOrder({ ...row.data, cwOrgCode: row.data.supplierCode || row.cwOrgCode, createdBy: req.user.name }); (o.orderLines||[]).forEach((l)=>{if(!l.id)l.id=uuid();}); db.orders.push(o); row.status = "COMMITTED"; committed++; }); res.json({ committed }); });
router.get("/template/download", requirePermission("order.import"), (req, res) => { const ex = { orderNo: "PO-2001", orderDate: "31/12/2026", transportMode: "Air", supplierCode: "INTCOMMIA", buyerCode: "BAHTELNAS", originCode: "USMIA", destCode: "BSNAS", requiredDeliveryDate: "10/01/2027", serviceLevel: "STD", status: "PENDING", weight: "284", volume: "1", quantity: "2", goodsDescription: "TELECOM EQUIPMENT", lineNo: "1", partNumber: "TEL-001", partDescription: "Router unit", itemPrice: "1200", notes: "Priority" }; const line = ORDER_COLUMNS.map((k) => { const v = String(ex[k] ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(","); res.setHeader("Content-Type", "text/csv"); res.setHeader("Content-Disposition", 'attachment; filename="SBMS_Order_Upload_Template.csv"'); res.send(ORDER_COLUMNS.join(",") + "\n" + line + "\n"); });
router.get("/layouts/list", requirePermission("order.view"), (req, res) => res.json({ layouts: db.layouts[req.user.email] || [] }));
router.post("/layouts", requirePermission("order.view"), (req, res) => { const key = req.user.email; const { name, columns } = req.body || {}; if (!name || !String(name).trim()) return res.status(400).json({ error: "Layout name is required" }); if (!Array.isArray(columns)) return res.status(400).json({ error: "columns must be an array" }); db.layouts[key] = db.layouts[key] || []; const ex = db.layouts[key].find((l) => l.name.toLowerCase() === String(name).trim().toLowerCase()); if (ex) ex.columns = columns; else db.layouts[key].push({ id: uuid(), name: String(name).trim(), columns, createdAt: new Date().toISOString() }); res.status(201).json({ layouts: db.layouts[key] }); });
router.delete("/layouts/:id", requirePermission("order.view"), (req, res) => { const key = req.user.email; db.layouts[key] = (db.layouts[key] || []).filter((l) => l.id !== req.params.id); res.json({ layouts: db.layouts[key] }); });
router.get("/filters/list", requirePermission("order.view"), (req, res) => res.json({ layouts: db.orderFilterLayouts[req.user.email] || [] }));
router.post("/filters", requirePermission("order.view"), (req, res) => {
  const key = req.user.email;
  const name = String(req.body?.name || "").trim();
  const filters = req.body?.filters;
  if (!name) return res.status(400).json({ error: "Filter layout name is required" });
  if (!Array.isArray(filters) || filters.length < 1 || filters.length > 20 || filters.some((filter) => !filter || typeof filter.field !== "string" || typeof filter.operator !== "string" || filter.value == null)) return res.status(400).json({ error: "Provide between 1 and 20 valid filters" });
  db.orderFilterLayouts[key] = db.orderFilterLayouts[key] || [];
  const existing = db.orderFilterLayouts[key].find((layout) => layout.name.toLowerCase() === name.toLowerCase());
  if (existing) existing.filters = filters;
  else db.orderFilterLayouts[key].push({ id: uuid(), name, filters, createdAt: new Date().toISOString() });
  res.status(201).json({ layouts: db.orderFilterLayouts[key] });
});
router.delete("/filters/:id", requirePermission("order.view"), (req, res) => {
  const key = req.user.email;
  db.orderFilterLayouts[key] = (db.orderFilterLayouts[key] || []).filter((layout) => layout.id !== req.params.id);
  res.json({ layouts: db.orderFilterLayouts[key] });
});
export default router;
