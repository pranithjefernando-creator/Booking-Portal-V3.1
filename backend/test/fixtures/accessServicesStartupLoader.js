export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./src/lib/bookingDatabase.js" && context.parentURL.endsWith("/server.js")) {
    return { url: new URL("./accessServicesBookingDatabase.js", import.meta.url).href, shortCircuit: true };
  }
  if (specifier === "./userAccessSchema.js" && context.parentURL.endsWith("/userAccessDatabase.js")) {
    return { url: new URL("./accessServicesSchema.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
