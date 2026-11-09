# Booking / PO / Tracking Portal

## Change in this version
**EFL One banner applied to the top of ALL modules.**
- Image file: frontend/public/efl-one-banner.jpg, rendered by `PageBanner` in frontend/src/components/ui.jsx.
- Same size on every module: a centered box, max width 1240px, at the image's aspect ratio.
- The previous Booking Portal banners were removed.

Retained: full-field booking upload template (all Create Booking fields).

## Run
```bash
cd sbms/backend  && node server.js            # -> http://localhost:4000
cd sbms/frontend && npm install && npm run dev   # -> http://localhost:5173
```
## Tests
```bash
cd backend && node test/smoke.test.js
```

## Tracking Access And Congestion

In **Administration > Configure user**, enable **Tracking** under Module Access, then select organizations under **Tracking Data Scope** and save both settings. The scope list includes the exact consignor/consignee organizations present in the historical dataset, alongside CargoWise reference organizations. Tracking scope is independent of booking and order scopes. Empty tracking scope grants no tracking data, including for administrators; administrators can explicitly assign themselves the organizations they need.

Tracking records and milestones are returned by authenticated `GET /api/v1/tracking/shipments`, filtered server-side by the user's tracking module access and organization assignments. Provider lookups and direct shipment navigation cannot bypass that scope. Raw sample files are no longer public frontend assets: the active CSV remains at the repository root, and events plus the preserved legacy copy are under `backend/data/`. The frontend build no longer emits the active CSV, and Vite no longer allows serving it outside the frontend directory.

The map obtains eligible congestion ports from `GET /api/v1/port-congestion/history`, using ocean leg ports in the user's authorized history, including historical/completed shipments. Only actual reported congestion is highlighted; mock, fallback and rate-limited placeholders are not presented as live alerts. The affected-shipment list still identifies active ocean shipments within that same scope.

Congestion authorization happens **before** cache access. The backend cache remains global per normalized port, not per user: two authorized users sharing a port reuse one cached result and concurrent misses share one upstream request. The 24-hour TTL, timeout, rate limits and quota settings are unchanged. Browser cached port metrics are used only after obtaining the account's eligible history ports. No matching history means no congestion markers or upstream congestion lookups.

Scope assignments follow the application's existing in-memory user store and reset on backend restart. Restart the backend after this upgrade, then configure tracking access and organizations. Run `node --test backend/test/trackingAccess.test.js` for authenticated scope and cross-user-cache regressions.

## Map Location Reference

Route coordinates use a bundled reference with over 98,000 entries, rather than relying on the old small hard-coded lookup. Sources are UN/LOCODE, exact-code seaport records, country-matched airport records, and unambiguous exact UN/LOCODE matches from Wikidata. Source URLs, revisions and required license notices are retained in `frontend/src/data/location-reference.json`. Reference coordinates identify routing locations, not a shipment's exact live position.

The reference is loaded once per application load from a content-hashed local asset; no map geocoding key or per-shipment external lookup is needed. Panvaya API call settings, quotas and caching remain unchanged. The initial map frames the selected routes and reports route coverage. Identical load/discharge locations appear as same-location stops, not invented route lines. Missing and incomplete legs are visible in Route coverage, with unmapped codes also shown as warnings.

- `npm --prefix frontend run update:locations`: explicitly refresh the bundled reference from public sources. External reference-source access is needed only for this refresh; normal coordinate lookup uses the bundled asset.
- `npm --prefix frontend run check:locations`: check every leg code in the current tracking CSV. This also runs automatically before production builds; new unreviewed coordinate gaps fail the build.
- `node frontend/scripts/check-locations.mjs "path/to/candidate.csv"`: validate a candidate replacement dataset before using it.
- `npm --prefix frontend test`: run frontend regressions, including a test proving that a new unknown code fails the coverage check.

Three current source-data issues are explicitly recorded in `frontend/src/data/location-issues.json`: `CNWHA` and `KHSCH` need exact-code verification, and `GBMAN` is Manchester Container Terminal without published coordinates in the references used. Manchester Airport is not substituted for that terminal. These reviewed exceptions remain visible as warnings; new exceptions require an explicit data review rather than silently disappearing from the map.

## Tracking Dataset Rules

`ContainerNum` may contain multiple comma-separated numbers inside a quoted CSV cell. Each nonempty, distinct number becomes an individual container entry. The shipment's Containers tab provides a selector when more than one container is present, showing one container's details at a time without making a new API request on selection. Partial Panvaya results enrich matching containers without discarding the other CSV containers.

Shipment routes use only the load and discharge fields from populated legs 1 through 4, in leg order. Unrelated Origin, Destination, First/Last Load or shipment-level Load/Discharge fields are not appended. Adjacent shared transfer stops are collapsed, but later return visits are retained. Schematic map paths connect only a recorded leg's load/discharge pair when both coordinates are known; missing coordinates do not create a connection across legs.

Run the tracking regression tests with `node --test frontend/test/trackingData.test.js`.

## Pagination

Shipment search, booking search, order search, command-center search results, approvals, audit history and searchable organization checklists use shared pagination. The default is 25 rows, with 10, 25, 50 and 100 rows per page, first/previous/next/last controls, a direct page input and the current result range. Search/filter changes reset to page 1; empty results and smaller result sets clamp to valid pages.

Pagination is client-side and does not change the API's filtering or data access rules. Booking and order Excel exports still include every matching record, not only the current page. The command-center map retains its six-shipment overview when no search is entered; searched lifecycle cards, routes and location actions use the selected result page.

Run pagination tests with `node --test frontend/test/pagination.test.js`.

## Panvaya Tracking

Port congestion and SEA/AIR carrier tracking use Panvaya server-to-server. The API key belongs only in `backend/.env` as `PANVAYA_API_KEY`; never put it in frontend code. The supplied sandbox key is configured locally in that ignored file. Restart the backend after changing credentials. See `backend/.env.example` for settings and https://panvaya.com/developers for the provider contract.

The existing `FREIGHTPULSE_*` names for mode, authentication header/scheme, timeout, cache TTL and limits are retained for compatibility. Defaults remain 10 seconds, a 24-hour cache, 5 requests/minute and 100 requests/calendar month. Only the provider key, base URL and congestion path now use `PANVAYA_*`. Old provider credentials and URLs are no longer used. The limits are now shared across congestion, SEA and AIR to protect the same API account; they are local request-count guards, not Panvaya credit accounting.

- Congestion: `POST /api/v1/port-congestion/lookup` with `{ "ports": ["SGSIN"] }`. The existing response and status endpoints remain compatible. Cached by normalized port, with concurrent deduplication and the existing background retry/fallback policy. The browser retains its 24-hour cache under a new provider-specific key, preventing old-provider entries from being reused. AIR shipments are excluded from ocean congestion lookups.
- SEA: `POST /api/v1/tracking/lookup` with `{ "mode": "SEA", "container": "MSKU8094830" }`, or `bol` / `bk` instead. Optional `shipping_line_scac`; B/L and booking cannot be combined. Ocean requests include route data.
- AIR: the same endpoint with `{ "mode": "AIR", "awb": "044-45428036" }`. Compact and formatted master AWBs share one cache identity.

All endpoints require the portal login token. Shipment details automatically look up a valid container or master B/L for SEA, and a full master AWB for AIR. House references are not substituted for master AWBs. Carrier status, arrival dates and events replace CSV values on successful lookups; source/loading/error states are visible. AIR event timestamps remain airport-local, and planned events do not count as completed milestones.

Tracking cache keys include transport mode, canonical reference, optional carrier and request options, not shipment IDs. Successful results use the existing TTL; identical concurrent requests share one upstream call. Errors are cached for one minute to avoid request storms. Both caches and the shared quota counters are in memory, as before: restarting the backend resets them, and multiple backend instances do not share them.

The command-center map has a **Locate shipments** action for the currently displayed records (the latest six by default, or search/mode results). Each action submits at most five distinct tracking references; matching shipments reuse the same result. Further actions process pending references, retry failures, or update existing reports through the same backend cache and quota. There is no automatic location polling or change to the existing API settings.

Ocean location markers use Panvaya's `route_data.current_position`, and available GeoJSON route segments replace schematic paths. Reported and provider-estimated positions are labelled separately. Popups show coordinates, source, observation time, fetch time and cache status. AIR markers show only the latest actual milestone airport with available coordinates, never an inferred aircraft GPS position. If the latest actual milestone lacks coordinates, no older airport is substituted. Planned events and illustrative air route points are not treated as observed positions. Missing or failed reports remain unavailable, without ETD/ETA-based location markers. Cached reports can be up to the configured 24-hour TTL old; a reported position is not a guarantee of an exact, real-time cargo location.

Panvaya reports 30-day anchorage/berthing metrics, not the old baseline ratio or a vendor congestion label. The portal derives labels from median anchorage days: below 1 Low, 1-<2 Moderate, 2-<3 High, 3+ Severe; missing values are Unknown. Unsupported baseline ratios and observation dates remain empty. The existing explicitly marked mock/fallback behavior is retained.

Panvaya documents sandbox requests as the same real flow; repeated successful provider requests, including their cache hits, can consume credits. Portal cache hits avoid that provider call entirely. Product entitlements and balance must be enabled in the Panvaya dashboard. A sandbox key is not a production credential.

Run `npm --prefix backend test` for mocked integration/cache tests and the existing smoke suite. Tests do not use Panvaya credits.

## Production hardening notes

The current demo authentication uses the `x-user-email` and `x-user-role` headers and the backend data store is in memory. Before production deployment, replace that authentication flow with verified OIDC/JWT claims and move bookings, orders, approvals, users, and audit records to a transactional database.

The HTTP server supports these deployment controls:

- `CORS_ORIGIN`: set to the exact frontend origin; the development default remains permissive for compatibility.
- `MAX_BODY_BYTES`: request size limit, defaulting to 10 MiB.
- `GET /api/health`: liveness-style process check.
- `GET /api/ready`: readiness-style application check.

The server also emits an `X-Request-Id`, applies baseline security headers, and handles `SIGTERM`/`SIGINT` for managed shutdowns. CargoWise delivery should be made durable with an outbox or queue before relying on it for business-critical asynchronous processing.

*EFL — Internal · SBMS v13.4*
