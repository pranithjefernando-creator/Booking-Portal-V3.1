import { Router } from "./http.js";
import { DEFAULT_APPROVAL_ID } from "./accessConfigurationStore.js";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const assignmentFields = ["ruleConfigurationId", "bookingVisibilityProfileId", "orderVisibilityProfileId"];
const recordFields = ["name", "email", "role", "branchCode"];

function requireUserManagement(req, res, next) {
  if (!req.accessRole.permissions.includes("admin.users")) return res.status(403).json({ error: "User management permission required" });
  return next();
}

function validId(req, res, next) {
  if (!uuidPattern.test(req.params.id)) return res.status(400).json({ error: "Invalid user ID" });
  return next();
}

function validateInput(input, creating) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "User fields must be an object";
  for (const [key, value] of Object.entries(input)) {
    if (recordFields.includes(key)) {
      if (typeof value !== "string" || (key !== "branchCode" && !value.trim())) return `Invalid ${key}`;
      if (key === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) return "A valid email is required";
    } else if (assignmentFields.includes(key)) {
      if (value !== null && (typeof value !== "string" || (value !== "" && !uuidPattern.test(value)))) return `Invalid ${key}`;
    } else return `Unsupported user field: ${key}`;
  }
  if (creating && (typeof input.name !== "string" || !input.name.trim())) return "Full name is required";
  if (creating && (typeof input.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim()))) return "A valid email is required";
  if (!creating && !Object.keys(input).length) return "User fields are required";
  return null;
}

function writeErrors(handler) {
  return async (req, res) => {
    try {
      return await handler(req, res);
    } catch (error) {
      if (error.code === "LAST_ADMIN") return res.status(409).json({ error: "Cannot remove or demote the last Admin" });
      if (error.code === "23505" && error.constraint === "users_email_unique_idx") return res.status(409).json({ error: "A user with that email already exists" });
      if (error.code === "23503") return res.status(400).json({ error: "Unknown role or configuration assignment" });
      throw error;
    }
  };
}

function resultError(result, res) {
  if (result.status === "unauthorized") { res.status(401).json({ error: "Authentication required" }); return true; }
  if (result.status === "forbidden") { res.status(403).json({ error: "User management permission required" }); return true; }
  if (result.status === "not_found") { res.status(404).json({ error: "User not found" }); return true; }
  if (result.status !== "ok") throw new Error("Unexpected user management result");
  return false;
}

async function userDetails(services, id) {
  const access = await services.settings.getAccess(id);
  if (!access) return null;
  const configuration = await services.configurations.getUserConfiguration(id);
  if (!configuration) return null;
  return { user: { ...access.user, ...configuration.assignments }, roleModules: access.role.modules };
}

export function createPostgresUserRouter(services) {
  const router = Router();
  router.use(requireUserManagement);
  router.get("/", async (req, res) => {
    const records = await services.users.list();
    const details = await Promise.all(records.map((user) => userDetails(services, user.id)));
    if (details.some((item) => !item)) throw new Error("User records changed while loading user list; retry the request");
    return res.json({ total: details.length, items: details.map((item) => item.user) });
  });
  router.get("/:id", validId, async (req, res) => {
    const details = await userDetails(services, req.params.id);
    if (!details) return res.status(404).json({ error: "User not found" });
    return res.json(details);
  });
  router.post("/", writeErrors(async (req, res) => {
    const error = validateInput(req.body, true);
    if (error) return res.status(400).json({ error });
    const result = await services.authentication.createUser(req.authToken, req.body);
    if (resultError(result, res)) return;
    const assignments = Object.fromEntries(assignmentFields.map((key) => [key, key === "ruleConfigurationId" && !Object.hasOwn(req.body, key) ? DEFAULT_APPROVAL_ID : req.body[key] || ""]));
    return res.status(201).json({ ...result.user, ...assignments, initialPassword: result.temporaryPassword });
  }));
  router.put("/:id", validId, writeErrors(async (req, res) => {
    const error = validateInput(req.body, false);
    if (error) return res.status(400).json({ error });
    const result = await services.authentication.updateUser(req.authToken, req.params.id, req.body);
    if (resultError(result, res)) return;
    return res.json(result.user);
  }));
  router.delete("/:id", validId, writeErrors(async (req, res) => {
    const result = await services.authentication.deleteUser(req.authToken, req.params.id);
    if (resultError(result, res)) return;
    return res.json({ ok: true });
  }));
  router.post("/:id/reset-password", validId, writeErrors(async (req, res) => {
    const result = await services.authentication.resetPassword(req.authToken, req.params.id);
    if (resultError(result, res)) return;
    return res.json({ initialPassword: result.temporaryPassword });
  }));
  return router;
}
