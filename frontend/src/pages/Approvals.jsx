import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { Spinner, EmptyState, Banner, Modal, PageBanner, Pagination } from "../components/ui.jsx";
import { usePagination } from "../lib/pagination.js";
export default function Approvals() {
  const [items, setItems] = useState(null); const [banner, setBanner] = useState(null); const [reject, setReject] = useState(null); const [comment, setComment] = useState(""); const navigate = useNavigate();
  const pagination = usePagination(items);
  const load = () => api.get("/approvals?status=PENDING").then((d) => setItems(d.items)).catch((e) => setBanner({ tone: "error", msg: e.message }));
  useEffect(() => { load(); }, []);
  async function approve(a) { try { await api.post(`/approvals/${a.id}/approve`, { comment: "Approved" }); setBanner({ tone: "success", msg: `${a.bookingReference} approved.` }); load(); } catch (e) { setBanner({ tone: "error", msg: e.message }); } }
  async function doReject() { try { await api.post(`/approvals/${reject.id}/reject`, { comment }); setReject(null); setComment(""); load(); } catch (e) { setBanner({ tone: "error", msg: e.message }); } }
  return (<div className="page"><PageBanner title="Validation & Approvals" subtitle="Review and approve pending bookings." />{banner && <Banner tone={banner.tone} onClose={() => setBanner(null)}>{banner.msg}</Banner>}<div className="card"><div className="card-head">Pending approval requests</div>{!items ? <Spinner /> : items.length === 0 ? <EmptyState>No bookings awaiting approval. 🎉</EmptyState> : (<table className="table"><thead><tr><th>Ref</th><th>Rule</th><th>Mode</th><th>Shipper</th><th></th></tr></thead><tbody>{pagination.items.map((a) => (<tr key={a.id}><td className="mono clickable" onClick={() => navigate(`/bookings/${a.bookingId}`)}>{a.bookingReference}</td><td><span className="tag tag-amber">{a.ruleName}</span></td><td>{a.mode || "—"}</td><td>{a.shipper || "—"}</td><td className="row-actions"><button className="btn btn-success btn-sm" onClick={() => approve(a)}>✔ Approve</button><button className="btn btn-danger btn-sm" onClick={() => setReject(a)}>✖ Reject</button></td></tr>))}</tbody></table>)}{items && <Pagination pagination={pagination} label="Approvals" />}</div>{reject && (<Modal title={`Reject ${reject.bookingReference}`} onClose={() => setReject(null)} footer={<><button className="btn btn-ghost" onClick={() => setReject(null)}>Cancel</button><button className="btn btn-danger" disabled={!comment.trim()} onClick={doReject}>Reject</button></>}><textarea rows={4} placeholder="Reason…" value={comment} onChange={(e) => setComment(e.target.value)} /></Modal>)}</div>);
}
