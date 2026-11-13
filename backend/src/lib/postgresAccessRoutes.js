import { Router } from "./http.js";
import { MODULES, MODULE_GROUPS, PERMISSIONS } from "../rbac.js";
import { isKnownOrg, orgLabel, reference } from "../reference.js";
import { trackingPartyOptions, trackingRecords } from "./trackingAccess.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const scopes = {
  "booking-scope": { bookingOrgs: "bookingOrgs" },
  "booking-partners": { shipperOrgs: "bookingShipperOrgs", consigneeOrgs: "bookingConsigneeOrgs" },
  "order-scope": { orderOrgs: "orderOrgs" },
  "order-partners": { supplierOrgs: "orderSupplierOrgs", buyerOrgs: "orderBuyerOrgs" },
  "tracking-scope": { trackingOrgs: "trackingOrgs" }
};

function permitted(code) {
  return (req, res, next) => req.accessRole.permissions.includes(code) ? next() : res.status(403).json({ error: `Permission required: ${code}` });
}
function values(value, catalog) {
  return Array.isArray(value) && value.every((code) => typeof code === "string" && code !== "" && code === code.trim() && (!catalog || Object.hasOwn(catalog, code))) && new Set(value).size === value.length;
}
function roleError(role) {
  if (!role || typeof role !== "object" || Array.isArray(role) || Object.keys(role).some((key) => !["name", "description", "permissions", "modules"].includes(key))) return "Invalid role fields";
  if (typeof role.name !== "string" || !role.name.trim() || role.name !== role.name.trim()) return "Role name must be nonempty and trimmed";
  if (typeof role.description !== "string") return "Role description must be a string";
  if (!values(role.permissions, PERMISSIONS)) return "Invalid permissions";
  if (!values(role.modules, MODULES)) return "Invalid modules";
  return null;
}
async function write(req, res, services, permission, operation, status = 200) {
  try {
    const result = await services.authentication.authorizedWrite(req.authToken, permission, operation);
    if (result.status === "unauthorized") return res.status(401).json({ error: "Authentication required" });
    if (result.status === "forbidden") return res.status(403).json({ error: `Permission required: ${permission}` });
    if (result.status !== "ok") throw new Error("Unexpected access management result");
    if (result.value === null || result.value === false) return res.status(404).json({ error: "Record not found" });
    return res.status(status).json(result.value === true ? { ok: true } : result.value.user || result.value);
  } catch (error) {
    if (error.code === "INVALID_SCOPE") return res.status(400).json({ error: error.message });
    if (error.code === "23505") return res.status(409).json({ error: "Role already exists" });
    if (error.code === "23503") return res.status(409).json({ error: "Role is assigned or contains an unknown grant" });
    throw error;
  }
}

export function createPostgresAccessRouter(services) {
  const router = Router();
  router.get("/rbac/catalog", (req, res) => {
    if (!req.accessRole.permissions.some((code) => code === "admin.users" || code === "admin.roles")) return res.status(403).json({ error: "Access management permission required" });
    return res.json({ permissions: PERMISSIONS, modules: MODULES, moduleGroups: MODULE_GROUPS });
  });
  router.get("/roles", permitted("admin.roles"), async (req, res) => res.json({ items: await services.settings.listRoles() }));
  router.get("/rbac/matrix", permitted("admin.roles"), async (req, res) => {
    const roles = await services.settings.listRoles();
    return res.json({ roles: roles.map((role) => role.name), matrix: Object.entries(PERMISSIONS).map(([code, label]) => ({ code, label, grants: Object.fromEntries(roles.map((role) => [role.name, role.permissions.includes(code)])) })) });
  });
  router.post("/roles", permitted("admin.roles"), async (req, res) => {
    const error = roleError(req.body);
    if (error) return res.status(400).json({ error });
    if (req.body.name === "Admin") return res.status(409).json({ error: "The Admin role is reserved" });
    return write(req, res, services, "admin.roles", (client) => services.settings.createRole(req.body, client), 201);
  });
  router.put("/roles/:name", permitted("admin.roles"), async (req, res) => {
    const error = roleError(req.body);
    if (error) return res.status(400).json({ error });
    if (req.body.name !== req.params.name) return res.status(400).json({ error: "Role name cannot be changed" });
    if (req.params.name === "Admin") return res.status(409).json({ error: "The Admin role cannot be changed" });
    return write(req, res, services, "admin.roles", (client) => services.settings.updateRole(req.body, client));
  });
  router.delete("/roles/:name", permitted("admin.roles"), async (req, res) => {
    if (req.params.name === "Admin") return res.status(409).json({ error: "The Admin role cannot be deleted" });
    return write(req, res, services, "admin.roles", (client) => services.settings.deleteRole(req.params.name, client));
  });
  router.post("/users/:id/modules", permitted("admin.users"), async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(400).json({ error: "Invalid user ID" });
    const modules = req.body?.modules;
    if (modules !== null && !values(modules, MODULES)) return res.status(400).json({ error: "Invalid modules" });
    return write(req, res, services, "admin.users", (client) => services.settings.setModules(req.params.id, modules, client));
  });
  for (const [path, mapping] of Object.entries(scopes)) {
    router.post(`/users/:id/${path}`, permitted("admin.users"), async (req, res) => {
      if (!uuid.test(req.params.id)) return res.status(400).json({ error: "Invalid user ID" });
      const changes = {};
      const parties = path === "tracking-scope" ? trackingPartyOptions(await trackingRecords()) : null;
      for (const [key, field] of Object.entries(mapping)) {
        const codes = req.body?.[key];
        if (!values(codes) || codes.some((code) => !isKnownOrg(code) && !(parties && parties.has(code)))) return res.status(400).json({ error: `Invalid ${key} organizations` });
        changes[field] = codes;
      }
      return write(req, res, services, "admin.users", (client) => services.settings.setScopes(req.params.id, changes, client));
    });
  }
  router.get("/orgs/search", permitted("admin.users"), async (req, res) => {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 50);
    const parties = req.query.kind === "tracking" ? trackingPartyOptions(await trackingRecords()) : new Map();
    const organizations = [...parties.values(), ...reference.cwOrg.filter((org) => !parties.has(org.code))];
    const hits = organizations.filter((org) => org.code.toLowerCase().includes(q) || org.label.toLowerCase().includes(q));
    hits.sort((a, b) => Number(!(a.code.toLowerCase().startsWith(q) || a.label.toLowerCase().startsWith(q))) - Number(!(b.code.toLowerCase().startsWith(q) || b.label.toLowerCase().startsWith(q))));
    return res.json({ items: hits.slice(0, limit), hasMore: hits.length > limit });
  });
  router.post("/orgs/lookup", permitted("admin.users"), async (req, res) => {
    if (!values(req.body?.codes) || req.body.codes.length > 500) return res.status(400).json({ error: "Provide up to 500 organization codes" });
    const parties = req.body.codes.some((code) => code.startsWith("tracking:")) ? trackingPartyOptions(await trackingRecords()) : new Map();
    return res.json({ items: req.body.codes.map((code) => parties.get(code) || { code, label: orgLabel(code) }) });
  });
  return router;
}
