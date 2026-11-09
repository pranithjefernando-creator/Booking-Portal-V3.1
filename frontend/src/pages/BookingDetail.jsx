import React, { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { StatusBadge, Spinner, Banner, Modal, PageBanner, DocViewer } from "../components/ui.jsx";
import { useAuth } from "../context/AuthContext.jsx";
const FLOW = ["DRAFT", "VALIDATED", "PENDING_APPROVAL", "APPROVED", "COMPLETED"];
export default function BookingDetail() {
  const { id } = useParams(); const navigate = useNavigate(); const { can } = useAuth();
  const [b, setB] = useState(null); const [banner, setBanner] = useState(null); const [busy, setBusy] = useState(false); const [xml, setXml] = useState(null); const [viewDoc, setViewDoc] = useState(null);
  const load = () => api.get(`/bookings/${id}`).then(setB).catch((e) => setBanner({ tone: "error", msg: e.message }));
  useEffect(() => { load(); }, [id]); // eslint-disable-line
  if (!b) return <Spinner label="Loading booking…" />;
  const act = async (fn, ok) => { setBusy(true); setBanner(null); try { const r = await fn(); setBanner({ tone: r && r._tone ? r._tone : "success", msg: ok(r) }); await load(); } catch (e) { setBanner({ tone: "error", msg: e.message }); } finally { setBusy(false); } };
  const cwMsg = (r, p) => { const cw = r.cw || {}; if (cw.ok) return `${p} (${cw.mode})${r.isUpdate ? " — UPDATE" : ""}. ${cw.cwBookingNumber ? "CW " + cw.cwBookingNumber : ""}`; r._tone = "error"; return `${p} failed: ${cw.error || "HTTP " + cw.status}.`; };
  const validate = () => act(() => api.post(`/bookings/${id}/validate`), (r) => r.requiresApproval ? "Validated. Approval required." : "Validated.");
  const submitApproval = () => act(() => api.post(`/bookings/${id}/submit-approval`), (r) => `Submitted for approval (${r.ruleName}).`);
  const complete = () => act(() => api.post(`/bookings/${id}/complete`), (r) => cwMsg(r, "Completed & sent to CargoWise"));
  const sendUpdate = () => act(() => api.post(`/bookings/${id}/resend-cw`), (r) => cwMsg(r, r.isUpdate ? "Update sent to CargoWise" : "Sent to CargoWise"));
  const markConverted = () => act(() => api.post(`/bookings/${id}/mark-converted`, { converted: true }), () => "Marked converted. Edits locked.");
  async function previewXml() { try { setXml(await api.getText(`/bookings/${id}/cw-xml`)); } catch (e) { setBanner({ tone: "error", msg: e.message }); } }
  const si = FLOW.indexOf(b.status); const dg = b.dg || {}; const pk = b.pickup || {};
  const isCompleted = b.status === "COMPLETED"; const editable = b.editable !== false;
  const canEdit = can("booking.edit") && ((b.status === "DRAFT") || (isCompleted && editable));
  return (<div className="page">
    <PageBanner title="Booking Details" subtitle="Review and progress this booking." />
    <div className="page-head between"><h1>Booking {b.reference} <StatusBadge status={b.status} />{isCompleted && b.cwConverted && <span className="tag tag-plain">🔒 Shipment</span>}</h1><button className="btn btn-ghost" onClick={() => navigate(-1)}>← Back</button></div>
    {banner && <Banner tone={banner.tone} onClose={() => setBanner(null)}>{banner.msg}</Banner>}
    {b.status === "PENDING_APPROVAL" && <Banner tone="info">Awaiting approval{b.pendingApproval?.ruleName ? ` (${b.pendingApproval.ruleName})` : ""} — requested by {b.pendingApproval?.requestedBy || "—"}.</Banner>}
    {isCompleted && !b.cwConverted && <Banner tone="info">This booking is in CargoWise as <strong>{b.cw1ShipmentRef || "—"}</strong>. You can still edit it — changes are sent to CW as an <strong>update</strong> until it's converted to a shipment.</Banner>}
    <div className="lifecycle">{FLOW.map((s, i) => (<div key={s} className={"stage " + (i <= si ? "done" : "") + (i === si ? " current" : "")}><span className="stage-dot">{i + 1}</span><span>{s.replace("_", " ")}</span></div>))}</div>
    <div className="grid-2">
      <div className="card"><div className="card-head">Parties</div><dl className="summary"><dt>Shipper</dt><dd>{b.shipper?.companyName || "—"}</dd><dt>Consignee</dt><dd>{b.consignee?.companyName || "—"}</dd><dt>Organization</dt><dd><span className="chip">{b.cwOrgCode || "—"}</span></dd>{b.cw1ShipmentRef && <><dt>CW Booking No.</dt><dd><span className="cw-ref">{b.cw1ShipmentRef}</span></dd></>}</dl></div>
      <div className="side"><div className="card"><div className="card-head">Actions</div><div className="action-list">
        {canEdit && <button className="btn btn-outline block" onClick={() => navigate(`/bookings/${id}/edit`)} disabled={busy}>✎ Edit booking</button>}
        {b.status === "DRAFT" && can("booking.validate") && <button className="btn btn-primary block" onClick={validate} disabled={busy}>✔ Validate</button>}
        {b.status === "VALIDATED" && b.requiresApproval && can("booking.validate") && <button className="btn btn-primary block" onClick={submitApproval} disabled={busy}>📤 Submit for Approval</button>}
        {["VALIDATED", "APPROVED"].includes(b.status) && !(b.status === "VALIDATED" && b.requiresApproval) && can("booking.complete") && <button className="btn btn-success block" onClick={complete} disabled={busy}>✅ Complete &amp; send to CargoWise</button>}
        {isCompleted && !b.cwConverted && can("booking.complete") && <button className="btn btn-primary block" onClick={sendUpdate} disabled={busy}>↻ Send update to CargoWise</button>}
        {isCompleted && !b.cwConverted && can("booking.complete") && <button className="btn btn-ghost block" onClick={markConverted} disabled={busy}>🔒 Mark converted to shipment</button>}
        <button className="btn btn-ghost block" onClick={previewXml}>👁 Preview CW XML {b.cw1ShipmentRef ? "(update)" : "(new)"}</button>
      </div></div></div>
    </div>
    <div className="card"><div className="card-head">Shipping Information</div><dl className="summary summary-3">
      <dt>Mode</dt><dd>{b.mode || "—"}</dd><dt>Incoterms</dt><dd>{b.incotermCode || "—"}</dd><dt>Freight Terms</dt><dd>{b.freightTerms || "—"}</dd>
      <dt>Origin</dt><dd>{b.originCode || "—"}</dd><dt>Destination</dt><dd>{b.destCode || "—"}</dd><dt>Commodity</dt><dd>{b.commodityCode || "—"}</dd>
      <dt>Cargo Ready</dt><dd>{b.cargoReadyDate || "—"}</dd><dt>Shipper Ref</dt><dd>{b.shipperReferenceNo || "—"}</dd><dt>Goods</dt><dd>{b.goodsDescription || "—"}</dd>
    </dl>{b.marksAndNumbers && <div className="mini-note">🏷 Marks &amp; Numbers: {b.marksAndNumbers}</div>}{b.isDg && <div className="mini-note">⚠ DG: UN {dg.unNumber || "—"} · Class {dg.dgClass || "—"}</div>}{b.pickupRequired && <div className="mini-note">🚚 Pickup: {pk.contact || "—"} · {pk.phone || "—"}</div>}</div>
    <div className="card"><div className="card-head">Cargo Details</div>{(b.cargoLines || []).length === 0 ? <p className="muted">No cargo lines.</p> : (<div className="scroll-x"><table className="table compact"><thead><tr><th>#</th><th>Packages</th><th>Type</th><th>Gross Wt</th><th>Unit</th><th>Volume</th><th>Vol Unit</th><th>HS Code</th><th>PO Numbers</th></tr></thead><tbody>{b.cargoLines.map((l, i) => (<tr key={l.id || i}><td>{i + 1}</td><td>{l.packages ?? "—"}</td><td>{l.packageTypeCode || "—"}</td><td>{l.grossWeight ?? "—"}</td><td>{l.weightUnit || "—"}</td><td>{l.volume ?? "—"}</td><td>{l.volumeUnit || "—"}</td><td>{l.hsCode || "—"}</td><td>{l.poNumbers || "—"}</td></tr>))}</tbody></table></div>)}{(b.containers || []).length > 0 && (<><div className="card-head" style={{ marginTop: 14 }}>Containers</div><table className="table compact"><thead><tr><th>Type/Size</th><th>Count</th></tr></thead><tbody>{b.containers.map((c, i) => (<tr key={c.id || i}><td>{c.containerTypeCode || "—"}</td><td>{c.count ?? "—"}</td></tr>))}</tbody></table></>)}</div>
    {(b.linkedOrders || []).length > 0 && (<div className="card"><div className="card-head">Linked Orders</div><table className="table compact"><tbody>{b.linkedOrders.map((o) => (<tr key={o.id} className="clickable" onClick={() => navigate(`/orders/${o.id}`)}><td className="mono">{o.reference}</td><td>{o.orderNo}</td><td><StatusBadge status={o.status} /></td></tr>))}</tbody></table></div>)}
    {(b.cwStatus || b.cwResponse) && (<div className="card cw-panel"><div className="card-head">CargoWise Response</div><div className="cw-badges"><span className={`tag ${b.cwStatus === "SENT" ? "tag-ok" : "tag-error"}`}>{b.cwStatus}</span><span className="tag tag-plain">HTTP {b.cwHttpStatus || 0}</span>{b.cwLastAction && <span className="tag tag-blue">{b.cwLastAction}</span>}</div><pre className="cw-xml">{b.cwResponse}</pre></div>)}
    <div className="card"><div className="card-head">Documents <span className="muted">({(b.documents || []).length})</span></div>{(b.documents || []).length === 0 ? <p className="muted">No documents attached. Open <strong>Edit booking</strong> to add documents.</p> : (<table className="table compact"><thead><tr><th>Type</th><th>File</th><th>Size</th><th></th></tr></thead><tbody>{b.documents.map((d) => (<tr key={d.id}><td><span className="tag tag-blue">{d.type || "DOC"}</span></td><td>{d.fileName}</td><td className="muted">{(d.size / 1024).toFixed(1)} KB</td><td className="row-actions"><button className="btn btn-outline btn-sm" onClick={() => setViewDoc(d)}>👁 View</button><button className="btn btn-ghost btn-sm" onClick={() => api.download(`/bookings/${id}/documents/${d.id}/download`, d.fileName)}>⭳ Download</button></td></tr>))}</tbody></table>)}</div>
    {xml && (<Modal title={`CW XML · ${b.reference} ${b.cw1ShipmentRef ? "(UPDATE)" : "(NEW)"}`} width={760} onClose={() => setXml(null)} footer={<button className="btn btn-ghost" onClick={() => setXml(null)}>Close</button>}><pre className="cw-xml">{xml}</pre></Modal>)}
    {viewDoc && <DocViewer api={api} doc={viewDoc} contentPath={`/bookings/${id}/documents/${viewDoc.id}/content`} downloadPath={`/bookings/${id}/documents/${viewDoc.id}/download`} onClose={() => setViewDoc(null)} />}
  </div>);
}
