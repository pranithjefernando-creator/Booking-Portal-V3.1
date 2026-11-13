export function apiReadiness(checkBooking, checkUserAccess) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const checks = [
      { key: "bookingDatabase", label: "Booking", check: checkBooking },
      { key: "userAccessDatabase", label: "User access", check: checkUserAccess }
    ];
    const results = await Promise.allSettled(checks.map(({ check }) => Promise.resolve().then(check)));
    const status = {};
    for (const [index, result] of results.entries()) {
      const { key, label } = checks[index];
      status[key] = result.status === "fulfilled" ? "ready" : "unavailable";
      if (result.status === "rejected") console.error(`${label} PostgreSQL readiness check failed: ${result.reason?.message || String(result.reason)}`);
    }
    const ready = results.every((result) => result.status === "fulfilled");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", service: "SBMS API", ...status, time: new Date().toISOString() });
  };
}
