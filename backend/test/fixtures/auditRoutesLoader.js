export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/lib/bookingDatabase.js")) return { url: new URL("./isolatedBookingDatabase.js", import.meta.url).href, shortCircuit: true };
  if (specifier.endsWith("/lib/cwClient.js")) return { url: new URL("./auditRoutesCw.js", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
