import { db, makeOrder, seed } from "../../src/db.js";
import { createApp } from "../../src/lib/http.js";
import bookingsRouter from "../../src/routes/bookings.js";
import approvalsRouter from "../../src/routes/approvals.js";
import importsRouter from "../../src/routes/imports.js";
import ordersRouter from "../../src/routes/orders.js";

seed();
const orderNo = process.env.TEST_ORDER_NO;
const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
db.orders.push(makeOrder({ id: orderId, source: "sql", orderNo, cwOrgCode: "LANKAENG" }));
const app = createApp();
app.use((req, res, next) => {
  req.user = req.header("x-test-other") ? { ...db.users[0], email: "other@example.invalid", role: "Manager", bookingOrgs: ["OTHER"], orderOrgs: ["LANKAENG"] } : db.users[0];
  next();
});
app.get("/ready", (req, res) => res.json({ ok: true }));
app.use("/bookings", bookingsRouter);
app.use("/approvals", approvalsRouter);
app.use("/imports", importsRouter);
app.use("/orders", ordersRouter);
app.listen(Number(process.env.PORT), "127.0.0.1");
