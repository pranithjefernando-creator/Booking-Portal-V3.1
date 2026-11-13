import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import VisibilityProfiles, { VisibilityAssignments } from "../components/VisibilityProfiles.jsx";
import { RuleManager } from "./Admin.jsx";
import { useAuth } from "../context/AuthContext.jsx";

export default function TransitionConfigurations() {
  const { me, refresh } = useAuth();
  const [rules, setRules] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [fields, setFields] = useState([]);
  const [users, setUsers] = useState([]);
  const [selected, setSelected] = useState("");
  const [assignments, setAssignments] = useState({});
  const [banner, setBanner] = useState(null);
  const [busy, setBusy] = useState(false);
  async function load() {
    try {
      const [ruleData, profileData, fieldData, userData] = await Promise.all([api.get("/rule-configurations"), api.get("/field-visibility-profiles"), api.get("/rule-fields"), api.get("/users")]);
      setRules(ruleData.items); setProfiles(profileData.items); setFields(fieldData); setUsers(userData.items);
    } catch (error) { setBanner({ tone: "error", msg: error.message }); }
  }
  useEffect(() => { load(); }, []);
  function choose(id) {
    setSelected(id);
    const user = users.find((item) => item.id === id);
    setAssignments({ ruleConfigurationId: user?.ruleConfigurationId || "", bookingVisibilityProfileId: user?.bookingVisibilityProfileId || "", orderVisibilityProfileId: user?.orderVisibilityProfileId || "" });
  }
  async function save() {
    setBusy(true);
    try {
      await api.put(`/users/${selected}`, assignments);
      setBanner({ tone: "success", msg: "Assignments saved." }); await load();
      if (selected === me.user.id) await refresh();
    } catch (error) { setBanner({ tone: "error", msg: error.message }); }
    finally { setBusy(false); }
  }
  return <section className="card">
    <h2>Approval and visibility configurations</h2>
    <p>New users inherit the default rule unless a different configuration or no rules is explicitly selected. Unknown booking creators use the default rule.</p>
    {banner && <p role={banner.tone === "error" ? "alert" : "status"}>{banner.msg}</p>}
    <VisibilityProfiles profiles={profiles} onChange={load} setBanner={setBanner} />
    <RuleManager configurations={rules} fields={fields} onChange={load} setBanner={setBanner} />
    <h3>User assignments</h3>
    <label>User <select value={selected} onChange={(event) => choose(event.target.value)}><option value="">Select a user</option>{users.map((user) => <option key={user.id} value={user.id}>{user.name} ({user.email})</option>)}</select></label>
    {selected && <>
      <label>Approval rules <select value={assignments.ruleConfigurationId} onChange={(event) => setAssignments({ ...assignments, ruleConfigurationId: event.target.value })}><option value="">No rules</option>{rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.name}</option>)}</select></label>
      <VisibilityAssignments profiles={profiles} values={assignments} onChange={(change) => setAssignments({ ...assignments, ...change })} />
      <button type="button" className="btn btn-primary" disabled={busy} onClick={save}>Save assignments</button>
    </>}
  </section>;
}
