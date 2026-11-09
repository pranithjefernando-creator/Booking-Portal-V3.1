import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageBanner, Pagination } from "../components/ui.jsx";
import { usePagination } from "../lib/pagination.js";
import { IconBox, IconSearch } from "../components/icons.jsx";
const MODE_OPTIONS = ["All modes", "Ocean", "Air", "Road"];
import { isArrived, isBooked, isDeparted, isInTransit, isWithinNextDays, loadTrackingData, searchableShipmentText, shipmentLifecycle, trackingRefreshedAt } from "../trackingData.js";

export default function ShipmentSearch() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const cardFilter = searchParams.get("card") || "";
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("All statuses");
  const [mode, setMode] = useState("All modes");
  const [customer, setCustomer] = useState("");
  const [shipments, setShipments] = useState([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const now = new Date();

  useEffect(() => { loadTrackingData().then(setShipments).catch((loadError) => setError(loadError.message)).finally(() => setLoaded(true)); }, []);

  const results = useMemo(() => shipments.filter((shipment) => {
    const term = query.trim().toLowerCase();
    const matchesQuery = !term || searchableShipmentText(shipment).includes(term) || Object.values(shipment).some((value) => String(value?.value || value).toLowerCase().includes(term));
    const matchesStatus = status === "All statuses" || shipmentLifecycle(shipment, now).status === status;
    const matchesMode = mode === "All modes" || shipment.mode === mode;
    const matchesCustomer = !customer || shipment.consignee === customer;
    const matchesCard = cardFilter === "booked" ? isBooked(shipment) : cardFilter === "departed" ? isDeparted(shipment, now) : cardFilter === "transit" ? isInTransit(shipment, now) : cardFilter === "arrived" ? isArrived(shipment, now) : cardFilter === "arriving-next-7" ? isWithinNextDays(shipment.eta) : true;
    return matchesQuery && matchesStatus && matchesMode && matchesCustomer && matchesCard;
  }), [shipments, query, status, mode, customer, cardFilter]);
  const pagination = usePagination(results, JSON.stringify([query, status, mode, customer, cardFilter]));

  const reset = () => { setQuery(""); setStatus("All statuses"); setMode("All modes"); setCustomer(""); setSearchParams({}); };
  const cardLabel = { active: "Active Shipments", booked: "Booked", departed: "Departed", transit: "Transit", "arriving-next-7": "Arriving Next 7 Days", arrived: "Arrived" }[cardFilter];
  const statusClass = (value) => value.toLowerCase().replace(" ", "-");

  return (
    <div className="page wide shipment-search-page">
      <PageBanner title="Shipment Tracking" subtitle="Search and monitor shipment milestones." />
      {loaded && !error && shipments.length === 0 && <p role="status">No shipments in your tracking scope.</p>}
      <section className="card shipment-filter-card"><div className="shipment-filter-title"><div><h2>Find a shipment</h2><p>{cardLabel ? `Showing shipments linked to ${cardLabel}.` : "Use any reference, customer, route, or tracking number."}</p></div><button className="btn btn-ghost btn-sm" onClick={reset}>Reset filters</button></div><div className="shipment-filter-grid"><label className="shipment-search-input"><IconSearch size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search shipment, container, customer..." aria-label="Search shipments" /></label><select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filter by tracking status"><option>All statuses</option>{[...new Set(shipments.map((shipment) => shipmentLifecycle(shipment, now).status))].map((option) => <option key={option}>{option}</option>)}</select><select value={mode} onChange={(event) => setMode(event.target.value)} aria-label="Filter by mode">{MODE_OPTIONS.map((option) => <option key={option}>{option}</option>)}</select><select value={customer} onChange={(event) => setCustomer(event.target.value)} aria-label="Filter by customer"><option value="">All consignees</option>{[...new Set(shipments.map((shipment) => shipment.consignee))].map((option) => <option key={option}>{option}</option>)}</select></div></section>
      {error ? <div className="card shipment-empty"><h3>Unable to load shipments</h3><p>{error}</p></div> : <section className="card shipment-results-card"><div className="shipment-results-head"><div><span className="tracking-overline">SEARCH RESULTS</span><h2>Shipments</h2></div><span className="shipment-results-count">{results.length} of {shipments.length}</span></div>{results.length === 0 ? <div className="shipment-empty"><IconBox size={28} /><h3>{!loaded ? "Loading shipments..." : shipments.length ? "No shipments found" : "No linked historical shipments"}</h3>{shipments.length > 0 && <><p>Try a different search term or reset the filters.</p><button className="btn btn-outline" onClick={reset}>Clear filters</button></>}</div> : <div className="scroll-x"><table className="table shipment-results-table"><thead><tr><th>Shipment ID</th><th>Consignee</th><th>Route</th><th>Mode</th><th>Tracking Status</th><th>ETA</th><th>Carrier</th></tr></thead><tbody>{pagination.items.map((shipment) => { const trackingStatus = shipmentLifecycle(shipment, now).status; return <tr className="clickable" key={shipment.id} onClick={() => navigate(`/tracking/shipment/${shipment.id}`)}><td><strong className="shipment-ref">{shipment.id}</strong><small>{shipment.container}</small></td><td>{shipment.consignee}</td><td>{shipment.route}</td><td><span className={`shipment-mode ${shipment.mode.toLowerCase()}`}>{shipment.mode}</span></td><td><span className={`shipment-status ${statusClass(trackingStatus)}`}>{trackingStatus}</span></td><td>{shipment.eta}</td><td>{shipment.vessel}</td></tr>; })}</tbody></table></div>}<Pagination pagination={pagination} label="Shipments" /></section>}
      <div className="tracking-footer-note"><IconBox size={17} /><span>{trackingRefreshedAt() ? `Data last refreshed: ${trackingRefreshedAt()}. ` : "Sample rows come from Tracking - Sample Dataset.csv. "}Unavailable fields remain mapped as Not Available Now.</span></div>
    </div>
  );
}
