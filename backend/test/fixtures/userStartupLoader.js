export async function resolve(specifier, context, nextResolve) {
  if (specifier === "./src/lib/userAccessDatabase.js" && context.parentURL.endsWith("/server.js")) {
    return { url: new URL("./userStartupDatabase.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
