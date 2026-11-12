export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith("/lib/bookingDatabase.js")) return { url: new URL("./relationalWorkflowDatabase.js", import.meta.url).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
