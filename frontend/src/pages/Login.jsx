import React, { useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import Logo from "../components/Logo.jsx";

const ico = (d) => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>;

export default function Login() {
  const { login } = useAuth();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [remember] = useState(true); const [show, setShow] = useState(false);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [touched, setTouched] = useState(false); const [forgot, setForgot] = useState(false);
  async function submit(e) { e.preventDefault(); setTouched(true); setError(""); if (!email.trim() || !password) return; setBusy(true); try { await login(email.trim(), password, remember); } catch (err) { setError(err.message); setBusy(false); } }
  return (<div className="ol-page">
    <main className="ol-main">
      <form className="ol-form" onSubmit={submit} noValidate>
        <div className="ol-brand"><Logo size={96} /><span className="ol-brand-rule" /><div><div className="ol-wordmark">EFL <span>One</span></div><div className="ol-tag">PLAN <i>|</i> BOOK <i>|</i> MOVE <i>|</i> TOGETHER</div></div></div>
        <h2>Welcome to EFL <em>One</em></h2>
        <p className="ol-lead">Your single platform to plan, book, track and manage your shipments with EFL Global.</p>
        {error && <div className="ol-error" role="alert">{error}</div>}
        <div className={`ol-field ${touched && !email.trim() ? "bad" : ""}`}>
          <label htmlFor="ol-email">Username</label>
          <div className="ol-box">{ico(<><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 3.600-6 8-6s8 2 8 6" /></>)}<input id="ol-email" type="text" placeholder="Enter your username" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          {touched && !email.trim() && <span className="ol-hint">Enter your username</span>}
        </div>
        <div className={`ol-field ${touched && !password ? "bad" : ""}`}>
          <label htmlFor="ol-pass">Password</label>
          <div className="ol-box">{ico(<><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>)}<input id="ol-pass" type={show ? "text" : "password"} placeholder="Enter your password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="ol-eye" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide password" : "Show password"}>{ico(show ? <><path d="M2 12s3.500-7 10-7 10 7 10 7-3.500 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></> : <><path d="M3 3l18 18M10.600 5.100A10 10 0 0 1 12 5c6.500 0 10 7 10 7a17 17 0 0 1-3.100 4M6.600 6.600A17 17 0 0 0 2 12s3.500 7 10 7a9.700 9.700 0 0 0 4.300-1" /></>)}</button></div>
          {touched && !password && <span className="ol-hint">Password is required</span>}
        </div>
        <button type="button" className="ol-forgot" onClick={() => setForgot((v) => !v)}>Forgot Password?</button>
        {forgot && <div className="ol-note">Please contact your EFL administrator to reset your password.</div>}
        <button className="ol-submit" type="submit" disabled={busy}>{busy ? "Signing in…" : <>Sign In <span aria-hidden="true">→</span></>}</button>
        <div className="ol-divider" />
        <div className="ol-values">PEOPLE <i>|</i> SOLUTIONS <i>|</i> A BRIGHTER TOMORROW</div>
      </form>
    </main>
    <aside className="ol-side" role="img" aria-label="Global logistics: ship, aircraft and truck across a world map" />
  </div>);
}
