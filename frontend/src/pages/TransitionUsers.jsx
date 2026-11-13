import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { useAuth } from "../context/AuthContext.jsx";

const emptyUser = { name: "", email: "", role: "Data Entry", branchCode: "CMB" };

export default function TransitionUsers() {
  const { me, refresh } = useAuth();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState(emptyUser);
  const [editing, setEditing] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setUsers((await api.get("/users")).items); }
    catch (err) { setError(err.message); }
  }
  useEffect(() => { load(); }, []);
  function edit(user) {
    setEditing(user.id);
    setForm({ name: user.name, email: user.email, role: user.role, branchCode: user.branchCode });
    setError("");
  }
  function cancel() { setEditing(""); setForm(emptyUser); }
  async function save(event) {
    event.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      if (editing) {
        await api.put(`/users/${editing}`, form);
        setNotice("User updated.");
      } else {
        const user = await api.post("/users", form);
        setNotice(`User created. Temporary password (shown once): ${user.initialPassword}`);
      }
      const updatedSelf = editing === me.user.id;
      cancel(); await load();
      if (updatedSelf) await refresh();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(user) {
    if (!window.confirm(`Delete ${user.name}?`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await api.del(`/users/${user.id}`); setNotice("User deleted."); await load(); if (user.id === me.user.id) await refresh(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function reset(user) {
    if (!window.confirm(`Reset the password for ${user.name}? Their existing sessions will be revoked.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await api.post(`/users/${user.id}/reset-password`);
      setNotice(`Temporary password for ${user.name} (shown once): ${result.initialPassword}`);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return <section className="card">
    <h2>User management</h2>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <form onSubmit={save} className="form-grid form-grid-2">
      <label>Name <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      <label>Email <input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
      <label>Role <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>{me.availableRoles.map((role) => <option key={role} value={role}>{role}</option>)}</select></label>
      <label>Branch <input value={form.branchCode} onChange={(e) => setForm({ ...form, branchCode: e.target.value })} /></label>
      <button className="btn btn-primary" disabled={busy} type="submit">{editing ? "Save user" : "Create user"}</button>
      {editing && <button className="btn" type="button" onClick={cancel}>Cancel edit</button>}
    </form>
    <table className="table"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Actions</th></tr></thead>
      <tbody>{users.map((user) => <tr key={user.id}><td>{user.name}</td><td>{user.email}</td><td>{user.role}</td><td>
        <button className="btn btn-sm" disabled={busy} onClick={() => edit(user)}>Edit</button>{" "}
        <button className="btn btn-sm" disabled={busy || user.id === me.user.id} onClick={() => reset(user)}>Reset password</button>{" "}
        <button className="btn btn-sm" disabled={busy} onClick={() => remove(user)}>Delete</button>
      </td></tr>)}</tbody>
    </table>
  </section>;
}
