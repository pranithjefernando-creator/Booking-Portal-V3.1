import { createApp, Router } from "./src/lib/http.js";
import { seed } from "./src/db.js";
import { authMiddleware, login, setPassword, generatePassword } from "./src/auth.js";
import { db } from "./src/db.js";
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
const app = createApp(); const PORT = process.env.PORT || 4000;
seed();
// Seed users get a shared password from SEED_DEFAULT_PASSWORD, or a one-time random password printed to the console.
for (const u of db.users) { const pw = process.env.SEED_DEFAULT_PASSWORD || generatePassword(); setPassword(u.id, pw, false); if (!process.env.SEED_DEFAULT_PASSWORD) console.log(`Seed login  ${u.email}  ${pw}`); }
app.get("/api/health", (req, res) => res.json({ status: "ok", service: "SBMS API", cw: cwPublicConfig(), time: new Date().toISOString() }));
app.get("/api/ready", (req, res) => res.json({ status: "ready", service: "SBMS API", time: new Date().toISOString() }));
app.post("/api/auth/login", login);
const v1 = Router(); v1.use(authMiddleware);
v1.use("/bookings", bookingsRouter); v1.use("/approvals", approvalsRouter); v1.use("/imports", importsRouter); v1.use("/orders", ordersRouter); v1.use("/", miscRouter); v1.use("/", portCongestionRouter);
v1.use("/", trackingRouter);
app.use("/api/v1", v1);
const server = app.listen(PORT, () => { const cw = cwPublicConfig(); console.log(`SBMS API on http://localhost:${PORT}  (CW: ${cw.mode}/${cw.authMode})`); });
sqlTrackingRecords().then((rows) => console.log(rows ? `Tracking data loaded from SQL: ${rows.length} shipments` : "Tracking data: using Tracking - Sample Dataset.csv (set TRACKING_DB_PASSWORD to use Azure SQL)"));
loadOrgMaster().then((om) => { if (om.source === "sql") console.log(`Organisation master loaded: ${om.count} orgs`); startOrgMasterRefresh(); });
loadSqlOrders().then((s) => { console.log(s.source === "sql" ? `Orders loaded from SQL: ${s.count} orders, ${s.lines} lines` : "Orders: in-memory only (set ORDER_DB_PASSWORD to use Azure SQL)"); startSqlOrderRefresh(); });
function shutdown(signal) { console.log(`${signal} received; shutting down`); server.close((err) => { if (err) { console.error(err); process.exitCode = 1; } else process.exitCode = 0; }); }
process.once("SIGTERM", () => shutdown("SIGTERM")); process.once("SIGINT", () => shutdown("SIGINT"));
