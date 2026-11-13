const networkCodes = new Set(["ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EPIPE"]);

function isDatabaseUnavailable(error) {
  const code = error?.code;
  return typeof code === "string" && (networkCodes.has(code) || /^(08|28|3F|53|57|58|XX)/.test(code) || ["42P01", "42703", "42501", "ACCESS_SCHEMA_INCOMPATIBLE"].includes(code)) ||
    error?.message === "timeout exceeded when trying to connect";
}

export async function accessDatabaseOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    if (!isDatabaseUnavailable(error)) throw error;
    const unavailable = new Error("User access service is temporarily unavailable", { cause: error });
    unavailable.code = "ACCESS_UNAVAILABLE";
    throw unavailable;
  }
}

export function guardAccessService(service) {
  return Object.fromEntries(Object.entries(service).map(([name, operation]) => [
    name, (...args) => accessDatabaseOperation(() => operation.apply(service, args))
  ]));
}
