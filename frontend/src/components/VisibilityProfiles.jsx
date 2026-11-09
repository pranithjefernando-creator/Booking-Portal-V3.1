import React, { useState } from "react";
import { api } from "../api.js";
import { FIELD_CATALOG } from "../lib/formVisibility.js";
import { Field, Modal } from "./ui.jsx";

export function VisibilityAssignments({ profiles, values, onChange }) {
  return ["booking", "order"].map((module) => {
    const key = `${module}VisibilityProfileId`;
    return <Field key={module} label={`${module === "booking" ? "Booking" : "Order"} field visibility`}>
      <select value={values[key] || ""} onChange={(event) => onChange({ [key]: event.target.value })}>
        <option value="">All fields visible</option>
        {profiles.filter((profile) => profile.module === module).map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
      </select>
    </Field>;
  });
}

export default function VisibilityProfiles({ profiles, onChange, setBanner }) {
  const [draft, setDraft] = useState(null);
  const [error, setError] = useState("");
  const open = (profile) => { setError(""); setDraft(profile ? { ...profile, hiddenFields: [...profile.hiddenFields] } : { name: "", module: "booking", hiddenFields: [] }); };
  const save = async () => {
    try {
      if (draft.id) await api.put(`/field-visibility-profiles/${draft.id}`, draft);
      else await api.post("/field-visibility-profiles", draft);
      setDraft(null); onChange(); setBanner({ tone: "success", msg: "Visibility profile saved." });
    } catch (error) { setError(error.message); }
  };
  const remove = async (profile) => {
    if (!confirm(`Delete visibility profile "${profile.name}"?`)) return;
    try { await api.del(`/field-visibility-profiles/${profile.id}`); onChange(); }
    catch (error) { setBanner({ tone: "error", msg: error.message }); }
  };
  const sections = draft ? [...new Set(FIELD_CATALOG[draft.module].map((field) => field.section))] : [];
  return <>
    <div className="card">
      <div className="card-head between"><span>Field Visibility Profiles</span><button className="btn btn-outline btn-sm" onClick={() => open(null)}>+ Create profile</button></div>
      {profiles.length === 0 ? <p className="muted">No profiles. All fields are visible by default.</p> : profiles.map((profile) => <div className="between" key={profile.id}>
        <span>{profile.name} · {profile.module} · {profile.hiddenFields.length} hidden</span>
        <div className="row-actions"><button className="btn btn-outline btn-sm" onClick={() => open(profile)}>Edit</button><button className="btn-x" aria-label={`Delete ${profile.name}`} onClick={() => remove(profile)}>×</button></div>
      </div>)}
    </div>
    {draft && <Modal title={draft.id ? "Edit visibility profile" : "Create visibility profile"} width={860} onClose={() => setDraft(null)} footer={<><button className="btn btn-ghost" onClick={() => setDraft(null)}>Cancel</button><button className="btn btn-primary" disabled={!draft.name.trim()} onClick={save}>Save</button></>}>
      {error && <p role="alert">{error}</p>}
      <div className="form-grid form-grid-2">
        <Field label="Profile name" required><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Field>
        <Field label="Module"><select value={draft.module} onChange={(event) => setDraft({ ...draft, module: event.target.value, hiddenFields: [] })}><option value="booking">Booking</option><option value="order">Order</option></select></Field>
      </div>
      <p className="muted">Uncheck fields to hide them. Required fields must remain visible.</p>
      {sections.map((section) => <div key={section}><div className="role-col-head">{section}</div><div className="check-grid">
        {FIELD_CATALOG[draft.module].filter((field) => field.section === section).map((field) => <label className="check-item" key={field.key}>
          <input type="checkbox" disabled={field.required} checked={field.required || !draft.hiddenFields.includes(field.key)} onChange={(event) => setDraft({ ...draft, hiddenFields: event.target.checked ? draft.hiddenFields.filter((key) => key !== field.key) : [...draft.hiddenFields, field.key] })} /> {field.label}{field.required ? " (required)" : ""}
        </label>)}
      </div></div>)}
    </Modal>}
  </>;
}
