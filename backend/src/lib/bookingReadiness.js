export function bookingReadiness(check) {
  return async (req, res) => {
    try {
      await check();
      res.json({ status: "ready", service: "SBMS API", bookingDatabase: "ready", time: new Date().toISOString() });
    } catch (error) {
      console.error(`Booking PostgreSQL readiness check failed: ${error.message}`);
      res.status(503).json({ status: "not_ready", service: "SBMS API", bookingDatabase: "unavailable", time: new Date().toISOString() });
    }
  };
}
