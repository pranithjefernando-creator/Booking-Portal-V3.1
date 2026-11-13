const records = [
  { "Shipment ID": "TEST-ALLOWED", "CW Org Code": "TESTCO", Trans: "SEA", ContainerNum: "TESTU1234567", Master: "ALLOWED-BL", "Leg 1-Load": "LKCMB", "Leg 1-Discharge": "AEDXB" },
  { "Shipment ID": "TEST-DENIED", "CW Org Code": "ACME", Trans: "SEA", ContainerNum: "OTHRU1234567", Master: "DENIED-BL", "Leg 1-Load": "USNYC", "Leg 1-Discharge": "GBLHR" }
];
export async function sqlTrackingRecords() { return records; }
export function trackingDbStatus() { return { source: "test", count: records.length, loadedAt: null, error: "" }; }
