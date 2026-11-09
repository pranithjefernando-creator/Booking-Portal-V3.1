const env = process.env;
const TABLE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(env.TRACKING_DB_TABLE || "") ? env.TRACKING_DB_TABLE : "sdb.Shipment_with_Routing_Legs";
const TTL_MS = parseInt(env.TRACKING_REFRESH_MS || String(5 * 60 * 1000), 10);
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const state = { source: "csv", count: 0, loadedAt: null, error: "" };
let cache = null;
let inflight = null;

export function trackingDbEnabled() { return Boolean(env.TRACKING_DB_PASSWORD); }
export function trackingDbStatus() { return { ...state }; }

// Dates are rendered as DD-Mon-YY so records look identical to the CSV dataset the UI already parses.
function cell(value) {
  if (value == null) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : `${String(value.getUTCDate()).padStart(2, "0")}-${MONTHS[value.getUTCMonth()]}-${String(value.getUTCFullYear()).slice(-2)}`;
  return String(value).trim();
}

async function fetchRows() {
  const { default: sql } = await import("mssql");
  let pool;
  try {
    pool = await new sql.ConnectionPool({
      server: env.TRACKING_DB_SERVER || "sqldb4symphony.database.windows.net",
      database: env.TRACKING_DB_NAME || "sqldb",
      user: env.TRACKING_DB_USER || "ProjectY",
      password: env.TRACKING_DB_PASSWORD,
      options: { encrypt: true },
      connectionTimeout: 15000,
      requestTimeout: 120000
    }).connect();
    const { recordset } = await pool.request().query(`SELECT * FROM ${TABLE}`);
    return recordset.map((row) => {
      const record = {};
      for (const [key, value] of Object.entries(row)) record[key.trim()] = cell(value);
      // The SQL table renames/misspells a few columns relative to the sample CSV.
      if (!record["Shipment ID"] && record.ShipmentID) record["Shipment ID"] = record.ShipmentID;
      return record;
    });
  } finally {
    await pool?.close().catch(() => {});
  }
}

// Returns SQL rows (cached), or null when SQL is not configured or unavailable so callers can fall back to the CSV.
export async function sqlTrackingRecords() {
  if (!trackingDbEnabled()) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.records;
  inflight ||= fetchRows()
    .then((records) => {
      cache = { at: Date.now(), records };
      Object.assign(state, { source: "sql", count: records.length, loadedAt: new Date().toISOString(), error: "" });
      return records;
    })
    .catch((error) => {
      state.error = error.message;
      console.error(`Tracking SQL load failed: ${error.message}`);
      return cache?.records || null;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
