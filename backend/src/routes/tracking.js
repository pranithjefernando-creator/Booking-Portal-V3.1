import { Router } from "../lib/http.js";
import { getTracking, trackingIdentity } from "../lib/trackingCache.js";
import { canTrackReference, requireTracking, shipmentEvents, trackingHistory, trackingOrganizations, trackingRecords } from "../lib/trackingAccess.js";
import { trackingDbStatus } from "../lib/trackingDb.js";
import { requirePermission } from "../rbac.js";

const router = Router();
router.get("/tracking/meta/organizations", requirePermission("admin.users"), async (req, res) => {
  res.json({ items: trackingOrganizations(await trackingRecords()) });
});
router.get("/tracking/shipments", requireTracking, async (req, res) => {
  const records = await trackingHistory(req.user);
  res.setHeader("Cache-Control", "private, no-store");
  const { source, loadedAt } = trackingDbStatus();
  res.json({ records, eventsByShipment: records.length ? await shipmentEvents(records) : {}, source, refreshedAt: loadedAt });
});
router.post("/tracking/lookup", requireTracking, async (req, res) => {
  try {
    const identity = trackingIdentity(req.body);
    if (!canTrackReference(await trackingHistory(req.user), identity)) return res.status(403).json({ error: "Tracking reference is outside your assigned tracking organizations" });
    res.json(await getTracking(req.body));
  } catch (error) {
    res.status(error.status === 401 ? 502 : error.status || 502).json({ error: error.message, code: error.code || "UPSTREAM_ERROR" });
  }
});
export default router;