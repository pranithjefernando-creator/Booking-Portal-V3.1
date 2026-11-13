export async function sendBookingToCw(xml, options = {}) {
  if (xml.includes("AUDIT-DELAY")) await new Promise((resolve) => setTimeout(resolve, 8000));
  if (xml.includes("AUDIT-UNCERTAIN")) return { ok: false, status: 0, mode: "mock", error: "Simulated timeout", response: "" };
  if (xml.includes("AUDIT-NO-REFERENCE")) return { ok: true, status: 200, mode: "mock", response: "" };
  return { ok: true, status: 200, mode: "mock", cwBookingNumber: options.isUpdate ? "" : "S12345678", response: "" };
}
