import React from "react";
import { IconBox, IconChevron, IconPlane, IconShip, IconWarehouse } from "./icons.jsx";
import { usePagination } from "../lib/pagination.js";
import { api } from "../api.js";
const S = { DRAFT: { bg: "#E5E7EB", fg: "#374151" }, VALIDATED: { bg: "#DBEAFE", fg: "#1D4ED8" }, PENDING_APPROVAL: { bg: "#FEF3C7", fg: "#B45309" }, APPROVED: { bg: "#DCFCE7", fg: "#15803D" }, COMPLETED: { bg: "#DCFCE7", fg: "#166534" }, CANCELLED: { bg: "#F3F4F6", fg: "#6B7280" }, PENDING: { bg: "#FEF3C7", fg: "#B45309" }, SHIPPED: { bg: "#DCFCE7", fg: "#166534" }, OVERDUE: { bg: "#FEE2E2", fg: "#B91C1C" } };
export function StatusBadge({ status }) { const s = S[status] || S.DRAFT; return <span className="badge" style={{ background: s.bg, color: s.fg }}>{String(status || "").replace("_", " ")}</span>; }
export function KpiCard({ label, value, tone = "blue" }) { return <div className={`kpi kpi-${tone}`}><div className="kpi-value">{value}</div><div className="kpi-label">{label}</div></div>; }
export function Field({ label, required, children, error, hint }) { return <label className={`field ${error ? "field-error" : ""}`}><span className="field-label">{label} {required && <span className="req">*</span>}</span>{children}{hint && !error && <span className="field-hint">{hint}</span>}{error && <span className="field-msg">{error}</span>}</label>; }
export function Select({ value, onChange, options, placeholder = "Select…", disabled }) { const opts = value && !options.some((o) => o.code === value) ? [{ code: value, label: value }, ...options] : options; return <select value={value || ""} onChange={(e) => onChange(e.target.value)} disabled={disabled}><option value="">{placeholder}</option>{opts.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}</select>; }
export function Banner({ tone = "info", children, onClose }) { return <div className={`banner banner-${tone}`}><div>{children}</div>{onClose && <button className="banner-close" onClick={onClose}>×</button>}</div>; }
export function Modal({ title, children, onClose, footer, width = 520 }) { return <div className="modal-overlay" onClick={onClose}><div className="modal" style={{ width }} onClick={(e) => e.stopPropagation()}><div className="modal-head"><h3>{title}</h3><button className="modal-x" onClick={onClose}>×</button></div><div className="modal-body">{children}</div>{footer && <div className="modal-foot">{footer}</div>}</div></div>; }
export function Spinner({ label = "Loading…" }) { return <div className="spinner"><div className="spin" /> {label}</div>; }
export function EmptyState({ children }) { return <div className="empty">{children}</div>; }
export function Pagination({ pagination, label = "Results" }) {
  const { page, pageSize, pageCount, total, start, end, setPage, setPageSize } = pagination;
  return <nav className="pagination" aria-label={`${label} pagination`}>
    <span className="pagination-range" role="status">{start}-{end} of {total}</span>
    <label className="pagination-size">Rows per page<select aria-label={`${label} rows per page`} value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
    <div className="pagination-navigation">
      <button type="button" className="pagination-button" title="First page" aria-label="First page" disabled={page === 1} onClick={() => setPage(1)}><IconChevron size={15} /><IconChevron size={15} /></button>
      <button type="button" className="pagination-button" title="Previous page" aria-label="Previous page" disabled={page === 1} onClick={() => setPage(page - 1)}><IconChevron size={18} /></button>
      <label className="pagination-page">Page<input type="number" aria-label={`${label} page`} min={1} max={pageCount} value={page} onChange={(event) => setPage(event.target.valueAsNumber)} />of {pageCount}</label>
      <button type="button" className="pagination-button pagination-forward" title="Next page" aria-label="Next page" disabled={page === pageCount} onClick={() => setPage(page + 1)}><IconChevron size={18} /></button>
      <button type="button" className="pagination-button pagination-forward" title="Last page" aria-label="Last page" disabled={page === pageCount} onClick={() => setPage(pageCount)}><IconChevron size={15} /><IconChevron size={15} /></button>
    </div>
  </nav>;
}
const LIFECYCLE_IMAGES = {
  "Picked Up": "/Tracking%20-%20Picked%20Up.png",
  Departed: "/Tracking%20-%20Departed%20Sea.png",
  DepartedAir: "/Tracking%20-%20Departed%20Air.png",
  "In Transit": "/Tracking%20-%20In%20Transit.png",
  Arriving: "/Tracking%20-%20Arriving.png",
  Delivered: "/Tracking%20-%20Delivered.png",
};
const LIFECYCLE_ICONS = { "Picked Up": IconBox, Departed: IconShip, "In Transit": IconShip, Arriving: IconWarehouse, Delivered: IconBox };
function lifecycleState(index, activeIndex) { return index < activeIndex ? "complete" : index === activeIndex ? "current" : "pending"; }
export function LifecycleProgress({ lifecycle, dateFormatter }) {
  const format = dateFormatter || ((value) => value);
  const segmentCount = Math.max(lifecycle.stages.length - 1, 1);
  const segmentWidth = 80 / segmentCount;
  return (<div className="tracking-progress">
    <div className="tracking-progress-art">{lifecycle.stages.map((stage, index) => { const state = lifecycleState(index, lifecycle.activeIndex); const image = stage.label === "Departed" && lifecycle.transportMode === "AIR" ? LIFECYCLE_IMAGES.DepartedAir : LIFECYCLE_IMAGES[stage.label]; return <img className={`tracking-progress-art-image ${state}`} key={stage.label} src={image} alt={`${stage.label} milestone`} />; })}</div>
    <div className="tracking-progress-track" aria-label="Milestone progress">
      {lifecycle.stages.slice(0, -1).map((stage, segmentIndex) => { const state = segmentIndex < lifecycle.activeIndex - 1 ? "complete" : segmentIndex === lifecycle.activeIndex - 1 ? "current" : "pending"; return <span className={`tracking-progress-segment ${state}`} key={`${stage.label}-segment`} style={{ left: `${10 + segmentIndex * segmentWidth}%`, width: `${segmentWidth}%` }} aria-hidden="true" />; })}
      {lifecycle.stages.map((stage, index) => { const state = lifecycleState(index, lifecycle.activeIndex); const StageIcon = stage.label === "Departed" && lifecycle.transportMode === "AIR" ? IconPlane : LIFECYCLE_ICONS[stage.label] || IconBox; return <span className={`tracking-progress-node ${state}`} key={stage.label} aria-hidden="true"><StageIcon size={17} /></span>; })}
    </div>
    <div className="tracking-progress-labels">{lifecycle.stages.map((stage, index) => { const state = lifecycleState(index, lifecycle.activeIndex); return <div className={`tracking-progress-label ${state}`} key={stage.label}><strong>{stage.label}</strong><small>{stage.description}</small><small>{format(stage.date)}</small></div>; })}</div>
  </div>);
}

export function ExportChoiceModal({ onClose, onConfirm, visibleCount, allCount }) {
  const [mode, setMode] = React.useState("visible");
  const footer = (<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => onConfirm(mode)}>⭳ Export</button></>);
  return (<Modal title="Export to Excel" onClose={onClose} footer={footer} width={460}>
    <p className="muted" style={{ marginTop: 0 }}>Choose which columns to include in the exported file.</p>
    <label className="check-item" style={{ marginBottom: 8 }}><input type="radio" name="export-cols" checked={mode === "visible"} onChange={() => setMode("visible")} /> Only the columns currently shown ({visibleCount})</label>
    <label className="check-item"><input type="radio" name="export-cols" checked={mode === "all"} onChange={() => setMode("all")} /> All available columns ({allCount})</label>
  </Modal>);
}
export function OrgChecklist({ options, selected, onToggle, disabled, empty }) {
  const [q, setQ] = React.useState("");
  const filtered = q.trim() ? (options || []).filter((o) => `${o.label} ${o.code}`.toLowerCase().includes(q.trim().toLowerCase())) : options || [];
  const pagination = usePagination(filtered, q);
  if (!options || options.length === 0) return <p className="muted">{empty || "No organizations available."}</p>;
  return (<div className="org-checklist">
    {options.length > 8 && <input type="text" className="org-checklist-search" placeholder="Search organizations…" value={q} onChange={(e) => setQ(e.target.value)} />}
    {filtered.length === 0 ? <p className="muted">No organizations match "{q}".</p> : (<div className="check-grid">{pagination.items.map((o) => (<label key={o.code} className="check-item"><input type="checkbox" disabled={disabled} checked={selected.includes(o.code)} onChange={() => onToggle(o.code)} /> {o.label}</label>))}</div>)}
    {(options.length > 25 || pagination.pageSize !== 25) && <Pagination pagination={pagination} label="Organizations" />}
  </div>);
}
export function OrgSearchPicker({ kind = "cw", selected, onToggle, labels, onLabels, disabled }) {
  const [q, setQ] = React.useState("");
  const [state, setState] = React.useState({ items: [], hasMore: false, loading: true, error: "" });
  React.useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      setState((s) => ({ ...s, loading: true }));
      api.get(`/orgs/search?kind=${kind}&limit=25&q=${encodeURIComponent(q.trim())}`)
        .then((d) => { if (!alive) return; onLabels(d.items); setState({ items: d.items, hasMore: d.hasMore, loading: false, error: "" }); })
        .catch((e) => alive && setState({ items: [], hasMore: false, loading: false, error: e.message }));
    }, q ? 250 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, kind]); // eslint-disable-line
  const missing = selected.filter((code) => !labels[code]).join(",");
  React.useEffect(() => {
    if (!missing) return;
    api.post("/orgs/lookup", { codes: missing.split(",") }).then((d) => onLabels(d.items)).catch(() => {});
  }, [missing]); // eslint-disable-line
  return (<div className="org-checklist">
    {selected.length > 0 && <div className="org-selected" aria-label="Selected organizations">{selected.map((code) => (<span key={code} className="chip" title={labels[code] || code}>{labels[code] || code}{!disabled && <button type="button" className="btn-x" aria-label={`Remove ${code}`} onClick={() => onToggle(code)}>×</button>}</span>))}</div>}
    <input type="text" className="org-checklist-search" placeholder="Type a code or name to search organizations…" value={q} onChange={(e) => setQ(e.target.value)} />
    {state.error ? <p className="muted">{state.error}</p> : state.loading && !state.items.length ? <p className="muted">Searching…</p> : state.items.length === 0 ? <p className="muted">No organizations match "{q}".</p> : (<div className="check-grid">{state.items.map((o) => (<label key={o.code} className="check-item"><input type="checkbox" disabled={disabled} checked={selected.includes(o.code)} onChange={() => onToggle(o.code)} /> {o.label}</label>))}</div>)}
    {state.hasMore && <p className="muted">Showing the first 25 matches — keep typing to narrow the list.</p>}
  </div>);
}
export function DocViewer({ api, doc, contentPath, downloadPath, onClose }) {
  const [state, setState] = React.useState({ loading: true, url: "", type: "", error: "" });
  React.useEffect(() => { let alive = true; let objUrl = ""; api.blob(contentPath).then(({ url, type }) => { if (!alive) { URL.revokeObjectURL(url); return; } objUrl = url; setState({ loading: false, url, type: type || doc.mimeType || "", error: "" }); }).catch((e) => alive && setState({ loading: false, url: "", type: "", error: e.message })); return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl); }; }, [contentPath]); // eslint-disable-line
  const mt = state.type || doc.mimeType || ""; const isPdf = /pdf/i.test(mt) || /\.pdf$/i.test(doc.fileName || ""); const isImg = /^image\//i.test(mt) || /\.(png|jpe?g|gif|webp|svg)$/i.test(doc.fileName || ""); const isText = /^text\//i.test(mt) || /\.(txt|csv|json|xml|html?)$/i.test(doc.fileName || "");
  const footer = (<><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={() => api.download(downloadPath, doc.fileName)}>⭳ Download</button></>);
  return (<Modal title={doc.fileName || "Document"} width={900} onClose={onClose} footer={footer}>{state.loading ? <Spinner label="Loading document…" /> : state.error ? <Banner tone="error">{state.error}</Banner> : (<div className="doc-viewer">{isPdf || isText ? <iframe title="doc" src={state.url} className="doc-frame" /> : isImg ? <img alt={doc.fileName} src={state.url} className="doc-img" /> : (<div className="doc-nopreview"><div className="doc-nopreview-ico">📄</div><p>Preview isn't available{mt ? ` (${mt})` : ""}.</p><button className="btn btn-primary" onClick={() => api.download(downloadPath, doc.fileName)}>⭳ Download to view</button></div>)}</div>)}</Modal>);
}
// EFL One banner shown on every module.
export function PageBanner({ title }) {
  return (<div className="page-banner"><div className="pb-frame"><img className="pb-img" src="/efl-one-banner.png" alt={title ? `EFL One — ${title}` : "EFL One — Plan, Book, Move, Together"} /></div></div>);
}
