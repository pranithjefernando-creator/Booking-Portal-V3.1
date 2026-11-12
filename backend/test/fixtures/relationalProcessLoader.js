export async function resolve(specifier, context, nextResolve) {
  if (specifier === "mssql") return { url: new URL("./mockSqlOrders.js", import.meta.url).href, shortCircuit: true };
  if ((specifier === "./src/lib/bookingDatabase.js" || specifier === "../lib/bookingDatabase.js") && !context.parentURL.includes("/test/fixtures/")) {
    return { url: new URL("./relationalProcessDatabase.js", import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
