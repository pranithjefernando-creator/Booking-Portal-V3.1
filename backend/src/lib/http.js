import http from "http";
import { randomUUID } from "crypto";
import { URL } from "url";
function compile(path) { const keys = []; const pattern = path.replace(/\/+$/, "").replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }); return { re: new RegExp("^" + (pattern || "") + "/?$"), keys }; }
export function Router() {
  const routes = [], mounts = [];
  const add = (method) => (path, ...handlers) => { routes.push({ method, path, ...compile(path), handlers }); };
  const router = { routes, mounts, get: add("GET"), post: add("POST"), put: add("PUT"), delete: add("DELETE"), patch: add("PATCH"), use(path, sub) { if (typeof path === "function") mounts.push({ prefix: "", mw: path }); else if (sub && sub.__isRouter) mounts.push({ prefix: path.replace(/\/+$/, ""), sub }); else if (typeof sub === "function") mounts.push({ prefix: path.replace(/\/+$/, ""), mw: sub }); }, __isRouter: true };
  return router;
}
async function runMiddlewares(mws, req, res) { for (const mw of mws) { await new Promise((resolve, reject) => { let settled = false; const finish = (err) => { if (settled) return; settled = true; err ? reject(err) : resolve(); }; try { const ret = mw(req, res, (err) => finish(err)); if (ret && typeof ret.then === "function") ret.then(() => finish(), finish); else if (!settled) setImmediate(() => finish()); } catch (e) { finish(e); } }); if (res.writableEnded) return false; } return true; }
async function dispatch(router, req, res, basePath) {
  for (const m of router.mounts) { if (m.mw && (m.prefix === "" || basePath.startsWith(m.prefix) || req.path.startsWith(m.prefix))) { const ok = await runMiddlewares([m.mw], req, res); if (res.writableEnded) return true; if (!ok) return true; } }
  const rel = req.path.startsWith(basePath) ? req.path.slice(basePath.length) || "/" : req.path;
  for (const r of router.routes) { if (r.method !== req.method) continue; const match = r.re.exec(rel); if (!match) continue; req.params = {}; r.keys.forEach((k, i) => (req.params[k] = decodeURIComponent(match[i + 1]))); const ok = await runMiddlewares(r.handlers, req, res); if (!res.writableEnded && ok) res.status(204).end(); return true; }
  for (const m of router.mounts) { if (m.sub) { const mountPath = basePath + m.prefix; if (req.path === mountPath || req.path.startsWith(mountPath + "/") || m.prefix === "") { const handled = await dispatch(m.sub, req, res, mountPath); if (handled) return true; } } }
  return false;
}
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType); if (!m) return { fields: {}, file: null };
  const boundary = "--" + (m[1] || m[2]); const parts = []; let start = buffer.indexOf(boundary);
  while (start !== -1) { const next = buffer.indexOf(boundary, start + boundary.length); if (next === -1) break; parts.push(buffer.slice(start + boundary.length, next)); start = next; }
  const fields = {}; let file = null;
  for (let part of parts) { if (part[0] === 0x0d && part[1] === 0x0a) part = part.slice(2); const headerEnd = part.indexOf("\r\n\r\n"); if (headerEnd === -1) continue; const header = part.slice(0, headerEnd).toString("utf8"); let content = part.slice(headerEnd + 4); if (content.length >= 2 && content[content.length - 2] === 0x0d) content = content.slice(0, content.length - 2); const nameM = /name="([^"]+)"/.exec(header); const fileM = /filename="([^"]*)"/.exec(header); if (!nameM) continue; if (fileM && fileM[1]) file = { fieldname: nameM[1], originalname: fileM[1], buffer: content }; else fields[nameM[1]] = content.toString("utf8"); }
  return { fields, file };
}
function readBody(req, maxBytes) { return new Promise((resolve, reject) => { const chunks = []; let size = 0; let limited = false; req.on("data", (c) => { if (limited) return; size += c.length; if (size > maxBytes) { limited = true; req.destroy(); const error = new Error("Request body exceeds configured limit"); error.code = "LIMIT_BODY"; reject(error); return; } chunks.push(c); }); req.on("end", () => { if (!limited) resolve(Buffer.concat(chunks)); }); req.on("error", (error) => { if (!limited) reject(error); }); }); }
export function createApp() {
  const root = Router();
  const app = { use: (...a) => root.use(...a), get: (...a) => root.get(...a), post: (...a) => root.post(...a), put: (...a) => root.put(...a), delete: (...a) => root.delete(...a),
    listen(port, cb) {
      const server = http.createServer(async (nreq, nres) => {
        const url = new URL(nreq.url, "http://localhost"); const req = nreq;
        req.id = nreq.headers["x-request-id"] || randomUUID(); req.path = url.pathname.replace(/\/+$/, "") || "/"; req.query = Object.fromEntries(url.searchParams.entries()); req.header = (name) => nreq.headers[String(name).toLowerCase()]; req.params = {};
        const res = nres; res.setHeader("X-Request-Id", req.id); res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("X-Frame-Options", "DENY"); res.setHeader("Referrer-Policy", "no-referrer"); res.status = (code) => { res.statusCode = code; return res; }; res.json = (obj) => { if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8"); res.end(JSON.stringify(obj)); }; res.send = (data) => { if (Buffer.isBuffer(data) || typeof data === "string") res.end(data); else res.json(data); };
        const allowedOrigin = process.env.CORS_ORIGIN || "*"; if (allowedOrigin !== "*") res.setHeader("Vary", "Origin"); res.setHeader("Access-Control-Allow-Origin", allowedOrigin); res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,PATCH,OPTIONS"); res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-user-email, x-user-role, x-request-id");
        if (req.method === "OPTIONS") { res.status(204).end(); return; }
        try { const ct = req.header("content-type") || ""; if (["POST", "PUT", "PATCH"].includes(req.method)) { const raw = await readBody(req, Number(process.env.MAX_BODY_BYTES || 10 * 1024 * 1024)); if (ct.includes("application/json")) req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; else if (ct.includes("multipart/form-data")) { const { fields, file } = parseMultipart(raw, ct); req.body = fields; req.file = file; } else if (ct.includes("application/x-www-form-urlencoded")) req.body = Object.fromEntries(new URLSearchParams(raw.toString("utf8"))); else { req.rawBody = raw; req.body = {}; } } else req.body = {}; } catch (e) { const status = e.code === "LIMIT_BODY" ? 413 : 400; res.status(status).json({ error: status === 413 ? "Request body too large" : "Invalid request body", requestId: req.id }); return; }
        try { const handled = await dispatch(root, req, res, ""); if (!handled && !res.writableEnded) res.status(404).json({ error: "Not found: " + req.path, requestId: req.id }); } catch (e) { console.error(JSON.stringify({ requestId: req.id, method: req.method, path: req.path, error: e.message })); if (!res.writableEnded) res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : (e.message || "Internal server error"), requestId: req.id }); }
      });
      server.listen(port, cb); return server;
    } };
  return app;
}
