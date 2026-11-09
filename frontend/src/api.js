const BASE = "/api/v1";
export const TOKEN_KEY = "sbms.token";
export const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
export function setToken(token, remember) { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token); }
export function clearToken() { localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY); }
function headers(extra = {}) { const token = getToken(); const role = localStorage.getItem("sbms.role") || ""; const h = { ...extra }; if (token) h.Authorization = `Bearer ${token}`; if (role) h["x-user-role"] = role; return h; }
export { headers };
async function handle(res) { const text = await res.text(); const data = text ? JSON.parse(text) : {}; if (res.status === 401 && getToken()) { clearToken(); window.dispatchEvent(new Event("sbms:unauthorized")); } if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; err.data = data; throw err; } return data; }
export async function loginRequest(email, password) { const res = await fetch("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) }); return handle(res); }
export const api = {
  get: (p) => fetch(BASE + p, { headers: headers() }).then(handle),
  getText: (p) => fetch(BASE + p, { headers: headers() }).then((r) => r.text()),
  post: (p, b) => fetch(BASE + p, { method: "POST", headers: headers({ "Content-Type": "application/json" }), body: b === undefined ? undefined : JSON.stringify(b) }).then(handle),
  put: (p, b) => fetch(BASE + p, { method: "PUT", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(b) }).then(handle),
  patch: (p, b) => fetch(BASE + p, { method: "PATCH", headers: headers({ "Content-Type": "application/json" }), body: JSON.stringify(b) }).then(handle),
  del: (p) => fetch(BASE + p, { method: "DELETE", headers: headers() }).then(handle),
  upload: (p, file) => { const f = new FormData(); f.append("file", file); return fetch(BASE + p, { method: "POST", headers: headers(), body: f }).then(handle); },
  uploadDoc: (p, file, type) => { const f = new FormData(); if (type) f.append("type", type); f.append("file", file); return fetch(BASE + p, { method: "POST", headers: headers(), body: f }).then(handle); },
  download: (p, name = "download") => fetch(BASE + p, { headers: headers() }).then(async (r) => { const blob = await r.blob(); const cd = r.headers.get("Content-Disposition") || ""; const m = /filename="([^"]+)"/.exec(cd); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = m ? m[1] : name; a.click(); URL.revokeObjectURL(a.href); }),
  blob: (p) => fetch(BASE + p, { headers: headers() }).then(async (r) => { if (!r.ok) { const t = await r.text(); throw new Error(t ? (JSON.parse(t).error || "Failed") : "Failed"); } const blob = await r.blob(); return { url: URL.createObjectURL(blob), type: blob.type }; })
};
