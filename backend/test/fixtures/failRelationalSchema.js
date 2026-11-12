export async function initializeRelationalBookingSchema() {
  if (!process.env.TEST_V4_READY_FAILURE) throw new Error("simulated incompatible v4 schema");
}
export async function checkRelationalBookingReadiness() {
  throw new Error("simulated unavailable v4 schema");
}
