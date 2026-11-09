import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, loginRequest, getToken, setToken, clearToken } from "../api.js";
const AuthContext = createContext(null);
export function AuthProvider({ children }) {
  const [me, setMe] = useState(null); const [role, setRole] = useState(localStorage.getItem("sbms.role") || ""); const [token, setTokenState] = useState(getToken()); const [loading, setLoading] = useState(!!getToken());
  const refresh = useCallback(async () => { try { setMe(await api.get("/me")); } catch (e) { console.error(e); } finally { setLoading(false); } }, []);
  const clear = useCallback(() => { clearToken(); localStorage.removeItem("sbms.role"); setTokenState(""); setRole(""); setMe(null); setLoading(false); }, []);
  useEffect(() => { if (token) refresh(); }, [refresh, role, token]);
  useEffect(() => { window.addEventListener("sbms:unauthorized", clear); return () => window.removeEventListener("sbms:unauthorized", clear); }, [clear]);
  const login = async (email, password, remember = true) => { const r = await loginRequest(email, password); setToken(r.token, remember); localStorage.removeItem("sbms.role"); setRole(""); setLoading(true); setTokenState(r.token); return r; };
  const logout = clear;
  const switchRole = (r) => { if (r) localStorage.setItem("sbms.role", r); else localStorage.removeItem("sbms.role"); setRole(r); };
  const can = (perm) => (me?.permissions || []).includes(perm); const hasModule = (m) => (me?.modules || []).includes(m);
  return <AuthContext.Provider value={{ me, role, token, loading, login, logout, switchRole, can, hasModule, refresh }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const ctx = useContext(AuthContext); if (!ctx) throw new Error("useAuth must be used within AuthProvider"); return ctx; }
