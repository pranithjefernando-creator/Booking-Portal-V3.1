import { Router } from "../lib/http.js";
import { changePassword, issueInitialPassword, removeCredentials, mustChangePassword } from "../auth.js";
import { db, newUser, canSeeBooking } from "../db.js";
import { requirePermission, permissionMatrix, PERMISSIONS, MODULES, MODULE_GROUPS, effectiveModules } from "../rbac.js";
import { reference, isKnownOrg, orgLabel } from "../reference.js";
import { cwPublicConfig } from "../lib/config.js";
import { RULE_FIELDS } from "../validation.js";
import { uuid } from "../db.js";
import { allOrders } from "../lib/orderDb.js";
import { trackingOrganizations, trackingPartyOptions, trackingRecords } from "../lib/trackingAccess.js";
const router = Router();
const filterOrgs = (arr) => (Array.isArray(arr) ? arr.filter((c) => isKnownOrg(c)) : []);
const filterMods = (arr) => (Array.isArray(arr) ? arr.filter((m) => MODULES[m]) : []);
function normalizeRuleConfiguration(input, existing = {}) {
  const name = String(input?.name || "").trim();
  if (!name) return { error: "Configuration name is required" };
  if (!Array.isArray(input?.rules)) return { error: "Rules must be an array" };
  const rules = [];
  for (const rule of input.rules) {
    const ruleName = String(rule?.name || "").trim();
    if (!ruleName) return { error: "Every rule needs a name" };
    if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) return { error: `Rule '${ruleName}' needs at least one condition` };
    const conditions = [];
    for (const condition of rule.conditions) {
      const field = RULE_FIELDS.find((item) => item.value === condition?.field);
      if (!field || !field.operators.includes(condition.operator)) return { error: `Invalid condition in rule '${ruleName}'` };
      if (condition.value === undefined || condition.value === null || String(condition.value).trim() === "") return { error: `Condition value is required in rule '${ruleName}'` };
      if (field.type === "number" && !Number.isFinite(Number(condition.value))) return { error: `Condition value must be numeric for ${field.label}` };
      conditions.push({ id: condition.id || uuid(), field: field.value, operator: condition.operator, value: field.type === "number" ? Number(condition.value) : condition.value });
    }
    rules.push({ id: rule.id || uuid(), name: ruleName, enabled: rule.enabled !== false, match: rule.match === "any" ? "any" : "all", conditions });
  }
  return { configuration: { id: existing.id || uuid(), name, enabled: input.enabled !== false, rules, updatedAt: new Date().toISOString(), createdAt: existing.createdAt || new Date().toISOString() } };
}
router.get("/dashboard/summary", requirePermission("dashboard.view"), (req, res) => { const all = db.bookings.filter((b) => canSeeBooking(req.user, b)); const count = (s) => all.filter((b) => b.status === s).length; const kpis = { total: all.length, draft: count("DRAFT"), validated: count("VALIDATED"), completed: count("COMPLETED"), cfsReceived: all.filter((b) => b.cfsReceived).length, orders: allOrders().length }; const months = []; const now = new Date(); for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); months.push({ label: d.toLocaleString("en", { month: "short" }), created: 0, completed: 0 }); } const seedTrend = [[55, 40], [62, 48], [58, 44], [74, 60], [80, 66], [68, 52]]; months.forEach((m, i) => { m.created = seedTrend[i][0]; m.completed = seedTrend[i][1]; }); const recent = [...all].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)).slice(0, 6).map((b) => ({ id: b.id, reference: b.reference, shipper: b.shipper?.companyName || "—", mode: b.mode || "—", route: `${b.originCode || "—"}→${b.destCode || "—"}`, status: b.status })); res.json({ kpis, months, recent }); });
router.get("/cw/config", requirePermission("dashboard.view"), (req, res) => res.json(cwPublicConfig()));
router.get("/audit-logs", requirePermission("audit.view"), (req, res) => res.json({ total: db.audit.length, items: db.audit.slice(0, 200) }));
router.get("/rbac/matrix", requirePermission("dashboard.view"), (req, res) => res.json({ roles: Object.keys(db.roles), matrix: permissionMatrix() }));
router.get("/rbac/catalog", requirePermission("dashboard.view"), (req, res) => res.json({ permissions: PERMISSIONS, modules: MODULES, moduleGroups: MODULE_GROUPS }));
router.get("/users", requirePermission("admin.users"), (req, res) => res.json({ total: db.users.length, items: db.users }));
router.get("/rule-fields", requirePermission("admin.users"), (req, res) => res.json(RULE_FIELDS));
router.get("/rule-configurations", requirePermission("admin.users"), (req, res) => res.json({ items: db.ruleConfigurations }));
router.post("/rule-configurations", requirePermission("admin.users"), (req, res) => { const result = normalizeRuleConfiguration(req.body); if (result.error) return res.status(400).json({ error: result.error }); db.ruleConfigurations.push(result.configuration); res.status(201).json(result.configuration); });
router.put("/rule-configurations/:id", requirePermission("admin.users"), (req, res) => { const existing = db.ruleConfigurations.find((item) => item.id === req.params.id); if (!existing) return res.status(404).json({ error: "Rule configuration not found" }); const result = normalizeRuleConfiguration(req.body, existing); if (result.error) return res.status(400).json({ error: result.error }); Object.assign(existing, result.configuration); res.json(existing); });
router.delete("/rule-configurations/:id", requirePermission("admin.users"), (req, res) => { const configuration = db.ruleConfigurations.find((item) => item.id === req.params.id); if (!configuration) return res.status(404).json({ error: "Rule configuration not found" }); if (db.users.some((user) => user.ruleConfigurationId === configuration.id)) return res.status(409).json({ error: "Unassign this configuration from users before deleting it" }); db.ruleConfigurations = db.ruleConfigurations.filter((item) => item.id !== configuration.id); res.json({ ok: true }); });
router.get("/users/:id", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); res.json({ user: u, roleModules: (db.roles[u.role] || { modules: [] }).modules }); });
router.post("/users", requirePermission("admin.users"), (req, res) => { const { name, email, role, branchCode, ruleConfigurationId } = req.body || {}; if (!name || !String(name).trim()) return res.status(400).json({ error: "Full name is required" }); if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ error: "A valid email is required" }); if (db.users.some((u) => u.email.toLowerCase() === String(email).toLowerCase())) return res.status(409).json({ error: "A user with that email already exists" }); if (role && !db.roles[role]) return res.status(400).json({ error: "Unknown role" }); if (ruleConfigurationId && !db.ruleConfigurations.some((item) => item.id === ruleConfigurationId)) return res.status(400).json({ error: "Unknown rule configuration" }); const selectedConfiguration = Object.hasOwn(req.body || {}, "ruleConfigurationId") ? ruleConfigurationId || "" : db.ruleConfigurations[0]?.id || ""; const user = newUser({ name: String(name).trim(), email: String(email).trim(), role: role || "Data Entry", branchCode: branchCode || "CMB", ruleConfigurationId: selectedConfiguration }); db.users.push(user); const initialPassword = issueInitialPassword(user.id); res.status(201).json({ ...user, initialPassword }); });
router.post("/users/:id/rule-configuration", requirePermission("admin.users"), (req, res) => { const user = db.users.find((item) => item.id === req.params.id); if (!user) return res.status(404).json({ error: "User not found" }); const configurationId = req.body?.ruleConfigurationId || ""; if (configurationId && !db.ruleConfigurations.some((item) => item.id === configurationId)) return res.status(400).json({ error: "Unknown rule configuration" }); user.ruleConfigurationId = configurationId; res.json(user); });
router.put("/users/:id", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); const { name, role, branchCode } = req.body || {}; if (name !== undefined) u.name = String(name).trim() || u.name; if (role !== undefined) { if (!db.roles[role]) return res.status(400).json({ error: "Unknown role" }); u.role = role; } if (branchCode !== undefined) u.branchCode = branchCode; res.json(u); });
router.delete("/users/:id", requirePermission("admin.users"), (req, res) => { const idx = db.users.findIndex((x) => x.id === req.params.id); if (idx < 0) return res.status(404).json({ error: "User not found" }); if (db.users[idx].role === "Admin" && db.users.filter((u) => u.role === "Admin").length === 1) return res.status(409).json({ error: "Cannot delete the last Admin" }); removeCredentials(db.users[idx].id); db.users.splice(idx, 1); res.json({ ok: true }); });
router.post("/users/:id/modules", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); u.modules = filterMods(req.body?.modules); u.modulesConfigured = true; res.json(u); });
router.post("/users/:id/tracking-scope", requirePermission("admin.users"), async (req, res) => {
  const user = db.users.find((item) => item.id === req.params.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  const parties = trackingPartyOptions(await trackingRecords());
  const requested = req.body?.trackingOrgs;
  if (!Array.isArray(requested) || requested.some((code) => !parties.has(code) && !isKnownOrg(code))) return res.status(400).json({ error: "Provide valid tracking organizations" });
  user.trackingOrgs = [...new Set(requested)];
  res.json(user);
});
router.post("/users/:id/booking-scope", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); u.bookingOrgs = filterOrgs(req.body?.bookingOrgs); const a = new Set(u.bookingOrgs); u.bookingShipperOrgs = (u.bookingShipperOrgs || []).filter((c) => a.has(c)); u.bookingConsigneeOrgs = (u.bookingConsigneeOrgs || []).filter((c) => a.has(c)); res.json(u); });
router.post("/users/:id/booking-partners", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); const allow = new Set(u.bookingOrgs || []); const within = (arr) => filterOrgs(arr).filter((c) => allow.size === 0 || allow.has(c)); u.bookingShipperOrgs = within(req.body?.shipperOrgs); u.bookingConsigneeOrgs = within(req.body?.consigneeOrgs); res.json(u); });
router.post("/users/:id/order-scope", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); u.orderOrgs = filterOrgs(req.body?.orderOrgs); const a = new Set(u.orderOrgs); u.orderSupplierOrgs = (u.orderSupplierOrgs || []).filter((c) => a.has(c)); u.orderBuyerOrgs = (u.orderBuyerOrgs || []).filter((c) => a.has(c)); res.json(u); });
router.post("/users/:id/order-partners", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); const allow = new Set(u.orderOrgs || []); const within = (arr) => filterOrgs(arr).filter((c) => allow.size === 0 || allow.has(c)); u.orderSupplierOrgs = within(req.body?.supplierOrgs); u.orderBuyerOrgs = within(req.body?.buyerOrgs); res.json(u); });
router.get("/reference", (req, res) => { const { cwOrg, ...rest } = reference; res.json(rest); });
// Organisation master is far too large to ship whole; clients search it and resolve labels for selected codes.
const ORG_LIMIT_MAX = 50;
router.get("/orgs/search", requirePermission("admin.users"), async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), ORG_LIMIT_MAX);
  const parties = req.query.kind === "tracking" ? trackingPartyOptions(await trackingRecords()) : new Map();
  const items = []; let hasMore = false;
  const consider = (org, strict) => {
    if (items.length > limit) return;
    const code = org.code.toLowerCase(); const label = org.label.toLowerCase();
    const hit = !q || (strict ? code.startsWith(q) || label.startsWith(q) || label.includes(` - ${q}`) : code.includes(q) || label.includes(q));
    if (hit && !items.some((item) => item.code === org.code)) items.push(org);
  };
  const pools = () => [...parties.values(), ...reference.cwOrg.filter((org) => !parties.has(org.code))];
  // Prefix matches rank ahead of substring matches; stop scanning once the page is full.
  if (q) { for (const org of pools()) { consider(org, true); if (items.length > limit) break; } }
  for (const org of pools()) { if (items.length > limit) break; consider(org, false); }
  if (items.length > limit) { hasMore = true; items.length = limit; }
  res.json({ items, hasMore });
});
router.post("/orgs/lookup", requirePermission("admin.users"), async (req, res) => {
  const codes = Array.isArray(req.body?.codes) ? [...new Set(req.body.codes.map(String))].slice(0, 500) : [];
  const parties = codes.some((code) => code.startsWith("tracking:")) ? trackingPartyOptions(await trackingRecords()) : new Map();
  res.json({ items: codes.map((code) => parties.get(code) || { code, label: orgLabel(code) }) });
});
router.get("/reference/:type", (req, res) => { const list = reference[req.params.type]; if (!list) return res.status(404).json({ error: "Unknown reference type" }); res.json(req.params.type === "cwOrg" ? list.slice(0, 200) : list); });
router.post("/auth/change-password", changePassword);
router.post("/users/:id/reset-password", requirePermission("admin.users"), (req, res) => { const u = db.users.find((x) => x.id === req.params.id); if (!u) return res.status(404).json({ error: "User not found" }); res.json({ initialPassword: issueInitialPassword(u.id) }); });
router.get("/me", (req, res) => { const def = db.roles[req.user.role] || { permissions: [], modules: [] }; res.json({ user: req.user, realRole: req.realRole, mustChangePassword: mustChangePassword(req.user.id), permissions: def.permissions, modules: effectiveModules(req.user), availableRoles: Object.keys(db.roles), availableUsers: db.users.map((u) => ({ id: u.id, name: u.name, email: u.email, role: u.role })) }); });
router.get("/notifications/summary", (req, res) => {
  const user = req.user; const def = db.roles[user.role] || { permissions: [] }; const can = (p) => def.permissions.includes(p);
  const visible = db.bookings.filter((b) => canSeeBooking(user, b));
  const items = [];
  if (can("booking.approve")) { const count = db.approvals.filter((a) => a.status === "PENDING").length; if (count) items.push({ key: "approvals", label: "Awaiting your approval", count, link: "/approvals" }); }
  const rejectedIds = new Set(db.approvals.filter((a) => a.status === "REJECTED").map((a) => a.bookingId));
  if (can("booking.edit")) { const count = visible.filter((b) => b.status === "DRAFT" && rejectedIds.has(b.id) && b.createdBy === user.name).length; if (count) items.push({ key: "rejected", label: "Rejected — needs rework", count, link: "/bookings?status=DRAFT" }); }
  if (can("booking.validate")) { const count = visible.filter((b) => b.status === "DRAFT" && !rejectedIds.has(b.id)).length; if (count) items.push({ key: "validation", label: "Ready for validation", count, link: "/bookings?status=DRAFT" }); }
  res.json({ total: items.reduce((s, i) => s + i.count, 0), items });
});
export default router;
