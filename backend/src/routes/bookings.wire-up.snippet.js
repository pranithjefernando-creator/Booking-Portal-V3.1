// ============================================================================
// Wire-up in routes/bookings.js — use the mapped UPDATE payload for edits.
// The CW booking number goes into DataTargetCollection>DataTarget>Key.
// NO DataSourceCollection is sent.
// ============================================================================
//
// 1) Import both builders:
//    import { buildBookingXml, buildBookingUpdateXml } from "../lib/cwPayload.js";
//
// 2) pushToCw(): choose the payload; do NOT pass a dataSourceKey.
//
//    async function pushToCw(b, user, action) {
//      const isUpdate = !!b.cw1ShipmentRef;
//      const xml = isUpdate
//        ? buildBookingUpdateXml(b, b.cw1ShipmentRef)  // Key in DataTarget, no DataSource
//        : buildBookingXml(b);                         // create payload (no Key)
//      let cw;
//      try {
//        cw = await sendBookingToCw(xml, { isUpdate });   // <-- no dataSourceKey
//        b.cwStatus = cw.ok ? "SENT" : "FAILED"; b.cwHttpStatus = cw.status;
//        b.cwResponse = (cw.response || cw.error || "").slice(0, 20000); b.cwSentAt = new Date().toISOString();
//        b.cwLastAction = isUpdate ? "UPDATE" : "CREATE";
//        if (cw.cwBookingNumber) b.cw1ShipmentRef = cw.cwBookingNumber;
//      } catch (e) { cw = { ok:false, status:0, error:String(e.message||e), response:"" }; b.cwStatus="FAILED"; b.cwResponse=String(e.message||e); }
//      b.updatedAt = new Date().toISOString();
//      return { cw, isUpdate };
//    }
//
// 3) XML preview route:
//    router.get("/:id/cw-xml", requirePermission("booking.view"), (req, res) => {
//      const b = db.bookings.find((x) => x.id === req.params.id);
//      if (!b) return res.status(404).json({ error: "Booking not found" });
//      res.setHeader("Content-Type", "application/xml");
//      res.send(b.cw1ShipmentRef ? buildBookingUpdateXml(b, b.cw1ShipmentRef) : buildBookingXml(b));
//    });
//
// NOTE: If your cwClient.js mock builds a fake RESPONSE that contains <DataSourceCollection>,
//       that is only the simulated CW reply, not your outbound payload. To avoid confusion in
//       the "CargoWise Response" panel while in mock mode, you can delete the DataSourceCollection
//       substring from the mock response string in cwClient.js (sendMock). It does not affect apim.
