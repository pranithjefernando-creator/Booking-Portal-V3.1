import fs from "fs"; import path from "path"; import { fileURLToPath } from "url";
import { sendBookingToCw } from "./src/lib/cwClient.js";
import { cwPublicConfig } from "./src/lib/config.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] || path.join(__dirname, "..", "samples", "Booking_Payload.xml");
if (!fs.existsSync(file)) { console.error("XML file not found:", file); process.exit(1); }
const xml = fs.readFileSync(file, "utf8");
console.log("CW config:", JSON.stringify(cwPublicConfig(), null, 2));
console.log("\nPayload file:", file, `(${xml.length} bytes)`);
const res = await sendBookingToCw(xml, null);
console.log("\n=== CW RESPONSE ===");
console.log("mode:", res.mode, "| ok:", res.ok, "| httpStatus:", res.status, "| cwBookingNumber:", res.cwBookingNumber || "(none)");
if (res.error) console.log("error:", res.error);
console.log("\nbody:\n" + (res.response || "(empty)"));
