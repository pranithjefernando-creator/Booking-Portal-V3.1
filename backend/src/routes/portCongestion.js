import { Router } from "../lib/http.js";
import { getPortCongestion, cacheStats } from "../lib/portCongestionCache.js";
import { historicalPorts, requireTracking, trackingHistory } from "../lib/trackingAccess.js";

const router = Router();
const MAX_PORTS = 60;

router.get("/port-congestion/history", requireTracking, async (req, res) => {
  res.setHeader("Cache-Control", "private, no-store");
  res.json({ ports: historicalPorts(await trackingHistory(req.user)) });
});

router.post("/port-congestion/lookup", requireTracking, async (req, res) => {
  const requested = Array.isArray(req.body?.ports) ? req.body.ports : [];
  if (!requested.length) return res.status(400).json({ error: "Provide at least one UNLOCO port code" });
  const codes = [...new Set(requested.map((p) => String(p || "").trim().toUpperCase()).filter(Boolean))].slice(0, MAX_PORTS);
  if (!codes.length) return res.status(400).json({ error: "No valid port codes supplied" });
  try {
    const allowed = new Set(historicalPorts(await trackingHistory(req.user)));
    if (codes.some((code) => !allowed.has(code))) return res.status(403).json({ error: "Port is outside your assigned tracking shipment history" });
    const ports = await getPortCongestion(codes);
    res.json({ asOf: new Date().toISOString(), ports });
  } catch (e) {
    res.status(502).json({ error: "Unable to retrieve port congestion data", detail: e.message });
  }
});

router.get("/port-congestion/status", requireTracking, (req, res) => res.json(cacheStats()));

export default router;
