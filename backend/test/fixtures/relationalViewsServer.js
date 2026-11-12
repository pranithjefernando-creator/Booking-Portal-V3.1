import { db, seed } from "../../src/db.js";
import { createApp } from "../../src/lib/http.js";
import bookingsRouter from "../../src/routes/bookings.js";
import ordersRouter from "../../src/routes/orders.js";
import miscRouter from "../../src/routes/misc.js";

seed();
const user = { ...db.users[2], email: process.env.TEST_USER_EMAIL, bookingOrgs: [process.env.TEST_BOOKING_ORG] };
db.bookings.push({ id: "in-memory-decoy", cwOrgCode: process.env.TEST_BOOKING_ORG, status: "DRAFT" });
const app = createApp();
app.use((req, res, next) => {
  req.user = req.header("x-other") ? { ...user, email: process.env.TEST_OTHER_EMAIL } : user;
  next();
});
app.get("/ready", (req, res) => res.json({ ok: true }));
app.use("/bookings", bookingsRouter);
app.use("/orders", ordersRouter);
app.use("/", miscRouter);
app.listen(Number(process.env.PORT), "127.0.0.1");
