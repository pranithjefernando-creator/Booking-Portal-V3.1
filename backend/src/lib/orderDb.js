import { db } from "../db.js";
import { orgLabel } from "../reference.js";

const env = process.env;
const safeTable = (v, fallback) => (/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(v || "") ? v : fallback);
const HEADER_TABLE = safeTable(env.ORDER_HEADER_TABLE, "sdb.ProjectY_OrderHeader");
const LINES_TABLE = safeTable(env.ORDER_LINES_TABLE, "sdb.ProjectY_OrderLines");
const HEADER_COLUMNS = ["OrderNumber", "OrderNumberSplit", "OrderDate", "OrderTransportMode", "ContainerMode", "SupplierCode", "BuyerCode", "ClientCode", "BookingConfRef", "AritziaSeason", "ShipToLocation", "Origin", "Destination", "LoadPort", "DischargePort", "BookingConfirmedDate", "OrderCreatedDate", "DateExFactoryEst", "ServiceLevel", "DateDepartEst", "DateCargoAvailableAct", "DateCanceledAct", "DateNDCEst", "DatePOApprovalEst", "DateDoNotShipBeforeEst", "A&FPODesc", "OrderStatusDescription", "IncoTerms", "Weight", "WeightUOM", "Volume", "VolumeUOM", "GoodsDescription", "SupplierFullName", "SupplierAddress1", "SupplierAddress2", "SupplierCity", "SupplierState", "SupplierPostCode", "SupplierCountryCode", "BuyerFullName", "BuyerAddress1", "BuyerAddress2", "BuyerCity", "BuyerState", "BuyerPostCode", "BuyerCountryCode", "ManufacturerFullName", "ManufacturerAddress1", "ManufacturerAddress2", "ManufacturerCity", "ManufacturerState", "ManufacturerPostCode", "ManufacturerCountryCode", "RecordCreatedUtc", "RecordUpdatedUtc"];
const LINE_COLUMNS = ["OrderNumber", "LineNumber", "PartNumber", "PartDescription", "OuterPacks", "OuterPacksType", "Weight", "WeightUOM", "Volume", "VolumeUOM", "CountryOfOrigin", "AdditionalInformation", "HSCode", "InnerPacks", "InnerPacksUOM", "OuterPackLength", "OuterPackHeight", "OuterPackWidth", "OuterPackUnitOfDimension", "PartAttrib1", "PartAttrib2", "LinePrice"];
// "Do not map / keep existing" fields are owned by the portal, so they survive each SQL refresh.
const APP_FIELDS = ["requiredDeliveryDate", "quantity", "cwShipmentNumber", "housebillNumber", "etd", "eta", "notes", "documents", "bookingId", "bookingRef", "updatedBy"];
const state = { source: "memory", count: 0, lines: 0, loadedAt: null, error: "" };
let sqlOrders = [];
let byId = new Map();
let inflight = null;

export function orderDbEnabled() { return Boolean(env.ORDER_DB_PASSWORD); }
export function orderDbStatus() { return { ...state }; }
export function isSqlOrder(o) { return o?.source === "sql"; }
export function allOrders() { return db.orders.concat(sqlOrders); }
export function findOrder(id) { return db.orders.find((o) => o.id === id) || byId.get(id); }

const text = (v) => (v == null ? "" : String(v).trim());
const num = (v) => (v == null || v === "" ? "" : Number(v));
const date = (v) => (v instanceof Date && !Number.isNaN(v.getTime()) ? v.toISOString().slice(0, 10) : "");
const address = (r, p) => [r[`${p}Address1`], r[`${p}Address2`], r[`${p}City`], r[`${p}State`], r[`${p}PostCode`], r[`${p}CountryCode`]].map(text).filter(Boolean).join(", ");

function transportMode(mode, containerMode) {
  const m = text(mode).toUpperCase();
  if (m === "AIR") return "Air";
  if (m === "SEA") return text(containerMode).toUpperCase() === "LCL" ? "Ocean LCL" : "Ocean FCL";
  if (m === "ROA") return text(containerMode).toUpperCase() === "LCL" ? "Road LTL" : "Road FTL";
  return text(mode);
}

function toLine(r) {
  return { id: `${text(r.OrderNumber)}-${r.LineNumber}`, lineNo: r.LineNumber ?? "", partNumber: text(r.PartNumber), partDescription: text(r.PartDescription), outerPacks: num(r.OuterPacks), outerPacksType: text(r.OuterPacksType), weight: num(r.Weight), weightUom: text(r.WeightUOM), volume: num(r.Volume), volumeUom: text(r.VolumeUOM), countryOfOrigin: text(r.CountryOfOrigin), additionalInformation: text(r.AdditionalInformation), hsCode: text(r.HSCode), innerPacks: num(r.InnerPacks), innerPacksUom: text(r.InnerPacksUOM), outerPackLength: num(r.OuterPackLength), outerPackHeight: num(r.OuterPackHeight), outerPackWidth: num(r.OuterPackWidth), outerPackDimensionUnit: text(r.OuterPackUnitOfDimension), partAttribute1: text(r.PartAttrib1), partAttribute2: text(r.PartAttrib2), itemPrice: num(r.LinePrice) };
}

function toOrder(h, lines) {
  const orderNo = text(h.OrderNumber);
  const supplierCode = text(h.SupplierCode), buyerCode = text(h.BuyerCode);
  return {
    id: `sql-${Buffer.from(orderNo).toString("base64url")}`, source: "sql", reference: orderNo, orderNo, orderNoSplit: h.OrderNumberSplit ? String(h.OrderNumberSplit) : "",
    orderDate: date(h.OrderDate), transportMode: transportMode(h.OrderTransportMode, h.ContainerMode), containerMode: text(h.ContainerMode),
    supplierCode, supplierName: orgLabel(supplierCode), buyerCode, buyerName: orgLabel(buyerCode), cwOrgCode: supplierCode,
    clientCode: text(h.ClientCode), bookingConfRef: text(h.BookingConfRef), aritziaSeason: text(h.AritziaSeason), shipToLocation: text(h.ShipToLocation),
    originCode: text(h.Origin), destCode: text(h.Destination), loadPort: text(h.LoadPort), dischargePort: text(h.DischargePort),
    bookingConfirmedDate: date(h.BookingConfirmedDate), orderCreatedDate: date(h.OrderCreatedDate), exFactoryEstDate: date(h.DateExFactoryEst), departureEstDate: date(h.DateDepartEst), cargoAvailableDate: date(h.DateCargoAvailableAct), cancelledDate: date(h.DateCanceledAct), ndcDate: date(h.DateNDCEst), poApprovalDate: date(h.DatePOApprovalEst), doNotShipBeforeDate: date(h.DateDoNotShipBeforeEst),
    afPoDescription: text(h["A&FPODesc"]), serviceLevel: text(h.ServiceLevel), status: text(h.OrderStatusDescription).toUpperCase() || "PENDING", incoTerms: text(h.IncoTerms),
    weight: num(h.Weight), weightUom: text(h.WeightUOM), volume: num(h.Volume), volumeUom: text(h.VolumeUOM), quantity: "", goodsDescription: text(h.GoodsDescription),
    supplier: { name: text(h.SupplierFullName), address: address(h, "Supplier") }, delivery: { name: text(h.BuyerFullName), address: address(h, "Buyer") }, manufacturer: { name: text(h.ManufacturerFullName), address: address(h, "Manufacturer") },
    requiredDeliveryDate: "", cwShipmentNumber: "", housebillNumber: "", etd: "", eta: "", notes: "", documents: [], bookingId: "", bookingRef: "",
    orderLines: lines, createdBy: "SQL", updatedBy: "SQL", createdAt: h.RecordCreatedUtc instanceof Date ? h.RecordCreatedUtc.toISOString() : "", updatedAt: h.RecordUpdatedUtc instanceof Date ? h.RecordUpdatedUtc.toISOString() : ""
  };
}

async function fetchOrders() {
  const { default: sql } = await import("mssql");
  let pool;
  try {
    pool = await new sql.ConnectionPool({
      server: env.ORDER_DB_SERVER || "sqldb4symphony.database.windows.net",
      database: env.ORDER_DB_NAME || "sqldb",
      user: env.ORDER_DB_USER || "ProjectY",
      password: env.ORDER_DB_PASSWORD,
      options: { encrypt: true },
      connectionTimeout: 15000,
      requestTimeout: 180000
    }).connect();
    const cols = (list) => list.map((c) => `[${c}]`).join(", ");
    const [{ recordset: headers }, { recordset: lineRows }] = await Promise.all([
      pool.request().query(`SELECT ${cols(HEADER_COLUMNS)} FROM ${HEADER_TABLE}`),
      pool.request().query(`SELECT ${cols(LINE_COLUMNS)} FROM ${LINES_TABLE} ORDER BY [OrderNumber], [LineNumber]`)
    ]);
    const linesByOrder = new Map();
    for (const r of lineRows) {
      const key = text(r.OrderNumber);
      if (!linesByOrder.has(key)) linesByOrder.set(key, []);
      linesByOrder.get(key).push(toLine(r));
    }
    return { orders: headers.filter((h) => text(h.OrderNumber)).map((h) => toOrder(h, linesByOrder.get(text(h.OrderNumber)) || [])), lines: lineRows.length };
  } finally {
    await pool?.close().catch(() => {});
  }
}

export function loadSqlOrders() {
  if (!orderDbEnabled()) return Promise.resolve(state);
  inflight ||= fetchOrders()
    .then(({ orders, lines }) => {
      for (const o of orders) {
        const prev = byId.get(o.id);
        if (prev) for (const k of APP_FIELDS) o[k] = prev[k];
      }
      sqlOrders = orders;
      byId = new Map(orders.map((o) => [o.id, o]));
      Object.assign(state, { source: "sql", count: orders.length, lines, loadedAt: new Date().toISOString(), error: "" });
      return state;
    })
    .catch((error) => {
      state.error = error.message;
      console.error(`Order SQL load failed: ${error.message}`);
      return state;
    })
    .finally(() => { inflight = null; });
  return inflight;
}

export function startSqlOrderRefresh() {
  if (!orderDbEnabled()) return;
  const timer = setInterval(loadSqlOrders, parseInt(env.ORDER_REFRESH_MS || String(15 * 60 * 1000), 10));
  timer.unref();
}
