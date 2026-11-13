import { Router } from "./http.js";
import { normalizeRuleConfiguration, normalizeVisibilityProfile } from "./accessConfigurationValidation.js";
import { RULE_FIELDS } from "../validation.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function requireUsers(req, res, next) {
  if (!req.accessRole.permissions.includes("admin.users")) return res.status(403).json({ error: "User management permission required" });
  return next();
}
async function write(services, req, res, operation, status = 200, assignment = false) {
  try {
    const result = await services.authentication.authorizedWrite(req.authToken, "admin.users", operation);
    if (result.status === "unauthorized") return res.status(401).json({ error: "Authentication required" });
    if (result.status === "forbidden") return res.status(403).json({ error: "User management permission required" });
    if (result.status !== "ok") throw new Error("Unexpected configuration result");
    if (!result.value) return res.status(404).json({ error: "Record not found" });
    return res.status(status).json(result.value === true ? { ok: true } : result.value);
  } catch (error) {
    if (error.code === "23503") return assignment
      ? res.status(400).json({ error: "Unknown rule configuration" })
      : res.status(409).json({ error: "Configuration is assigned or referenced; unassign it first" });
    if (error.code === "DEFAULT_RULE") return res.status(409).json({ error: error.message });
    throw error;
  }
}
export function createPostgresConfigurationRouter(services) {
  const router = Router();
  router.use((req, res, next) => {
    if (/^\/api\/v1\/(rule-fields|rule-configurations|field-visibility-profiles)(\/|$)/.test(req.path) ||
        /^\/api\/v1\/users\/[^/]+\/rule-configuration$/.test(req.path)) return requireUsers(req, res, next);
    return next();
  });
  router.get("/rule-fields", (req, res) => res.json(RULE_FIELDS));
  for (const [path, list, create, update, remove, normalize, key] of [
    ["rule-configurations", "listRules", "createRule", "updateRule", "deleteRule", normalizeRuleConfiguration, "configuration"],
    ["field-visibility-profiles", "listProfiles", "createProfile", "updateProfile", "deleteProfile", normalizeVisibilityProfile, "profile"]
  ]) {
    router.get(`/${path}`, async (req, res) => res.json({ items: await services.configurations[list]() }));
    router.post(`/${path}`, async (req, res) => {
      const validation = normalize(req.body);
      if (validation.error) return res.status(400).json({ error: validation.error });
      return write(services, req, res, (client) => services.configurations[create](validation[key], client), 201);
    });
    router.put(`/${path}/:id`, async (req, res) => {
      if (!uuid.test(req.params.id)) return res.status(400).json({ error: "Invalid configuration ID" });
      const validation = normalize(req.body);
      if (validation.error) return res.status(400).json({ error: validation.error });
      return write(services, req, res, (client) => services.configurations[update](req.params.id, req.body, client));
    });
    router.delete(`/${path}/:id`, async (req, res) => {
      if (!uuid.test(req.params.id)) return res.status(400).json({ error: "Invalid configuration ID" });
      return write(services, req, res, (client) => services.configurations[remove](req.params.id, client));
    });
  }
  router.post("/users/:id/rule-configuration", async (req, res) => {
    if (!uuid.test(req.params.id)) return res.status(400).json({ error: "Invalid user ID" });
    const id = req.body?.ruleConfigurationId;
    if (id !== null && (typeof id !== "string" || (id && !uuid.test(id)))) return res.status(400).json({ error: "Invalid rule configuration" });
    return write(services, req, res, async (client) => {
      const saved = await services.configurations.setAssignments(req.params.id, { ruleConfigurationId: id }, client);
      if (!saved) return null;
      return { ok: true, ruleConfigurationId: id || "" };
    }, 200, true);
  });
  return router;
}
