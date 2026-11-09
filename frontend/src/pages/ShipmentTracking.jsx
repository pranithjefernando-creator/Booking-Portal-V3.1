import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LifecycleProgress, PageBanner } from "../components/ui.jsx";
import { IconAnchor, IconBox, IconCal, IconChevron, IconShip } from "../components/icons.jsx";
import { displayValue, loadTrackingData, mappingName, shipmentLifecycle, trackingRequestFor, trackingEventDateTime, trackingRefreshedAt, withLiveTracking, UNAVAILABLE } from "../trackingData.js";
import { api } from "../api.js";

const tabs = ["Overview", "Containers", "Events"];

export default function ShipmentTracking() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState("Overview");
  const [shipments, setShipments] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [live, setLive] = useState(null);
  const [trackingState, setTrackingState] = useState("");
  const [containerSelection, setContainerSelection] = useState({ shipmentId: "", number: "" });
  const [now] = useState(() => new Date());
  useEffect(() => { loadTrackingData().then(setShipments).catch((error) => setLoadError(error.message)).finally(() => setLoaded(true)); }, []);
  const baseShipment = shipments.find((item) => item.id === id);
  const trackingRequest = trackingRequestFor(baseShipment);
  const updating = trackingState === "Loading carrier tracking...";
  async function updateLocation() {
    if (!trackingRequest || updating) return;
    const shipmentId = baseShipment.id;
    setTrackingState("Loading carrier tracking...");
    try {
      const response = await api.post("/tracking/lookup", trackingRequest);
      setLive({ shipmentId, response });
      setTrackingState("");
    } catch (error) { setTrackingState(`Carrier tracking unavailable: ${error.message}`); }
  }
  const shipment = live && live.shipmentId === baseShipment?.id ? withLiveTracking(baseShipment, live.response) : baseShipment;
  if (!shipment) return <div className="page wide shipment-detail-page"><PageBanner title="Shipment Tracking" /><div className="card shipment-tab-placeholder"><IconShip size={28} /><h2>{loadError || (loaded ? "Shipment unavailable in your tracking scope" : "Loading shipment data")}</h2></div></div>;
  const unavailableField = (field) => <span title={mappingName(shipment[field])}>{displayValue(shipment[field])}</span>;
  const containerField = (value) => <span className={value === "Unknown" ? "unknown-tag" : ""}>{value}</span>;
  const lifecycle = shipmentLifecycle(shipment, now);
  const lifecycleDate = (value) => value && value !== UNAVAILABLE ? value : "Unknown";
  const selectedContainer = (containerSelection.shipmentId === shipment.id && shipment.containers.find((container) => container.number === containerSelection.number)) || shipment.containers[0];

  return (
    <div className="page wide shipment-detail-page">
      <PageBanner title="Shipment Tracking" subtitle="Review shipment milestones and predicted arrival." />
      <div className="shipment-detail-head">
        <div className="shipment-heading"><button className="shipment-back" onClick={() => navigate("/tracking/shipments")} aria-label="Back to shipment search">←</button><div><p className="tracking-eyebrow">SHIPMENT TRACKING <span>•</span> {shipment.liveTracking ? "PANVAYA" : "CARGOWISE"}</p><h1>Shipment #{shipment.id}</h1><p className="shipment-route">{shipment.route}</p></div><span className="shipment-badge green">{unavailableField("status")}</span><span className="shipment-badge blue">{shipment.mode}</span><span className="shipment-badge blue">{shipment.load}</span></div>
      </div>
      {trackingState && <p className="muted" role="status">{trackingState}</p>}
      <section className="tracking-location-controls" aria-label="Carrier location report">
        <button type="button" className="btn btn-outline" onClick={updateLocation} disabled={updating || !trackingRequest}><IconShip size={16} />{updating ? "Updating..." : "Update location"}</button>
        {!trackingRequest && baseShipment && <span className="muted" role="status">No carrier tracking reference available.</span>}
      </section>
      {shipment.liveTracking && <p className="muted" role="status">Panvaya {shipment.liveTracking.cached ? "cached" : "fetched"} at {formatTrackingTimestamp(shipment.liveTracking.cachedAt)}</p>}
      <section className="tracking-lifecycle card" aria-label="Shipment lifecycle">
        <div className="tracking-lifecycle-head"><div><span className="tracking-overline">SHIPMENT LIFECYCLE</span><h2>{shipment.id}</h2><p>{shipment.container} · {shipment.hbl} · {shipment.reference}</p></div><div className="tracking-lifecycle-summary"><span className="tracking-lifecycle-status">{lifecycle.status}</span><small>Estimated Arrival</small><strong>{lifecycleDate(shipment.etaDate || shipment.eta)}</strong></div></div>
        <LifecycleProgress lifecycle={lifecycle} dateFormatter={lifecycleDate} />
        <button className="btn btn-outline tracking-lifecycle-action" onClick={() => navigate("/tracking/shipments")}>Back to shipment search</button>
      </section>
      <nav className="shipment-tabs" aria-label="Shipment detail sections">{tabs.map((tab) => <button className={activeTab === tab ? "active" : ""} key={tab} onClick={() => setActiveTab(tab)}>{tab}</button>)}</nav>
      {activeTab === "Overview" ? <>
        <section className="shipment-detail-grid">
          <div className="card shipment-eta-card"><div className="shipment-card-title"><div><span className="tracking-overline">PREDICTED ARRIVAL</span><h2><IconCal size={25} /> {shipment.etaDate || shipment.eta}</h2><strong>{unavailableField("etaTime")}</strong></div></div><div className="shipment-confidence"><span>ETA confidence</span><b>{unavailableField("confidence")}</b><div><i style={{ width: "0%" }} /></div></div><dl className="shipment-eta-list"><dt>Original ETA</dt><dd>{unavailableField("originalEta")}</dd><dt>Carrier ETA</dt><dd>{shipment.etaDate || shipment.carrierEta}</dd></dl></div>
          <div className="card shipment-info-card"><div className="shipment-card-title"><div><span className="tracking-overline">REFERENCE DATA</span><h2>Shipment Information</h2></div><IconBox size={19} /></div><dl className="shipment-info-list"><dt>Consignee</dt><dd>{shipment.consignee}</dd><dt>Shipper</dt><dd>{shipment.shipper}</dd><dt>Booking No.</dt><dd>{shipment.booking}</dd><dt>HBL</dt><dd>{shipment.hbl}</dd><dt>Containers</dt><dd>{shipment.container}</dd><dt>Cargo</dt><dd>{shipment.cargo}</dd><dt>Weight</dt><dd>{shipment.weight}</dd><dt>Volume</dt><dd>{shipment.volume}</dd></dl></div>
        </section>
      </> : activeTab === "Events" ? <section className="card shipment-events" aria-label="Shipment events">
        <div className="shipment-card-title"><div><span className="tracking-overline">SHIPMENT EVENTS</span><h2>Event Details</h2></div><span className="shipment-badge blue">{shipment.events.length} events</span></div>
        {shipment.events.length ? <div className="shipment-events-scroll"><table className="shipment-events-table"><thead><tr><th>Seq</th><th>Date / Time</th><th>Event</th><th>Description</th><th>Location</th></tr></thead><tbody>{shipment.events.map((event, index) => <tr key={event.key || `${event.seq}-${event.datetime}`}><td>{index + 1}</td><td>{trackingEventDateTime(event)}{event.actual === false ? " (planned)" : ""}</td><td><strong>{event.type}</strong></td><td>{event.description || "-"}</td><td>{event.location || "-"}</td></tr>)}</tbody></table></div> : <p className="muted">No events available for this shipment.</p>}
        <button className="btn btn-outline container-back-button" onClick={() => setActiveTab("Overview")}>Back to overview <IconChevron size={16} /></button>
      </section> : <section className="shipment-containers">
        {!shipment.containers.length && <p className="muted">No containers available for this shipment.</p>}
        {shipment.containers.length > 1 && <div className="shipment-container-selector"><label htmlFor="shipment-container-select">Container<select id="shipment-container-select" value={selectedContainer.number} onChange={(event) => setContainerSelection({ shipmentId: shipment.id, number: event.target.value })}>{shipment.containers.map((container) => <option key={container.number} value={container.number}>{container.number}</option>)}</select></label><span className="muted">{shipment.containers.length} containers</span></div>}
        {selectedContainer && [selectedContainer].map((container) => <article className="card container-detail-card" key={container.number}>
          <div className="container-detail-copy">
            <div className="shipment-card-title"><div><span className="tracking-overline">CONTAINER {shipment.containers.indexOf(container) + 1} OF {shipment.containers.length}</span><h2>{container.number}</h2></div><span className="shipment-badge blue">{container.typeCode}</span></div>
            <dl className="shipment-info-list container-info-list"><dt>Container type</dt><dd>{containerField(container.type)}</dd><dt>Description</dt><dd>{containerField(container.description)}</dd><dt>ISO code</dt><dd>{containerField(container.iso)}</dd><dt>ISO description</dt><dd>{containerField(container.isoDescription)}</dd><dt>Dimensions</dt><dd>{containerField(container.dimensions)}</dd><dt>Capacity</dt><dd>{containerField(container.capacity)}{container.capacity !== "Unknown" && " m³"}</dd><dt>Max gross weight</dt><dd>{containerField(container.grossWeight)}</dd><dt>Tare weight</dt><dd>{containerField(container.tareWeight)}</dd><dt>Container count</dt><dd>{containerField(container.count)}</dd><dt>TEU</dt><dd>{containerField(container.teu)}</dd><dt>Customs status</dt><dd>{containerField(container.status)}</dd><dt>Vessel / voyage</dt><dd>{containerField(container.vessel)}</dd><dt>Route</dt><dd>{containerField(container.route)}</dd><dt>Cargo</dt><dd>{containerField(container.cargo)}</dd><dt>Weight</dt><dd>{containerField(container.weight)}</dd><dt>Volume</dt><dd>{containerField(container.volume)}</dd></dl>
          </div>
          <div className="container-detail-visual"><img src="/container-visual.svg" alt="Freight container" /><p>Container image</p></div>
        </article>)}
        <button className="btn btn-outline container-back-button" onClick={() => setActiveTab("Overview")}>Back to overview <IconChevron size={16} /></button>
      </section>}
      <div className="tracking-footer-note"><IconAnchor size={17} /><span>{shipment.liveTracking ? "Carrier events and status: Panvaya. Shipment references: CargoWise." : "Shipment references and events: CargoWise."}{trackingRefreshedAt() ? ` Data last refreshed: ${trackingRefreshedAt()}.` : ""}</span></div>
    </div>
  );
}

function formatTrackingTimestamp(value) { return new Date(value).toLocaleString(); }
