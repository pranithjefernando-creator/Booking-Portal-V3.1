import { createApp } from "./src/lib/http.js";
import { seed } from "./src/db.js";
import bookingsRouter from "./src/routes/bookings.js";
import approvalsRouter from "./src/routes/approvals.js";
import importsRouter from "./src/routes/imports.js";
import ordersRouter from "./src/routes/orders.js";
import miscRouter from "./src/routes/misc.js";
import portCongestionRouter from "./src/routes/portCongestion.js";
import trackingRouter from "./src/routes/tracking.js";
import { cwPublicConfig } from "./src/lib/config.js";
import { sqlTrackingRecords } from "./src/lib/trackingDb.js";
import { loadSqlOrders, startSqlOrderRefresh } from "./src/lib/orderDb.js";
import { loadOrgMaster, startOrgMasterRefresh } from "./src/lib/orgMaster.js";
import { checkBookingDatabase, closeBookingDatabase, initializeBookingDatabase } from "./src/lib/bookingDatabase.js";
import { checkUserAccessDatabase, closeUserAccessDatabase, initializeUserAccessDatabase, userAccessServices } from "./src/lib/userAccessDatabase.js";
import { apiReadiness } from "./src/lib/apiReadiness.js";
import { createPostgresSessionRouter } from "./src/lib/postgresSessionRoutes.js";
import { startPortCongestionRetries } from "./src/lib/portCongestionCache.js";
async function closeDatabases() {
  const results = await Promise.allSettled([closeBookingDatabase(), closeUserAccessDatabase()]);
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      console.error(`${index === 0 ? "Booking" : "User access"} database shutdown failed: ${result.reason?.message || String(result.reason)}`);
      process.exitCode = 1;
    }
  }
}
try {
  await initializeBookingDatabase();
  console.log("Booking PostgreSQL schema initialized and verified.");
} catch (error) {
  console.error(`Booking PostgreSQL startup failed: ${error.message}`);
  process.exitCode = 1;
}
if (!process.exitCode) {
  try {
    await initializeUserAccessDatabase();
    console.log("User access PostgreSQL schema and services initialized and verified.");
  } catch (error) {
    console.error(`User access PostgreSQL startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}
if (process.exitCode) {
  await closeDatabases();
  process.exit(process.exitCode);
}
const app = createApp(); const PORT = process.env.PORT || 4000;
seed();
const access = userAccessServices();
app.get("/api/health", (req, res) => res.json({ status: "ok", service: "SBMS API", cw: cwPublicConfig(), time: new Date().toISOString() }));
app.get("/api/ready", apiReadiness(checkBookingDatabase, checkUserAccessDatabase));
app.post("/api/auth/login", access.authHandlers.login);
const v1 = createPostgresSessionRouter(access);
v1.use("/bookings", bookingsRouter); v1.use("/approvals", approvalsRouter); v1.use("/imports", importsRouter); v1.use("/orders", ordersRouter); v1.use("/", miscRouter); v1.use("/", portCongestionRouter);
v1.use("/", trackingRouter);
app.use("/api/v1", v1);
const server = app.listen(PORT, () => { const cw = cwPublicConfig(); console.log(`SBMS API on http://localhost:${PORT}  (CW: ${cw.mode}/${cw.authMode})`); });
const stopPortCongestionRetries = startPortCongestionRetries();
sqlTrackingRecords().then((rows) => console.log(rows ? `Tracking data loaded from SQL: ${rows.length} shipments` : "Tracking data: using Tracking - Sample Dataset.csv (set TRACKING_DB_PASSWORD to use Azure SQL)"));
loadOrgMaster().then((om) => { if (om.source === "sql") console.log(`Organisation master loaded: ${om.count} orgs`); startOrgMasterRefresh(); });
loadSqlOrders().then((s) => { console.log(s.source === "sql" ? `Orders loaded from SQL: ${s.count} orders, ${s.lines} lines` : "Orders: in-memory only (set ORDER_DB_PASSWORD to use Azure SQL)"); startSqlOrderRefresh(); });
function shutdown(signal) { console.log(`${signal} received; shutting down`); server.close(async (err) => { if (err) { console.error(err); process.exitCode = 1; } await stopPortCongestionRetries(); await closeDatabases(); }); }
process.once("SIGTERM", () => shutdown("SIGTERM")); process.once("SIGINT", () => shutdown("SIGINT"));
