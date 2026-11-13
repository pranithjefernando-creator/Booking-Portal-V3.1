import { createBookingPool } from "./bookingStore.js";
import { initializeUserAccessSchema, verifyUserAccessSchema } from "./userAccessSchema.js";
import { createUserAccessServices } from "./userAccessServices.js";
import { initializeDefaultApproval } from "./accessConfigurationStore.js";
import { userAccessTransaction } from "./userAccessStore.js";
import { verifyUserAccessRuntime } from "./userAccessReadiness.js";

let pool;
let services;

function userAccessPool() {
  if (!pool) pool = createBookingPool();
  return pool;
}

export async function initializeUserAccessDatabase(env = process.env) {
  services = undefined;
  const pending = createUserAccessServices(userAccessPool(), env);
  await initializeUserAccessSchema(userAccessPool());
  await userAccessTransaction(userAccessPool(), initializeDefaultApproval);
  const client = await userAccessPool().connect();
  try {
    await verifyUserAccessRuntime(client);
  } finally {
    client.release();
  }
  services = pending;
}

export function userAccessServices() {
  if (!services) throw new Error("PostgreSQL user access services are not initialized");
  return services;
}

export async function checkUserAccessDatabase() {
  userAccessServices();
  const client = await userAccessPool().connect();
  try {
    await verifyUserAccessSchema(client);
    await verifyUserAccessRuntime(client);
  } finally {
    client.release();
  }
}

export async function closeUserAccessDatabase() {
  services = undefined;
  if (!pool) return;
  const active = pool;
  pool = undefined;
  await active.end();
}
