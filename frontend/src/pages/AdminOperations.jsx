import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, Field, Spinner } from "../components/ui.jsx";

export default function AdminOperations() {
  const [items, setItems] = useState(null);
  const [forms, setForms] = useState({});
  const [banner, setBanner] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState("");
  async function load() {
    try { setItems((await api.get("/admin/operations")).items); setLoadError(false); }
    catch (error) { setLoadError(true); setBanner({ tone: "error", msg: error.message }); }
  }
  useEffect(() => { load(); }, []);
  function update(id, change) { setForms((current) => ({ ...current, [id]: { ...current[id], ...change } })); }
  async function reconcile(item) {
    const form = forms[item.id] || {};
    if (!window.confirm("Have you verified the outcome independently? Resolving this operation allows retries.")) return;
    setBusy(item.id); setBanner(null);
    try {
      await api.post(`/admin/operations/${item.id}/reconcile`, form);
      setBanner({ tone: "success", msg: "Operation reconciled." });
      await load();
    } catch (error) { setBanner({ tone: "error", msg: error.message }); }
    finally { setBusy(""); }
  }
  return <section className="card">
    <h2>Operation reconciliation</h2>
    <p>Verify each outcome in CargoWise or the portal before resolving it. Never retry an uncertain operation until it has been reviewed. Portal orders are in memory and may disappear after a restart.</p>
    {banner && <Banner tone={banner.tone} onClose={() => setBanner(null)}>{banner.msg}</Banner>}
    {loadError && <button type="button" className="btn btn-outline" onClick={() => { setBanner(null); load(); }}>Retry loading operations</button>}
    {!items ? !loadError && <Spinner /> : items.length === 0 ? <p>No operations require review.</p> : items.map((item) => {
      const form = forms[item.id] || {};
      const cw = item.kind.startsWith("CW_");
      return <div key={item.id} className="config-step">
        <h3>{item.kind.replaceAll("_", " ")} · {item.entityRef}</h3>
        <p>Started {new Date(item.startedAt).toLocaleString()} by {item.actorName} ({item.actorRole}).</p>
        {!cw && <p>Order {item.details.orderNo}{item.details.orderNoSplit ? `-${item.details.orderNoSplit}` : ""} · Supplier {item.details.supplierCode} · Buyer {item.details.buyerCode}</p>}
        <Field label="Verified outcome">
          <select value={form.outcome || ""} onChange={(event) => update(item.id, { outcome: event.target.value })}>
            <option value="">Select outcome</option><option value="APPLIED">Applied</option><option value="NOT_APPLIED">Not applied</option>
          </select>
        </Field>
        {cw && form.outcome === "APPLIED" && <Field label="CargoWise reference" required><input maxLength={160} value={form.cwReference || ""} onChange={(event) => update(item.id, { cwReference: event.target.value })} /></Field>}
        <Field label="Review notes" required><textarea maxLength={2000} value={form.notes || ""} onChange={(event) => update(item.id, { notes: event.target.value })} /></Field>
        <button type="button" className="btn btn-primary" disabled={!!busy || loadError || !form.outcome || !form.notes?.trim() || (cw && form.outcome === "APPLIED" && !form.cwReference?.trim())} onClick={() => reconcile(item)}>Resolve operation</button>
      </div>;
    })}
  </section>;
}
