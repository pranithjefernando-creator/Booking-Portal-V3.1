export function providerError(message, status, code) { return Object.assign(new Error(message), { status, code }); }
export async function panvayaRequest(path, payload) {
  if (path !== "/track/ocean" || payload.bol !== "ALLOWED-BL") throw providerError("Unexpected test provider request", 400, "INVALID_REQUEST");
  return { data: { containers: [{ container_number: "TESTU1234567" }] } };
}
