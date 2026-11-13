import { validatePasswordStrength } from "./passwordPolicy.js";
import { accessDatabaseOperation } from "./accessErrors.js";

function bearer(req) {
  const match = /^Bearer\s+([^\s]+)$/i.exec(req.header("authorization") || "");
  return match ? match[1] : "";
}

export function createPostgresAuthHandlers(authentication, settings) {
  return {
    async login(req, res) {
      res.setHeader("Cache-Control", "no-store");
      const { email, password } = req.body || {};
      if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password || password.length > 128) {
        return res.status(400).json({ error: "Email and password are required" });
      }
      const result = await accessDatabaseOperation(() => authentication.login(email, password));
      if (result.status === "locked") return res.status(429).json({ error: "Too many failed attempts. Try again later." });
      if (result.status === "invalid") return res.status(401).json({ error: "Invalid email or password" });
      if (result.status !== "ok") throw new Error("Unexpected authentication result");
      const { status, ...response } = result;
      return res.json(response);
    },

    async middleware(req, res, next) {
      res.setHeader("Cache-Control", "no-store");
      const token = bearer(req);
      if (!token) return res.status(401).json({ error: "Authentication required" });
      const access = await accessDatabaseOperation(() => authentication.authenticateAccess(token, settings, req.header("x-user-role")));
      if (!access) return res.status(401).json({ error: "Authentication required" });
      if (access.invalidRole) return res.status(403).json({ error: "Role preview is no longer available" });
      const { session, snapshot, previewRole } = access;
      req.realRole = snapshot.user.role;
      req.accessRole = snapshot.role;
      req.user = snapshot.user;
      req.authToken = token;
      req.mustChangePassword = session.mustChangePassword;
      if (previewRole) {
        req.user = { ...req.user, role: previewRole.name };
        req.accessRole = previewRole;
      }
      if (session.mustChangePassword && !(req.method === "GET" && req.path === "/api/v1/me") &&
          !(req.method === "POST" && req.path === "/api/v1/auth/change-password")) {
        return res.status(403).json({ error: "Password change required" });
      }
      return next();
    },

    async changePassword(req, res) {
      const { currentPassword, newPassword } = req.body || {};
      const error = validatePasswordStrength(newPassword);
      if (error) return res.status(400).json({ error });
      if (newPassword === currentPassword) return res.status(400).json({ error: "New password must differ from the current password" });
      const result = await authentication.changePassword(req.authToken, currentPassword, newPassword);
      if (result.status === "unauthorized") return res.status(401).json({ error: "Authentication required" });
      if (result.status === "incorrect") return res.status(400).json({ error: "Current password is incorrect" });
      if (result.status !== "ok") throw new Error("Unexpected password change result");
      return res.json({ ok: true, reauthenticate: true });
    }
  };
}
