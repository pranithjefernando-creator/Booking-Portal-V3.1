import React, { useEffect, useRef, useState } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext.jsx";
import { api } from "../api.js";
import Logo from "./Logo.jsx";
import { IconTracking, IconBell } from "./icons.jsx";
const NAV = [ { to: "/", label: "Home", icon: "▤", module: "dashboard", end: true }, { to: "/create", label: "Create Booking", icon: "✚", module: "create", perm: "booking.create" }, { to: "/bookings", label: "My Bookings", icon: "▦", module: "bookings" }, { to: "/tracking", label: "Tracking", icon: IconTracking, module: "tracking", end: true }, { to: "/tracking/shipments", label: "Shipment Tracking", icon: "⌖", module: "tracking", sub: true }, { to: "/import", label: "Upload Excel", icon: "⭱", module: "import", perm: "booking.import" }, { to: "/approvals", label: "Validation", icon: "✔", module: "approvals", perm: "booking.approve" }, { to: "/orders", label: "Orders", icon: "🧾", module: "orders", perm: "order.view" }, { to: "/audit", label: "Audit Log", icon: "🕓", module: "audit", perm: "audit.view" }, { to: "/admin", label: "Settings", icon: "⚙", module: "admin", perm: "admin.users" } ];
export default function Layout({ children }) {
  const { me, role, switchRole, logout, hasModule, can } = useAuth(); const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("sbms.sidebar") === "collapsed"); const [q, setQ] = useState("");
  const [notifs, setNotifs] = useState({ total: 0, items: [] }); const [notifOpen, setNotifOpen] = useState(false); const notifRef = useRef(null); const [menuOpen, setMenuOpen] = useState(false); const menuRef = useRef(null);
  useEffect(() => { if (!menuOpen) return; const onDoc = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); }; const onKey = (e) => { if (e.key === "Escape") setMenuOpen(false); }; document.addEventListener("mousedown", onDoc); document.addEventListener("keydown", onKey); return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); }; }, [menuOpen]);
  useEffect(() => { localStorage.setItem("sbms.sidebar", collapsed ? "collapsed" : "expanded"); }, [collapsed]);
  useEffect(() => {
    let alive = true;
    const load = () => api.get("/notifications/summary").then((d) => alive && setNotifs(d)).catch(() => {});
    load(); const id = setInterval(load, 60000);
    return () => { alive = false; clearInterval(id); };
  }, [me?.user?.email, role]);
  useEffect(() => {
    if (!notifOpen) return;
    const onDoc = (e) => { if (notifRef.current && !notifRef.current.contains(e.target)) setNotifOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [notifOpen]);
  const roles = me?.availableRoles || ["Data Entry", "Ops", "Manager", "Admin"]; const users = me?.availableUsers || [];
  const visible = NAV.filter((n) => hasModule(n.module) && (!n.perm || can(n.perm)));
  const name = me?.user?.name || "User"; const initials = name.split(" ").map((s) => s[0]).slice(0, 2).join("").toUpperCase();
  const subtitle = me?.user?.branchCode ? `${me.user.role} · ${me.user.branchCode}` : me?.user?.role;
  function runSearch(e) { e && e.preventDefault(); const term = q.trim(); if (!term) return; const looksOrder = /^(ord|po)[-\s]/i.test(term) || /order/i.test(term); if (looksOrder && hasModule("orders")) navigate(`/orders?q=${encodeURIComponent(term)}`); else navigate(`/bookings?q=${encodeURIComponent(term)}`); }
  return (<div className={`shell ${collapsed ? "collapsed" : ""}`}>
    <aside className="sidebar"><div className="sidebar-top"><div className="brand" onClick={() => navigate("/")}><Logo size={collapsed ? 34 : 38} />{!collapsed && <div className="brand-lines"><span className="brand-text">Booking Portal</span><span className="brand-sub">EFL Global</span></div>}</div><button className="collapse-btn" onClick={() => setCollapsed((c) => !c)} title={collapsed ? "Expand" : "Collapse"}>{collapsed ? "»" : "«"}</button></div>
      <nav>{visible.map((n) => (<NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => "nav-item" + (isActive ? " active" : "") + (n.sub ? " nav-sub" : "")} title={collapsed ? n.label : undefined}><span className="nav-icon">{typeof n.icon === "function" ? <n.icon size={19} /> : n.icon}</span><span className="nav-label">{n.label}</span></NavLink>))}</nav>
      <div className="sidebar-globe" style={{ backgroundImage: "url(/globe-orange.jpg)" }} /><div className="sidebar-tag">{collapsed ? <span className="tag-dot" /> : (<><span>CONNECTING</span><span>PEOPLE</span><span>GOODS</span><span>POSSIBILITIES</span></>)}</div></aside>
    <div className="main"><header className="topbar"><button className="topbar-toggle" onClick={() => setCollapsed((c) => !c)}>☰</button><form className="searchbar" onSubmit={runSearch}><button type="submit" className="search-ico">⌕</button><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search bookings, orders, clients… (press Enter)" /></form><div className="topbar-right">{me?.realRole === "Admin" && <label className="role-switch"><span>Role</span><select value={role || (me?.user?.role || "")} onChange={(e) => switchRole(e.target.value)}>{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>}<div className="notif-wrap" ref={notifRef}><button className="icon-btn" onClick={() => setNotifOpen((o) => !o)} title="Notifications"><IconBell size={19} />{notifs.total > 0 && <span className="dot-badge">{notifs.total > 99 ? "99+" : notifs.total}</span>}</button>{notifOpen && (<div className="notif-panel"><div className="notif-head">Notifications</div><div className="notif-list">{notifs.items.length === 0 ? <div className="notif-empty">You're all caught up 🎉</div> : notifs.items.map((n) => (<div key={n.key} className="notif-item" onClick={() => { setNotifOpen(false); navigate(n.link); }}><span className="notif-item-label">{n.label}</span><span className="notif-count">{n.count}</span></div>))}</div></div>)}</div><div className="avatar-wrap" ref={menuRef}><button type="button" className="avatar" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}><span className="avatar-badge">{initials}</span><div className="avatar-meta"><span className="avatar-name">{name}</span><span className="avatar-role">{subtitle}</span></div></button>{menuOpen && (<div className="avatar-menu" role="menu"><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); navigate("/account"); }}>Account</button><button type="button" role="menuitem" onClick={() => { setMenuOpen(false); logout(); }}>Sign out</button></div>)}</div></div></header><main className="content">{children}</main></div>
  </div>);
}
