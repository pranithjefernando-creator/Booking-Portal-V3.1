export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./bookingRelationalSchema.js" && context.parentURL.endsWith("/lib/bookingDatabase.js")) {
    return { url: new URL("./failRelationalSchema.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
