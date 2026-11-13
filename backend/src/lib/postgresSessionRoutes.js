import { Router } from "./http.js";
import { effectiveModules, hasBookingModule } from "../rbac.js";
import { createPostgresUserRouter } from "./postgresUserRoutes.js";
import { createPostgresAccessRouter } from "./postgresAccessRoutes.js";
import { createPostgresConfigurationRouter } from "./postgresConfigurationRoutes.js";
import { accessDatabaseOperation } from "./accessErrors.js";

export function createPostgresSessionRouter(services) {
  const router = Router();
  router.use(services.authHandlers.middleware);
  router.use((req, res, next) => {
    req.evaluateBookingApproval = (booking) => accessDatabaseOperation(() => services.configurations.evaluateBookingApproval(booking));
    return next();
  });
  router.use((req, res, next) => {
    if ((req.method === "GET" && req.path === "/api/v1/me") ||
        (req.method === "POST" && req.path === "/api/v1/auth/change-password")) return next();
    if ((req.path === "/api/v1/users" && ["GET", "POST"].includes(req.method)) ||
        (/^\/api\/v1\/users\/[^/]+$/.test(req.path) && ["GET", "PUT", "DELETE"].includes(req.method)) ||
        (/^\/api\/v1\/users\/[^/]+\/reset-password$/.test(req.path) && req.method === "POST")) return next();
    if ((req.method === "GET" && ["/api/v1/rbac/catalog", "/api/v1/rbac/matrix", "/api/v1/roles", "/api/v1/orgs/search"].includes(req.path)) ||
        (req.method === "POST" && ["/api/v1/roles", "/api/v1/orgs/lookup"].includes(req.path)) ||
        (["PUT", "DELETE"].includes(req.method) && /^\/api\/v1\/roles\/[^/]+$/.test(req.path)) ||
        (req.method === "POST" && /^\/api\/v1\/users\/[^/]+\/(modules|booking-scope|booking-partners|order-scope|order-partners|tracking-scope)$/.test(req.path))) return next();
    if ((req.method === "GET" && req.path === "/api/v1/rule-fields") ||
        (["GET", "POST"].includes(req.method) && /^\/api\/v1\/(rule-configurations|field-visibility-profiles)$/.test(req.path)) ||
        (["PUT", "DELETE"].includes(req.method) && /^\/api\/v1\/(rule-configurations|field-visibility-profiles)\/[^/]+$/.test(req.path)) ||
        (req.method === "POST" && /^\/api\/v1\/users\/[^/]+\/rule-configuration$/.test(req.path))) return next();
    const modules = effectiveModules(req.user, req.accessRole);
    const workflow = (prefix) => req.path === `/api/v1/${prefix}` || req.path.startsWith(`/api/v1/${prefix}/`);
    if (workflow("bookings")) {
      const needsCreate = (req.path === "/api/v1/bookings" && req.method === "POST") || workflow("bookings/templates");
      if (needsCreate ? !modules.includes("create") : !hasBookingModule(req)) return res.status(403).json({ error: "Booking module access is not enabled" });
      return next();
    }
    if (workflow("orders") || workflow("imports") || workflow("approvals")) {
      const module = workflow("orders") ? "orders" : workflow("imports") ? "import" : "approvals";
      if (!modules.includes(module)) return res.status(403).json({ error: `${module} module access is not enabled` });
      return next();
    }
    if (workflow("tracking") || workflow("port-congestion")) return next();
    if (req.method === "GET" && (workflow("reference") || ["/api/v1/notifications/summary", "/api/v1/cw/config"].includes(req.path))) return next();
    if (req.method === "GET" && workflow("dashboard") && modules.includes("dashboard")) return next();
    if (req.method === "GET" && req.path === "/api/v1/audit-logs" && modules.includes("audit")) return next();
    return res.status(503).json({ error: "This feature is temporarily unavailable while access settings are being integrated." });
  });
  router.get("/me", async (req, res) => {
    const [configuration, roles, users] = await accessDatabaseOperation(() => Promise.all([
      services.configurations.getUserConfiguration(req.user.id),
      services.settings.listRoles(),
      services.users.list()
    ]));
    if (!configuration) return res.status(401).json({ error: "Authentication required" });
    return res.json({
      fieldVisibility: configuration.fieldVisibility,
      user: { ...req.user, ...configuration.assignments },
      realRole: req.realRole,
      mustChangePassword: req.mustChangePassword,
      permissions: req.accessRole.permissions,
      modules: effectiveModules(req.user, req.accessRole),
      availableRoles: roles.map((role) => role.name),
      availableUsers: users.map(({ id, name, email, role }) => ({ id, name, email, role }))
    });
  });
  router.post("/auth/change-password", services.authHandlers.changePassword);
  router.use("/users", createPostgresUserRouter(services));
  router.use("/", createPostgresAccessRouter(services));
  router.use("/", createPostgresConfigurationRouter(services));
  return router;
}
