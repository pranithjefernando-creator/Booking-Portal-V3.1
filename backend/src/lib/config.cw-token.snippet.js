// ============================================================================
// ADD to backend/src/lib/config.js  → inside config.cw { ... }
// Only ONE new optional field is needed; the rest you already have.
// ============================================================================
//
// cw: {
//   mode: (process.env.CW_MODE || "mock").toLowerCase(),
//   bookingUrl: process.env.CW_BOOKING_URL || "",
//   subscriptionKey: process.env.CW_APIM_SUBSCRIPTION_KEY || "",
//   contentType: process.env.CW_CONTENT_TYPE || "application/xml",
//   bearerToken: (process.env.CW_BEARER_TOKEN || "").trim(),      // leave EMPTY for auto-refresh
//   tokenUrl: process.env.CW_TOKEN_URL || "",                     // OAuth2 token endpoint
//   clientId: process.env.CW_CLIENT_ID || "",
//   clientSecret: process.env.CW_CLIENT_SECRET || "",
//   scope: process.env.CW_SCOPE || "",
//   timeoutMs: parseInt(process.env.CW_TIMEOUT_MS || "15000", 10),
//   tokenSafetySec: parseInt(process.env.CW_TOKEN_SAFETY_SEC || "300", 10)   // <-- NEW: refresh 5 min early
// }
