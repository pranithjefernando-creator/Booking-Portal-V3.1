import { getRole } from "../../src/rbac.js";
import { db, makeOrder, seed } from "../../src/db.js";
import { createApp } from "../../src/lib/http.js";
import bookingsRouter from "../../src/routes/bookings.js";
import approvalsRouter from "../../src/routes/approvals.js";
import importsRouter from "../../src/routes/imports.js";
import ordersRouter from "../../src/routes/orders.js";
import { createBookingPool } from "../../src/lib/bookingStore.js";
import { createAccessConfigurationStore } from "../../src/lib/accessConfigurationStore.js";

const schema = process.env.TEST_ACCESS_SCHEMA;
if (!/^access_approval_[a-f0-9]{32}$/.test(schema || "")) throw new Error("Invalid test access schema");
const pool = createBookingPool();
const scoped = {
  async connect() {
    const client = await pool.connect();
    return { query: (sql, params) => client.query(sql.replaceAll("portal_access_v1.", `${schema}.`), params), release: (error) => client.release(error) };
  }
};
const configurations = createAccessConfigurationStore(scoped);

seed();
const orderNo = process.env.TEST_ORDER_NO;
const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
db.orders.push(makeOrder({ id: orderId, source: "sql", orderNo, cwOrgCode: "LANKAENG" }));
const app = createApp();
app.use((req, res, next) => {
  req.user = req.header("x-test-other") ? { ...db.users[0], email: "other@example.invalid", role: "Manager", bookingOrgs: ["OTHER"], orderOrgs: ["LANKAENG"] } : db.users[0];
  req.accessRole = getRole(req.user.role);
  req.evaluateBookingApproval = (booking) => configurations.evaluateBookingApproval(booking);
  next();
});
app.get("/ready", (req, res) => res.json({ ok: true }));
app.use("/bookings", bookingsRouter);
app.use("/approvals", approvalsRouter);
app.use("/imports", importsRouter);
app.use("/orders", ordersRouter);
app.listen(Number(process.env.PORT), "127.0.0.1");
