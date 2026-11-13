import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { OrgSearchPicker } from "../components/ui.jsx";
import { useAuth } from "../context/AuthContext.jsx";

const blankRole = { name: "", description: "", permissions: [], modules: [] };
const scopeFields = [
  ["booking-scope", "bookingOrgs", "Booking organizations", "cw"],
  ["booking-partners", "shipperOrgs", "Booking shippers", "cw"],
  ["booking-partners", "consigneeOrgs", "Booking consignees", "cw"],
  ["order-scope", "orderOrgs", "Order organizations", "cw"],
  ["order-partners", "supplierOrgs", "Order suppliers", "cw"],
  ["order-partners", "buyerOrgs", "Order buyers", "cw"],
  ["tracking-scope", "trackingOrgs", "Tracking organizations", "tracking"]
];
const userFields = { shipperOrgs: "bookingShipperOrgs", consigneeOrgs: "bookingConsigneeOrgs", supplierOrgs: "orderSupplierOrgs", buyerOrgs: "orderBuyerOrgs" };
const toggle = (list, value) => list.includes(value) ? list.filter((item) => item !== value) : [...list, value];

export default function TransitionAccess() {
  const { me, refresh } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [roles, setRoles] = useState([]);
  const [users, setUsers] = useState([]);
  const [role, setRole] = useState(blankRole);
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState("");
  const [modules, setModules] = useState(null);
  const [scopes, setScopes] = useState({});
  const [labels, setLabels] = useState({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const canRoles = me.permissions.includes("admin.roles");
  const canUsers = me.permissions.includes("admin.users");
  async function load() {
    try {
      const tasks = [api.get("/rbac/catalog")];
      if (canRoles) tasks.push(api.get("/roles"));
      if (canUsers) tasks.push(api.get("/users"));
      const result = await Promise.all(tasks);
      setCatalog(result[0]);
      let index = 1;
      if (canRoles) setRoles(result[index++].items);
      if (canUsers) setUsers(result[index].items);
    } catch (e) { setError(e.message); }
  }
  useEffect(() => { load(); }, [canRoles, canUsers]);
  function chooseUser(id) {
    setSelected(id);
    const user = users.find((item) => item.id === id);
    if (!user) return;
    setModules(user.modulesConfigured ? user.modules : null);
    setScopes(Object.fromEntries(scopeFields.map(([, field]) => [field, user[userFields[field] || field] || []])));
  }
  async function action(operation, message, refreshAccess = false) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); setNotice(message); await load(); if (refreshAccess) await refresh(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function saveRole(event) {
    event.preventDefault();
    await action(async () => {
      if (editing) await api.put(`/roles/${encodeURIComponent(role.name)}`, role);
      else await api.post("/roles", role);
      setRole(blankRole); setEditing(false);
    }, "Role saved.", true);
  }
  async function saveScope(path) {
    const fields = scopeFields.filter(([section]) => section === path).map(([, field]) => field);
    await action(async () => {
      const updated = await api.post(`/users/${selected}/${path}`, Object.fromEntries(fields.map((field) => [field, scopes[field]])));
      setScopes(Object.fromEntries(scopeFields.map(([, field]) => [field, updated[userFields[field] || field] || []])));
    }, "Scope saved.");
  }
  if (!catalog) return <section className="card">{error ? <p role="alert">{error}</p> : <p>Loading access settings...</p>}</section>;
  return <section className="card">
    <h2>Roles and access settings</h2>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {canRoles && <div>
      <h3>Roles</h3>
      <ul>{roles.map((item) => <li key={item.name}>{item.name} {item.name !== "Admin" && <>
        <button type="button" className="btn btn-sm" onClick={() => { setRole({ name: item.name, description: item.description, permissions: item.permissions, modules: item.modules }); setEditing(true); }}>Edit</button>{" "}
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => { if (window.confirm(`Delete role ${item.name}?`)) action(() => api.del(`/roles/${encodeURIComponent(item.name)}`), "Role deleted.", true); }}>Delete</button>
      </>}</li>)}</ul>
      <form onSubmit={saveRole}>
        <label>Role name <input required disabled={editing} value={role.name} onChange={(e) => setRole({ ...role, name: e.target.value })} /></label>{" "}
        <label>Description <input value={role.description} onChange={(e) => setRole({ ...role, description: e.target.value })} /></label>
        <h4>Permissions</h4><div className="check-grid">{Object.entries(catalog.permissions).map(([code, label]) => <label key={code}><input type="checkbox" checked={role.permissions.includes(code)} onChange={() => setRole({ ...role, permissions: toggle(role.permissions, code) })} /> {label}</label>)}</div>
        <h4>Modules</h4><div className="check-grid">{Object.entries(catalog.modules).map(([code, label]) => <label key={code}><input type="checkbox" checked={role.modules.includes(code)} onChange={() => setRole({ ...role, modules: toggle(role.modules, code) })} /> {label}</label>)}</div>
        <button className="btn btn-primary" disabled={busy}>Save role</button>{" "}
        {editing && <button type="button" className="btn" onClick={() => { setRole(blankRole); setEditing(false); }}>Cancel</button>}
      </form>
    </div>}
    {canUsers && <div>
      <h3>User modules and scopes</h3>
      <label>User <select value={selected} onChange={(e) => chooseUser(e.target.value)}><option value="">Select a user</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}</select></label>
      {selected && <>
        <p>Modules are limited to the assigned role's modules. Empty booking and order scopes allow visibility, but non-admin order creation requires an order scope; tracking requires explicit scope.</p>
        <label><input type="checkbox" checked={modules === null} onChange={(e) => setModules(e.target.checked ? null : [])} /> Inherit role modules</label>
        {modules !== null && <div className="check-grid">{Object.entries(catalog.modules).map(([code, label]) => <label key={code}><input type="checkbox" checked={modules.includes(code)} onChange={() => setModules(toggle(modules, code))} /> {label}</label>)}</div>}
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => action(() => api.post(`/users/${selected}/modules`, { modules }), "Modules saved.", selected === me.user.id)}>Save modules</button>
        {scopeFields.map(([path, field, label, kind], index) => <div key={field}>
          <h4>{label}</h4>
          <OrgSearchPicker kind={kind} selected={scopes[field] || []} labels={labels} onLabels={(items) => setLabels((prev) => ({ ...prev, ...Object.fromEntries(items.map((item) => [item.code, item.label])) }))} onToggle={(code) => setScopes((prev) => ({ ...prev, [field]: toggle(prev[field] || [], code) }))} />
          {(index === scopeFields.length - 1 || scopeFields[index + 1][0] !== path) && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => saveScope(path)}>Save {path.replace("-", " ")}</button>}
        </div>)}
      </>}
    </div>}
  </section>;
}
