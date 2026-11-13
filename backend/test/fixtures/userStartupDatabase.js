import { createUserAccessServices } from "../../src/lib/userAccessServices.js";

let services;
export async function initializeUserAccessDatabase() {
  if (process.env.TEST_USER_STARTUP_FAILURE === "1") throw new Error("simulated incompatible user schema");
  services = createUserAccessServices({});
}
export function userAccessServices() { return services; }
export async function checkUserAccessDatabase() {
  if (process.env.TEST_USER_READY_FAILURE === "1") throw new Error("simulated user database outage");
}
export async function closeUserAccessDatabase() {}
