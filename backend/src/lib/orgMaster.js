import { applyOrgMaster } from "../reference.js";

const env = process.env;
const TABLE = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)?$/.test(env.ORG_DB_TABLE || "") ? env.ORG_DB_TABLE : "sdb.Orgdetails_ProjectY";
const state = { source: "static", count: 0, loadedAt: null, error: "" };

export function orgMasterStatus() { return { ...state }; }

export async function loadOrgMaster() {
  if (!env.ORG_DB_PASSWORD) return state;
  let pool;
  try {
    const { default: sql } = await import("mssql");
    pool = await new sql.ConnectionPool({
      server: env.ORG_DB_SERVER || "sqldb4symphony.database.windows.net",
      database: env.ORG_DB_NAME || "sqldb",
      user: env.ORG_DB_USER || "ProjectY",
      password: env.ORG_DB_PASSWORD,
      options: { encrypt: true },
      connectionTimeout: 15000,
      requestTimeout: 60000
    }).connect();
    const { recordset } = await pool.request().query(`SELECT [Organisation Code] AS code, [OrganisationName] AS name FROM ${TABLE}`);
    const rows = recordset.map((r) => ({ code: String(r.code || "").trim(), name: String(r.name || "").trim() })).filter((r) => r.code);
    if (!rows.length) throw new Error("Organisation master table returned no rows");
    applyOrgMaster(rows);
    Object.assign(state, { source: "sql", count: rows.length, loadedAt: new Date().toISOString(), error: "" });
  } catch (error) {
    state.error = error.message;
    console.error(`Organisation master load failed: ${error.message}`);
  } finally {
    await pool?.close().catch(() => {});
  }
  return state;
}

export function startOrgMasterRefresh() {
  const timer = setInterval(loadOrgMaster, parseInt(env.ORG_REFRESH_MS || String(60 * 60 * 1000), 10));
  timer.unref();
}
