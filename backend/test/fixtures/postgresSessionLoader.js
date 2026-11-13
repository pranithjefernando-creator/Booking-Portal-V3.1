export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./src/lib/userAccessDatabase.js" && context.parentURL.endsWith("/server.js")) {
    return { url: new URL("./postgresSessionDatabase.js", import.meta.url).href, shortCircuit: true };
  }
  if (specifier.endsWith("/bookingDatabase.js")) {
    return { url: new URL("./isolatedBookingDatabase.js", import.meta.url).href, shortCircuit: true };
  }
  if (specifier.endsWith("/trackingDb.js")) {
    return { url: new URL("./isolatedTrackingDatabase.js", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "./panvayaClient.js" && context.parentURL.endsWith("/trackingCache.js")) {
    return { url: new URL("./isolatedTrackingProvider.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
