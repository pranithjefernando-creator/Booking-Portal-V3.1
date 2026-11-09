import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Spinner, EmptyState, PageBanner, Pagination } from "../components/ui.jsx";
import { usePagination } from "../lib/pagination.js";
export default function AuditLog() {
  const [items, setItems] = useState(null); const [matrix, setMatrix] = useState(null);
  const pagination = usePagination(items);
  useEffect(() => { api.get("/audit-logs").then((d) => setItems(d.items)).catch(() => setItems([])); api.get("/rbac/matrix").then(setMatrix).catch(() => {}); }, []);
  return (<div className="page wide"><PageBanner title="Audit Log & Access" subtitle="Full activity trail and access control." /><div className="card"><div className="card-head">Immutable Audit Trail</div>{!items ? <Spinner /> : items.length === 0 ? <EmptyState>No audit entries.</EmptyState> : (<div className="scroll-x"><table className="table compact"><thead><tr><th>Timestamp</th><th>User</th><th>Role</th><th>Action</th><th>Entity</th></tr></thead><tbody>{pagination.items.map((a) => (<tr key={a.id}><td className="muted">{new Date(a.occurredAt).toLocaleString()}</td><td>{a.actorName}</td><td>{a.actorRole}</td><td><span className="tag tag-plain">{a.action}</span></td><td>{a.entityType} {a.entityId !== "-" ? <span className="mono">{a.entityId}</span> : ""}</td></tr>))}</tbody></table></div>)}{items && <Pagination pagination={pagination} label="Audit log" />}</div>{matrix && (<div className="card"><div className="card-head">Role – Permission Matrix</div><div className="scroll-x"><table className="table matrix"><thead><tr><th>Permission</th>{matrix.roles.map((r) => <th key={r}>{r}</th>)}</tr></thead><tbody>{matrix.matrix.map((row) => (<tr key={row.code}><td>{row.label}</td>{matrix.roles.map((r) => <td key={r} className="center">{row.grants[r] ? <span className="check">✓</span> : <span className="dash">–</span>}</td>)}</tr>))}</tbody></table></div></div>)}</div>);
}
