import { db, seed } from "../../src/db.js";
import { getRole } from "../../src/rbac.js";
import { createApp } from "../../src/lib/http.js";
import bookingsRouter from "../../src/routes/bookings.js";
import approvalsRouter from "../../src/routes/approvals.js";
import ordersRouter from "../../src/routes/orders.js";
import miscRouter from "../../src/routes/misc.js";

seed();
const app = createApp();
app.use((req, res, next) => {
  req.user = db.users[0];
  req.accessRole = req.header("x-test-deny") ? { permissions: [], modules: [] } : getRole(req.user.role);
  req.evaluateBookingApproval = async () => ["Test approval"];
  next();
});
app.get("/ready", (req, res) => res.json({ ok: true }));
app.use("/bookings", bookingsRouter);
app.use("/approvals", approvalsRouter);
app.use("/orders", ordersRouter);
app.use("/", miscRouter);
app.listen(Number(process.env.PORT), "127.0.0.1");
