import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from "react";
import { api, loginRequest, getToken, setToken, clearToken } from "../api.js";
import { createAccessRequestGuard } from "../lib/accessRequestGuard.js";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [me, setMe] = useState(null); const [role, setRole] = useState(localStorage.getItem("sbms.role") || ""); const [token, setTokenState] = useState(getToken()); const [loading, setLoading] = useState(!!getToken()); const [accessError, setAccessError] = useState("");
  const guard = useRef(null);
  if (!guard.current) guard.current = createAccessRequestGuard(() => JSON.stringify([getToken(), localStorage.getItem("sbms.role") || ""]));
  const refresh = useCallback(async () => {
    const current = guard.current.begin();
    setLoading(true); setMe(null); setAccessError("");
    try { const result = await api.get("/me"); if (current()) setMe(result); }
    catch (e) { if (current()) { console.error(e); setMe(null); setAccessError("Unable to load your access settings. Please try again."); } }
    finally { if (current()) setLoading(false); }
  }, []);
  const clear = useCallback(() => { guard.current.invalidate(); clearToken(); localStorage.removeItem("sbms.role"); setTokenState(""); setRole(""); setMe(null); setAccessError(""); setLoading(false); }, []);
  useEffect(() => { if (token) refresh(); }, [refresh, role, token]);
  useEffect(() => { window.addEventListener("sbms:unauthorized", clear); return () => window.removeEventListener("sbms:unauthorized", clear); }, [clear]);
  useEffect(() => {
    const unavailable = () => { guard.current.invalidate(); setMe(null); setLoading(false); setAccessError("Unable to load your access settings. Please try again."); };
    window.addEventListener("sbms:access-unavailable", unavailable);
    return () => window.removeEventListener("sbms:access-unavailable", unavailable);
  }, []);
  const login = async (email, password, remember = true) => { const r = await loginRequest(email, password); setToken(r.token, remember); localStorage.removeItem("sbms.role"); setRole(""); setLoading(true); setTokenState(r.token); return r; };
  const logout = clear;
  const switchRole = (r) => { if (r) localStorage.setItem("sbms.role", r); else localStorage.removeItem("sbms.role"); setRole(r); };
  const can = (perm) => (me?.permissions || []).includes(perm); const hasModule = (m) => (me?.modules || []).includes(m);
  return <AuthContext.Provider value={{ me, role, token, loading, accessError, login, logout, switchRole, can, hasModule, refresh }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const ctx = useContext(AuthContext); if (!ctx) throw new Error("useAuth must be used within AuthProvider"); return ctx; }
