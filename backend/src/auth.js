import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { db } from "./db.js";

const TOKEN_TTL_MS = Number(process.env.AUTH_TOKEN_TTL_HOURS || 8) * 3600 * 1000;
const SECRET = process.env.AUTH_SECRET || randomBytes(32).toString("hex");
if (!process.env.AUTH_SECRET) console.warn("AUTH_SECRET is not set; using a random secret (sessions reset on restart).");

// Credentials are kept apart from user records so hashes never leak through user APIs.
const credentials = new Map();
const attempts = new Map();
const MAX_ATTEMPTS = 5, LOCK_MS = 15 * 60 * 1000;

const b64 = (s) => Buffer.from(s).toString("base64url");
const sign = (data) => createHmac("sha256", SECRET).update(data).digest("base64url");

function hash(password, salt = randomBytes(16)) { return { salt: salt.toString("hex"), hash: scryptSync(password, salt, 64).toString("hex") }; }
function verify(password, rec) { const h = scryptSync(password, Buffer.from(rec.salt, "hex"), 64); const e = Buffer.from(rec.hash, "hex"); return h.length === e.length && timingSafeEqual(h, e); }

export function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const pick = (n) => Array.from(randomBytes(n), (b) => chars[b % chars.length]).join("");
  return `${pick(10)}-${randomBytes(1)[0] % 90 + 10}`;
}

export function setPassword(userId, password, mustChange = false) { credentials.set(userId, { ...hash(password), mustChange }); }
export function removeCredentials(userId) { credentials.delete(userId); }
export function mustChangePassword(userId) { return !!credentials.get(userId)?.mustChange; }

// Creates a user's initial password; the caller delivers it (email to be wired up later).
export function issueInitialPassword(userId) { const pw = generatePassword(); setPassword(userId, pw, true); return pw; }

export function validatePasswordStrength(pw) {
  if (typeof pw !== "string" || pw.length < 8) return "Password must be at least 8 characters";
  if (pw.length > 128) return "Password is too long";
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return "Password must contain letters and numbers";
  return null;
}

function issueToken(userId) { const body = b64(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS })); return `${body}.${sign(body)}`; }
function readToken(token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) return null;
  const expected = sign(body);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try { const p = JSON.parse(Buffer.from(body, "base64url").toString()); return p.exp > Date.now() ? p : null; } catch { return null; }
}

export function login(req, res) {
  const { email, password } = req.body || {};
  const key = String(email || "").trim().toLowerCase();
  if (!key || typeof password !== "string" || !password) return res.status(400).json({ error: "Email and password are required" });
  const a = attempts.get(key);
  if (a && a.lockedUntil > Date.now()) return res.status(429).json({ error: "Too many failed attempts. Try again later." });
  const user = db.users.find((u) => u.email.toLowerCase() === key);
  const rec = user && credentials.get(user.id);
  if (!rec || !verify(password, rec)) {
    const n = (a && a.lockedUntil <= Date.now() ? a.count : 0) + 1;
    attempts.set(key, n >= MAX_ATTEMPTS ? { count: 0, lockedUntil: Date.now() + LOCK_MS } : { count: n, lockedUntil: 0 });
    return res.status(401).json({ error: "Invalid email or password" });
  }
  attempts.delete(key);
  res.json({ token: issueToken(user.id), mustChangePassword: !!rec.mustChange, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}

export function changePassword(req, res) {
  const { currentPassword, newPassword } = req.body || {};
  const rec = credentials.get(req.user.id);
  if (!rec || typeof currentPassword !== "string" || !verify(currentPassword, rec)) return res.status(400).json({ error: "Current password is incorrect" });
  const err = validatePasswordStrength(newPassword);
  if (err) return res.status(400).json({ error: err });
  if (newPassword === currentPassword) return res.status(400).json({ error: "New password must differ from the current password" });
  setPassword(req.user.id, newPassword, false);
  res.json({ ok: true });
}

export function authMiddleware(req, res, next) {
  const m = /^Bearer (.+)$/.exec(req.header("authorization") || "");
  const payload = m && readToken(m[1]);
  let user = payload && db.users.find((u) => u.id === payload.uid);
  if (!user) return res.status(401).json({ error: "Authentication required" });
  // Role override (role-preview) is limited to real Admins.
  const roleOverride = req.header("x-user-role");
  if (roleOverride && user.role === "Admin" && db.roles[roleOverride]) user = { ...user, role: roleOverride };
  req.realRole = payload ? db.users.find((u) => u.id === payload.uid).role : "";
  req.user = user;
  next();
}
