import { getRole } from "../../src/rbac.js";
import { db, makeOrder, seed } from "../../src/db.js";
import { createApp } from "../../src/lib/http.js";
import bookingsRouter from "../../src/routes/bookings.js";
import ordersRouter from "../../src/routes/orders.js";

seed();
db.roles.BookingOnly = { permissions: ["booking.view"], modules: ["bookings"] };
db.roles.OrderOnly = { permissions: ["order.view", "order.create"], modules: ["orders"] };
const orderNo = process.env.TEST_ORDER_NO;
const orderId = `sql-${Buffer.from(orderNo).toString("base64url")}`;
function refreshOrder() {
  const index = db.orders.findIndex((order) => order.id === orderId);
  const order = makeOrder({ id: orderId, source: "sql", orderNo, cwOrgCode: "TESTCO" });
  if (index < 0) db.orders.push(order);
  else db.orders[index] = order;
}
refreshOrder();

const app = createApp();
app.use((req, res, next) => {
  req.user = req.header("x-test-scope") === "booking-only"
    ? { ...db.users[3], role: "BookingOnly", bookingOrgs: ["TESTCO"], orderOrgs: ["TESTCO"] }
    : req.header("x-test-scope") === "order-only"
      ? { ...db.users[3], role: "OrderOnly", bookingOrgs: ["TESTCO"], orderOrgs: ["TESTCO"] }
      : req.header("x-test-scope") === "restricted"
    ? { ...db.users[3], bookingOrgs: ["OTHER"], orderOrgs: ["TESTCO"] }
    : req.header("x-test-scope") === "order-restricted"
      ? { ...db.users[3], bookingOrgs: ["TESTCO"], orderOrgs: ["OTHER"] }
      : db.users[0];
  req.accessRole = getRole(req.user.role);
  next();
});
app.get("/ready", (req, res) => res.json({ ok: true }));
app.post("/refresh", (req, res) => { refreshOrder(); res.json({ ok: true }); });
app.use("/orders", ordersRouter);
app.use("/bookings", bookingsRouter);
app.listen(Number(process.env.PORT));
