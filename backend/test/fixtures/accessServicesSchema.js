export async function initializeUserAccessSchema() {
  if (process.env.TEST_ACCESS_SCHEMA_FAILURE === "1") throw new Error("simulated user database failure");
}
export async function verifyUserAccessSchema() {}
