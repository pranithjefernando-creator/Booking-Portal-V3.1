import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Banner, Spinner, EmptyState, PageBanner, Pagination } from "../components/ui.jsx";
import { usePagination } from "../lib/pagination.js";
export default function AuditLog() {
  const [items, setItems] = useState(null); const [total, setTotal] = useState(0); const [error, setError] = useState(""); const [matrix, setMatrix] = useState(null);
  const pagination = usePagination(items);
  async function loadAudit() {
    setItems(null); setError("");
    try { const data = await api.get("/audit-logs"); setItems(data.items); setTotal(data.total); }
    catch { setError("Unable to load the audit log. Please try again."); }
  }
  useEffect(() => { loadAudit(); api.get("/rbac/matrix").then(setMatrix).catch(() => {}); }, []);
  return (<div className="page wide"><PageBanner title="Audit Log & Access" subtitle="Activity trail and access control." /><div className="card"><div className="card-head">Immutable Audit Trail</div>{error ? <div role="alert"><Banner tone="error">{error}</Banner><button type="button" className="btn btn-outline" onClick={loadAudit}>Retry</button></div> : !items ? <Spinner /> : items.length === 0 ? <EmptyState>No audit entries.</EmptyState> : (<div className="scroll-x"><table className="table compact"><thead><tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Entity</th></tr></thead><tbody>{pagination.items.map((a) => (<tr key={a.id}><td className="muted">{new Date(a.occurredAt).toLocaleString()}</td><td>{a.actorName}</td><td>{a.actorRole}</td><td><span className="tag tag-plain">{a.action}</span></td><td>{a.entityType} {a.entityId !== "-" ? <span className="mono">{a.entityId}</span> : ""}</td></tr>))}</tbody></table></div>)}{items && total > items.length && <p className="muted">Showing the newest {items.length} of {total} audit entries.</p>}{items && <Pagination pagination={pagination} label="Audit log" />}</div>{matrix && (<div className="card"><div className="card-head">Role – Permission Matrix</div><div className="scroll-x"><table className="table matrix"><thead><tr><th>Permission</th>{matrix.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead><tbody>{matrix.matrix.map((row) => (<tr key={row.code}><td>{row.label}</td>{matrix.roles.map((r) => <td key={r} className="center">{row.grants[r] ? <span className="check">✓</span> : <span className="dash">–</span>}</td>)}</tr>))}</tbody></table></div></div>)}</div>);
}
