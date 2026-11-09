import React, { useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";
import { Field, Banner } from "../components/ui.jsx";
import Logo from "../components/Logo.jsx";
export default function ChangePassword({ forced = false, onDone }) {
  const { logout } = useAuth(); const [f, setF] = useState({ currentPassword: "", newPassword: "", confirm: "" }); const [error, setError] = useState(""); const [done, setDone] = useState(false); const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((c) => ({ ...c, [k]: e.target.value }));
  async function submit(e) {
    e.preventDefault(); setError("");
    if (!f.currentPassword || !f.newPassword) return setError("All fields are required");
    if (f.newPassword.length < 8 || !/[A-Za-z]/.test(f.newPassword) || !/\d/.test(f.newPassword)) return setError("New password must be at least 8 characters with letters and numbers");
    if (f.newPassword !== f.confirm) return setError("Passwords do not match");
    setBusy(true); try { await api.post("/auth/change-password", { currentPassword: f.currentPassword, newPassword: f.newPassword }); setDone(true); setF({ currentPassword: "", newPassword: "", confirm: "" }); onDone && onDone(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const form = (<form className="card login-card" onSubmit={submit} noValidate>
    <div className="login-brand">{forced && <Logo size={44} />}<div><div className="login-title">{forced ? "Set a new password" : "Change password"}</div>{forced && <div className="login-sub">You must change your temporary password before continuing.</div>}</div></div>
    {error && <Banner tone="error">{error}</Banner>}{done && <Banner tone="success">Password updated.</Banner>}
    <Field label="Current password" required><input type="password" autoComplete="current-password" value={f.currentPassword} onChange={set("currentPassword")} /></Field>
    <Field label="New password" required hint="At least 8 characters, letters and numbers"><input type="password" autoComplete="new-password" value={f.newPassword} onChange={set("newPassword")} /></Field>
    <Field label="Confirm new password" required><input type="password" autoComplete="new-password" value={f.confirm} onChange={set("confirm")} /></Field>
    <button className="btn btn-primary login-submit" type="submit" disabled={busy}>{busy ? "Saving…" : "Update password"}</button>
    {forced && <button type="button" className="btn" onClick={logout}>Sign out</button>}
  </form>);
  return forced ? <div className="login-page">{form}</div> : <div className="page"><div className="page-head"><h1>Account</h1></div>{form}</div>;
}
