import { createUserAccessStore } from "./userAccessStore.js";
import { createUserAccessSettingsStore } from "./userAccessSettingsStore.js";
import { createUserAuthentication } from "./userAuthentication.js";
import { createAccessConfigurationStore } from "./accessConfigurationStore.js";
import { createPostgresAuthHandlers } from "./postgresAuthHandlers.js";
import { guardAccessService } from "./accessErrors.js";

export function createUserAccessServices(pool, env = process.env) {
  const rawHours = env.AUTH_TOKEN_TTL_HOURS;
  const hours = rawHours === undefined ? 8 : Number(rawHours);
  const tokenTtlMs = hours * 60 * 60 * 1000;
  if ((rawHours !== undefined && (typeof rawHours !== "string" || !rawHours.trim())) ||
      !Number.isSafeInteger(tokenTtlMs) || tokenTtlMs <= 0 ||
      !Number.isSafeInteger(Date.now() + tokenTtlMs)) {
    throw new Error("AUTH_TOKEN_TTL_HOURS must be a positive, finite duration");
  }
  const authentication = guardAccessService(createUserAuthentication(pool, { secret: env.AUTH_SECRET, tokenTtlMs }));
  const settings = guardAccessService(createUserAccessSettingsStore(pool));
  return {
    users: guardAccessService(createUserAccessStore(pool)),
    settings,
    authentication,
    configurations: guardAccessService(createAccessConfigurationStore(pool)),
    authHandlers: createPostgresAuthHandlers(authentication, settings)
  };
}
