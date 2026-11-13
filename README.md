# Booking / PO / Tracking Portal

## Change in this version
**EFL One banner applied to the top of ALL modules.**
- Image file: frontend/public/efl-one-banner.jpg, rendered by `PageBanner` in frontend/src/components/ui.jsx.
- Same size on every module: a centered box, max width 1240px, at the image's aspect ratio.
- The previous Booking Portal banners were removed.

Retained: full-field booking upload template (all Create Booking fields).

## Run
Run these commands from the repository root in two separate PowerShell terminals.

Backend (http://localhost:4000):
```powershell
cd backend
$env:TRACKING_DB_PASSWORD = '<your database password>'
node --env-file=.env server.js
```

Frontend (http://localhost:5173):
```powershell
cd frontend
$env:NODE_USE_SYSTEM_CA = '1'
npm install
npm run dev
```

`NODE_USE_SYSTEM_CA` enables the Windows trusted certificate store on Node 24, which resolves npm's `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` error when the required certificate is trusted by Windows. It does not disable TLS verification. If the error persists, obtain the required CA certificate from your IT team.

Use separate lines for installation and startup: `>` redirects output in PowerShell, rather than chaining commands. If the backend reports `EADDRINUSE` on port 4000, check http://localhost:4000/api/health to see whether a process is running and http://localhost:4000/api/ready for booking PostgreSQL readiness. Stop the existing backend with Ctrl+C in its terminal before restarting it with changed environment settings.

## User and access PostgreSQL schema

`backend/sql/user-access-v1.sql` defines a separate `portal_access_v1` schema for users, roles, permissions, modules, role grants, user module overrides and ordered organization scopes. User IDs are application-supplied UUIDs; email addresses are trimmed and unique regardless of case. Ordered scopes preserve the current first-organization default. `modules_configured` distinguishes inheriting role modules from explicitly selecting no modules.

Backend startup initializes and verifies the schema and constructs the PostgreSQL user, settings, authentication, configuration and HTTP authentication services before listening. The services share the user-access connection pool and are exposed by `userAccessServices()` only after successful initialization; they never fall back to in-memory records on database errors. Live login, user management, roles, permissions, modules, organization scopes, approval configurations and visibility profiles use PostgreSQL. Booking, order and tracking workflow access is evaluated using the saved settings. Existing in-memory users and credentials are not migrated.

The `backend/src/lib/userAccessStore.js` implements PostgreSQL create, list, get, partial update and delete for core user records. User management is available under Settings to users with the saved `admin.users` permission. Roles must already exist in PostgreSQL before a user can reference them. The last administrator cannot be deleted or demoted.

The live access-settings endpoints use `backend/src/lib/userAccessSettingsStore.js` for role creation, editing and deletion, role permissions and ordered modules, user module overrides, and ordered booking, order and tracking scopes. Role writes require `admin.roles`; module and scope writes require `admin.users`. The actor's saved permission is rechecked in the write transaction. `initializeCatalogs()` explicitly inserts missing built-in roles and catalog entries without overwriting existing roles or grants; it is not run automatically and creates no administrator user. The Admin role cannot be edited or deleted, and roles assigned to users cannot be deleted. Assigning `null` modules means inherit the role's modules, while an empty array explicitly selects none. Scope writes validate codes against the organization directory or tracking parties, preserve ordering and prune child organization scopes when a parent scope changes.

Authentication loads the session, user, role, modules and scopes together in a read-only PostgreSQL snapshot for each request. Changes apply to subsequent requests; a request already in progress uses its original snapshot. A missing administrator role preview is rejected rather than silently reverting to administrator access. Empty booking and order scopes retain their existing unrestricted read behavior; non-administrator order creation and import require an order scope. Tracking requires the tracking module and an explicit matching organization, including for administrators. Booking creation and templates require the create module; shared booking access requires at least one of the create, bookings or approvals modules. Imports, approvals and orders require their respective modules. Cross-workflow booking/order links require access to both sides. Booking storage remains PostgreSQL; order and tracking integrations are unchanged.

Startup verifies the access schema and database privileges, initializes the default approval configuration if absent, and probes the access tables and saved default before publishing the services. Readiness repeats the schema and runtime checks and returns 503 when either booking or access storage is unavailable. Access tables must not have PostgreSQL row-level security enabled: partially filtered scopes could otherwise be mistaken for unrestricted access. Each authenticated request checks for missing access tables or row security before loading its snapshot and fails closed if either is detected. Access service database outages are logged and reported as 503 without returning cached settings; unexpected programming and validation errors retain their normal error handling. Authenticated responses and readiness are marked `no-store`. Readiness does not require an administrator to exist and is not a substitute for provisioning and testing one.

On an access-service outage the frontend clears its displayed access settings and offers a retry rather than continuing with stale permissions. Older refresh responses cannot overwrite a newer session or role preview, and failed document or text requests are not treated as successful downloads.

`backend/src/lib/accessConfigurationStore.js` persists approval rule configurations, field visibility profiles and per-user assignments. Authorized users can manage these under Settings. Assignments are transactional; assigned configurations cannot be deleted and assigned profiles cannot be deleted or moved to another module. Unassigned visibility means all fields remain visible; an explicitly unassigned approval rule means no rules for that user.

Startup creates the persistent default approval configuration if it is missing, without overwriting later edits. Initially it requires approval for Ocean FCL cargo with total gross weight **greater than 10,000 kg**. New users receive this configuration when no rule assignment is specified; explicitly selecting no rules leaves them unassigned. The bootstrap administrator also receives the default. Existing users are not changed automatically. For a booking whose creator cannot be found, approval evaluation uses the saved default; ambiguous matching creator names fail explicitly. The default may be edited or disabled by an administrator but cannot be deleted through the API. Booking approval evaluation uses the PostgreSQL store.

`backend/src/lib/userAuthentication.js` stores salted scrypt password hashes in `user_credentials`, separately from user records; plaintext passwords and signing secrets are not stored in PostgreSQL. It provides login, signed-session validation, password change and authorized administrator reset. Live user creation writes the record, initial credential and requested assignments in one transaction; editing commits record and assignment changes together. User writes check the actor's current PostgreSQL permission and reject sessions requiring a password change. Reset produces a temporary password once for secure delivery, marks it for mandatory change and revokes existing sessions. Password changes revoke all existing sessions, including the current one, and require sign-in again. Deliver temporary passwords securely; they cannot be retrieved later.

`backend/src/lib/postgresAuthHandlers.js` is mounted for live login and protected-session authentication. A temporary-password session can only access `/api/v1/me` and `/api/v1/auth/change-password`. After a password change, the frontend signs the user out for reauthentication. Enabled workflow and management endpoints require the applicable saved permissions, modules and scopes; other endpoints remain unavailable during integration.

Set `AUTH_SECRET` in the protected backend environment (for example, the ignored `backend/.env` file) to a stable, securely generated secret of at least 32 UTF-8 bytes. Do not share it or commit it to source control. **Backend startup now fails before listening** if it is missing, blank or too short. If `AUTH_TOKEN_TTL_HOURS` is set, it must be a positive finite duration representable in whole milliseconds; otherwise it defaults to eight hours. Invalid values also prevent startup. Use the same secret across restarts; changing it invalidates existing sessions.

PostgreSQL sessions survive a backend restart until expiry, but are invalid after a password change, reset, user deletion or secret rotation. Login locks an existing account for 15 minutes after five failed attempts, persisted across restarts; unknown accounts are not covered by this account lockout and deployment-level rate limiting remains necessary.

A one-time administrator bootstrap is available for creating the first PostgreSQL login. The command refuses to run if any PostgreSQL user exists, initializes missing role catalogs without overwriting existing roles, verifies the Admin grants and stores only a salted hash. The administrator must change the initial password at first login.

From the repository root in PowerShell, replace the name and email with the intended administrator's details and enter a password locally when prompted; do not share the password:

```powershell
$env:BOOTSTRAP_ADMIN_NAME = 'Admin'
$env:BOOTSTRAP_ADMIN_EMAIL = 'admin@example.com'
$securePassword = Read-Host 'Initial administrator password' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:BOOTSTRAP_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  node --env-file=backend\.env backend\src\lib\userAccessBootstrapCli.js
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  Remove-Item Env:\BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Variable securePassword -ErrorAction SilentlyContinue
}
```

Treat the terminal and local process environment as sensitive while bootstrapping. The command does not print the password. Configure the signing secret separately in the backend's protected environment before activation; do not put it in command history or source control.

If an administrator cannot sign in and no other administrator can reset their password, an operator with access to the protected backend environment and PostgreSQL can recover an existing Admin account locally. This resets its password, clears lockout, revokes its sessions and requires another password change at next login. It does not create an account. Restrict access to the environment and database credentials: anyone with them can perform recovery.

From the repository root in PowerShell, enter the administrator's email and a new temporary password privately (at least eight characters with letters and numbers). Do not share either password in chat:

```powershell
& {
  $env:RECOVERY_ADMIN_EMAIL = Read-Host 'Administrator email'
  $securePassword = Read-Host 'New temporary administrator password' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    $env:RECOVERY_ADMIN_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    node --env-file=backend\.env backend\src\lib\userAccessRecoveryCli.js
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    Remove-Item Env:\RECOVERY_ADMIN_PASSWORD, Env:\RECOVERY_ADMIN_EMAIL -ErrorAction SilentlyContinue
    Remove-Variable securePassword -ErrorAction SilentlyContinue
  }
}
```

After the success message, sign in with that email and temporary password, then choose a different permanent password. If recovery fails, report only the error message without secrets.

Store writes serialize via a PostgreSQL transaction advisory lock, preventing concurrent store operations from deleting or demoting the last `Admin`. All user-writing paths must use the same lock; direct SQL or other writers bypass this protection. This safeguard does not replace the first-administrator bootstrap.

Startup fails explicitly if either PostgreSQL schema cannot be initialized or verified. `/api/ready` returns 503 when either booking or user-access verification fails, with separate `bookingDatabase` and `userAccessDatabase` statuses; errors are logged server-side. The user-access readiness check verifies schema definitions and CRUD privileges, not just connectivity. `/api/health` remains a liveness check. The staged stores propagate database errors rather than falling back to default settings.

PostgreSQL login, user management, roles, modules, organization scopes and configuration management are active, as are the booking, order and tracking routes using saved access settings. Readiness does not verify Azure SQL or external tracking-provider connectivity.

From the repository root, manually initialize or recheck the schema with the configured PostgreSQL connection:

```powershell
node --env-file=backend\.env backend\src\lib\userAccessMigrate.js
```

The initializer uses a transaction and an advisory lock, verifies the expected columns, defaults, constraints, email index and CRUD privileges, and rolls back if verification fails. It creates no users or catalog entries and does not modify booking schemas. The configured database role needs database CREATE permission for initial creation, schema USAGE, and SELECT, INSERT, UPDATE and DELETE on each user-access table. Verification deliberately requires the expected PostgreSQL-rendered check expressions; a PostgreSQL upgrade that renders them differently may require a verifier update rather than accepting an unverified schema.

As selected, the staged checks preserve current empty-scope behavior: empty booking and order scopes allow unrestricted visibility, but order creation still requires a nonempty order scope for non-admin users; tracking requires an explicit matching scope and enabled tracking module. The Admin booking/order bypass and current tracking rules remain unchanged. Scope relationships to external organization data require later integration decisions.

Run the isolated workflow suite from the repository root with a dedicated test database and a role allowed to create and drop schemas:

```powershell
$env:BOOKING_DB_TEST = '1'
node --env-file=backend\.env --test backend\test\liveUserRestartBoundary.test.js backend\test\accessConfigurationStore.test.js backend\test\userAccessWorkflow.test.js backend\test\postgresAuthHandlers.test.js backend\test\userAccessReadiness.test.js backend\test\userAccessSchema.test.js
```

These tests create uniquely named access and booking schemas and remove them after execution, or roll back schema creation in a transaction. The live test starts the backend with isolated PostgreSQL access and booking stores, local order data and a stub tracking provider; it exercises authentication, password changes and resets, management, permissions and scopes, approvals, visibility, bookings, order links, tracking, outages and restart persistence. Local test orders remain in memory and disappear on restart; their PostgreSQL booking links persist. The test does not connect to Azure SQL or the external tracking provider and does not establish their live availability. Without `BOOKING_DB_TEST=1`, database-dependent cases are skipped. Other tests, including `userAccessStartup.test.js` and several booking integration tests, use the configured permanent schemas and should only be run against a dedicated test database.

## Booking PostgreSQL foundation

Booking operations now use the relational `booking_portal_v4` schema in `backend/sql/booking-v4.sql`. Restart the backend to load the change. Startup and `npm run booking:migrate` initialize and verify v4; startup fails before listening if v4 is incompatible or unavailable, and `/api/ready` returns 503 if it becomes unavailable. The configured PostgreSQL role needs permission to create the v4 schema and objects, and the required table access. Startup and booking operations no longer initialize or write to `booking_portal_v3`.

The v4 initializer creates and verifies the `audit_events` table and its newest-first index. The database role requires `SELECT` and `INSERT` on this table; no audit `UPDATE` or `DELETE` privileges are required. Booking, approval and order audit events are written to PostgreSQL. The audit API and page read the newest 200 events from PostgreSQL, with the full event count; a load failure is shown explicitly with a retry option. Earlier in-memory entries, including the seed event, are not migrated.

For audit release verification, use a dedicated test database with a role allowed to create and drop schemas:

```powershell
$env:BOOKING_DB_TEST = '1'
node --env-file=backend\.env --test backend\test\auditStore.test.js backend\test\auditRoutes.test.js backend\test\liveUserRestartBoundary.test.js
node --env-file=backend\.env --test --test-name-pattern='v4 audit schema' backend\test\bookingRelationalStartup.test.js
```

These tests use isolated schemas and cover event writes, access permissions, newest-first ordering and the 200-entry limit, database failures, and backend restart persistence. The live test uses mock CargoWise and local order data. Before deployment, confirm the database role's privileges, back up according to the environment's procedures, and schedule a restart when no CargoWise operations are in flight; portal-created orders are lost on restart. After deployment, check `/api/ready` and verify the audit page with an authorized account and an approved test booking. Do not simulate database failures or change permissions on a shared production schema.

Booking and approval audit writes share the booking transaction. CargoWise and portal order create/delete operations record a durable intent in `external_operations` before making non-transactional changes. A pending operation blocks the same retry; uncertain CargoWise operations also block booking changes. No automatic retry is attempted. The PostgreSQL role requires `SELECT`, `INSERT` and `UPDATE` on `external_operations`.

Users with `admin.users` can review pending operations in Settings > Operation reconciliation. Check CargoWise or the portal independently, including whether a request is still in flight, then record an applied/not-applied outcome and notes. Confirmed CargoWise operations require the actual CargoWise reference and update the booking; a confirmed not-applied completion restores its prior status. A running operation cannot be reconciled. Portal orders remain in memory and disappear on restart: reconciliation records the administrator's finding but does not restore an order or recreate a removed booking link. When an order create is uncertain, retries with the same normalized order number and split are blocked while it remains pending. If a response is lost after an operation is marked complete, no pending entry is shown and the server cannot identify a retry: check the order or booking and consult an administrator before retrying. A repeated order deletion can return 404 after the order was removed even if its audit is pending; verify both the order and any linked booking before resolving it. The journal and audit records do not make CargoWise or in-memory orders transactional.

The relational design stores booking fields as typed columns; shipper and consignee details, cargo lines, containers, and documents have separate booking-owned tables. Cargo and container positions preserve display order, and document content is stored as bytes with a checked size. Optional fields remain nullable so incomplete drafts can be saved; validation still applies before advancing a booking. Small `additional_data` JSON objects are reserved for fields not explicitly modeled, rather than storing the entire booking. Approvals, imports, templates and preferences retain JSONB payloads in their separate tables. Order links remain separate and do not write to Azure SQL.

The store maps records and child objects transactionally, converts empty date and numeric inputs to SQL `NULL`, and reconstructs the API shape, including base64 documents. Its `additional_data` metadata preserves unmapped fields and input representations. Approvals, imports, order links, templates, layouts, booking lists, counts, dashboard, notifications and order booking selectors use v4. Notification snapshots read bookings and approvals in a consistent transaction without loading document contents. New bookings and imported bookings receive a `BKV4-` prefix followed by a randomly generated UUID, with a unique database constraint; the old v3 reference sequence is not used. External systems should be checked for compatibility with the new reference format.

The relational schema and startup tests create isolated temporary schemas inside rolled-back transactions. The store and workflow tests write uniquely identified records to v4 and remove those records afterward. The backend process test runs the normal v4-backed backend with a mock SQL order, and checks restart persistence and rollback after a failed write; it does not write to Azure SQL. Run the tests with `node --env-file=backend\.env --test backend\test\bookingRelationalSchema.test.js backend\test\bookingRelationalStartup.test.js backend\test\bookingRelationalStore.test.js backend\test\bookingRelationalWorkflows.test.js backend\test\bookingRelationalWorkflowRoutes.test.js backend\test\bookingRelationalSharedViews.test.js backend\test\bookingRelationalProcessRestart.test.js` after setting `$env:BOOKING_DB_TEST = '1'`.

Existing v3 bookings, approvals, imports, order links, templates and layouts are not migrated and will not appear in v4; they remain in v3 untouched. Existing in-memory booking data is not migrated. Bookings cannot be edited, revalidated or cancelled while an approval is pending. Import batches are owned by the uploading user's email; their edits and commits are saved transactionally and commits check the user's booking scope. The current import page does not restore an open batch after a browser refresh, although it remains stored and can be retrieved through `GET /api/v1/imports/:batchId`. Users and approval rule configurations remain in memory and reset on backend restart; pending approval requests and their recorded matched rules remain in PostgreSQL. The existing `booking_portal` schema is not used or modified. Order and tracking data continue to use their existing Azure SQL integrations.

The booking KPIs, dashboard booking statistics and recent list, notifications, and order booking selector read PostgreSQL and respect booking scope. Notification counts refresh every minute, and pending approvals are restricted to visible bookings. Rejected-booking notifications use the creator's email when available and fall back to the stored creator name for older bookings. The dashboard's six-month chart uses recorded creation and completion dates; completion dates are recorded for new completions, so older bookings without one are excluded from the completed trend but remain included in the completed KPI. The purchase-order dashboard count continues to use the existing order source.

Order links are stored in PostgreSQL, not Azure SQL. A link is restored when its Azure SQL order is loaded after a restart or refresh, using the existing stable order ID derived from `OrderNumber`. The existing Azure SQL mapping does not distinguish records with the same `OrderNumber` but different splits; those records share an ID and cannot have independent links. Portal-created in-memory orders do not survive a restart, so their saved links cannot be displayed unless those orders are restored. An order can be linked to only one booking; link and unlink operations check both order and booking scope. Order list and detail requests also require PostgreSQL so that link information cannot silently become stale. Saving a booking and reconciling its cargo-order links are separate requests; if a link fails, the page reports that the booking was saved but the link needs attention.

Configure `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` in the ignored `backend/.env` file. Start the backend with `node --env-file=.env server.js` from the backend directory. Before listening, the backend initializes the schema transactionally under an advisory lock, verifies required columns, keys, relationships and privileges, and exits with an error if PostgreSQL or initialization is unavailable. The database role must be allowed to create the schema, tables, sequence and indexes and use the booking tables. PostgreSQL connections require TLS with certificate and hostname verification. Initialization is repeatable and can also be run manually from the repository root:

```powershell
node --env-file=backend\.env backend\src\lib\bookingMigrate.js
```

`GET /api/health` is a liveness check; `GET /api/ready` returns 503 when booking PostgreSQL cannot be accessed, and recovers when it is reachable again. Readiness does not verify Azure SQL, tracking, or CargoWise. PostgreSQL failures are reported by booking endpoints, rather than falling back to memory. CargoWise sends cannot be rolled back if the subsequent database commit fails; check CargoWise before retrying a failed request. The schema tests use rolled-back inserts and a temporary schema. The storage, import, approval and booking API tests commit uniquely identified test bookings, verify them, and delete those bookings afterward; they also advance the booking reference sequence. The process-restart test uses a mock Azure SQL order source and CargoWise and does not write to Azure SQL. The template and preference API tests create and delete unique test data. Run them with:

```powershell
$env:BOOKING_DB_TEST = '1'
node --env-file=backend\.env --test backend\test\bookingStartup.test.js backend\test\bookingSchema.test.js backend\test\bookingStore.test.js backend\test\bookingRecordsDb.test.js backend\test\bookingProcessRestart.test.js backend\test\bookingApprovalStore.test.js backend\test\bookingApprovalsDb.test.js backend\test\bookingImportStore.test.js backend\test\bookingImportsDb.test.js backend\test\bookingTemplatesDb.test.js backend\test\bookingPreferencesDb.test.js backend\test\orderLinking.test.js backend\test\bookingSharedViewsDb.test.js
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

## Booking And Order Field Visibility

Administrators can create separate booking and order **Field Visibility Profiles** in Settings, then assign one of each when creating or configuring a user. Profiles apply to creation and editing forms, including line-item fields. Required fields remain visible. Without an assigned profile, all fields are visible. Profiles are independent of approval rules and cannot be deleted while assigned. Changes take effect when the user's session refreshes or the user signs in again.

Visibility profiles affect the form only; they do not restrict access to underlying data or APIs. Profiles and user assignments follow the existing in-memory user store and are reset when the backend restarts. The backend maintains a standalone copy of the field catalog for validation; keep it synchronized with the frontend catalog when adding or changing fields. Run `node --test backend/test/fieldVisibilityProfiles.test.js` to check profile behavior and catalog consistency.

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

Port congestion and SEA/AIR carrier tracking use Panvaya server-to-server. The API key belongs only in `backend/.env` as `PANVAYA_API_KEY`; never put it in frontend code. Restart the backend after changing credentials or cache labels. See https://panvaya.com/developers for the provider contract.

`backend/sql/provider-cache-v1.sql` defines PostgreSQL tables for tracking and port caches, per-account/environment monthly usage, request timestamps, provider backoff, fetch leases and port retries. Backend startup and `booking:migrate` initialize and verify the tables, constraints, expiry/lookup indexes, schema usage and table privileges. The role needs `SELECT`, `INSERT`, `UPDATE` and `DELETE` on both cache tables, `provider_fetch_leases` and `provider_port_retries`; `SELECT`, `INSERT` and `UPDATE` on `provider_usage`; and `SELECT`, `INSERT` and `DELETE` on `provider_request_events`. Row-level security must be disabled on these tables.

Set `PANVAYA_CACHE_ACCOUNT` and `PANVAYA_CACHE_ENVIRONMENT` to stable, non-secret labels in `backend/.env` on every instance. For the live sandbox, both labels are `Sandbox`; the local mock deployment uses account `Sandbox` and environment `Sandbox-Mock`. Use distinct labels for different accounts, provider environments and mock/live deployments, and the same labels only for instances intended to share results. Never use an API key as a label. Missing labels make cache operations fail explicitly; the labels are case-sensitive.

To remove expired cache entries and request timestamps older than the one-minute quota window, run `node --env-file=backend\.env backend\src\lib\providerCacheCleanupCli.js` from the repository root. Each invocation removes at most 1,000 rows per table and leaves monthly counts, provider backoff, fetch leases and pending port retries untouched; repeat as needed. Cleanup is not scheduled automatically. To test against a dedicated PostgreSQL test database, set `$env:BOOKING_DB_TEST = '1'` and run `node --env-file=backend\.env --test backend\test\providerCacheSchema.test.js backend\test\providerCacheStore.test.js backend\test\providerUsageStore.test.js backend\test\providerFetchCoordination.test.js backend\test\providerPortRetries.test.js` from the repository root. Tests use uniquely named schemas and remove them after execution.

These tests use mock provider responses and cover cache hits and expiry, cached errors, 429 backoff, quota boundaries, cross-process coordination, database failures and persistence across process restarts. The isolated backend restart test in the user-access section also verifies cached tracking and port responses after a backend restart. No live provider requests are made.

The existing `FREIGHTPULSE_*` names for mode, authentication header/scheme, timeout, cache TTL and limits are retained for compatibility. Defaults remain 10 seconds, a 24-hour cache, 5 requests/minute and 100 requests/calendar month. The provider key, base URL, congestion path and cache labels use `PANVAYA_*`. Old provider credentials and URLs are no longer used. Configure the same limits on all instances sharing an account/environment. These are request-count guards, not Panvaya credit accounting.

- Congestion: `POST /api/v1/port-congestion/lookup` with `{ "ports": ["SGSIN"] }`. The existing response and status endpoints remain compatible. Cached by normalized port, with concurrent deduplication and the existing background retry/fallback policy. Browser lookups always go through the authorized API instead of reusing a browser-local result. AIR shipments are excluded from ocean congestion lookups.
- SEA: `POST /api/v1/tracking/lookup` with `{ "mode": "SEA", "container": "MSKU8094830" }`, or `bol` / `bk` instead. Optional `shipping_line_scac`; B/L and booking cannot be combined. Ocean requests include route data.
- AIR: the same endpoint with `{ "mode": "AIR", "awb": "044-45428036" }`. Compact and formatted master AWBs share one cache identity.

All endpoints require the portal login token. Shipment details automatically look up a valid container or master B/L for SEA, and a full master AWB for AIR. House references are not substituted for master AWBs. Carrier status, arrival dates and events replace CSV values on successful lookups; source/loading/error states are visible. AIR event timestamps remain airport-local, and planned events do not count as completed milestones.

Tracking cache keys include transport mode, canonical reference, optional carrier and request options, not shipment IDs. Successful results use the existing TTL; errors are cached for one minute. Tracking and port results are shared through PostgreSQL and survive backend restarts. Instances coordinate cache misses through per-account/environment, per-key leases; followers wait for the shared result, or receive an explicit pending error if their wait expires. Cache writes and lease completion are atomic, and an expired or replaced owner cannot publish a late response. A database failure is reported rather than silently bypassing coordination. A rate-limited port queues one shared retry after one minute; the retry survives restarts and uses the same quota reservation and per-port lease. If the limit is still reached, the retry is consumed without calling the provider, as before. Retries created only in older processes are not migrated. Coordinate deployment across all instances: older versions do not honor these leases or shared retries.

Each live request atomically reserves a rolling-minute slot and UTC-calendar-month count in PostgreSQL before contacting Panvaya; failed and timed-out requests still count. Provider 429 responses persist the numeric `Retry-After` delay (or one minute if unavailable) without shortening an existing backoff. Reservations, usage and backoff are shared between instances and survive restarts. Requests already reserved before a 429 is recorded can still be in flight. If quota accounting is unavailable, live calls fail closed. If the database cannot record a received 429, the request fails explicitly, but its backoff cannot be guaranteed after database recovery; operators must reconcile the provider's limit before resuming.

Existing in-memory counts are not automatically transferred at deployment. Before switching, reconcile the current month's usage and any active backoff with Panvaya, initialize the appropriate scoped usage row, and coordinate all instances to avoid mixing old and new accounting. The new rolling window also cannot include pre-switch calls unless their timestamps are imported; allow the previous one-minute window to expire before enabling live calls.

The local November 2026 cutover seeded both sandbox scopes to the full 100-request monthly limit as a precaution, not as a measurement of actual provider usage. The backend is configured in mock mode with no live key. The monthly guard resets at the next UTC month; before enabling live mode, reconcile the actual account usage and any provider backoff, confirm all instances use the live scope and shared accounting, and ensure the old rolling-minute window has elapsed.

An expired lease, interrupted response, timeout or failed cache publication can represent a billable request. It is not retried automatically, including after a restart; the API reports that manual review is required. Quota reservations are not refunded. To review, a trusted operator with database access can run `node --env-file=backend\.env backend\src\lib\providerFetchReviewCli.js list`. After checking Panvaya and confirming that the original worker has stopped and cannot issue or publish a late request, run `node --env-file=backend\.env backend\src\lib\providerFetchReviewCli.js release <lease-id> <operator> "<review notes>" --confirm-worker-stopped`. Release and the operator's notes are recorded in the audit log atomically. The operator name is self-reported; restrict database and CLI access to trusted personnel. A later retry is a new, potentially billable request and consumes another quota reservation. Do not manually delete lease rows: fencing cannot prevent a paused worker from sending an external request after its lease is released. If recording a provider 429 failed, reconcile its backoff as well before releasing.

The command-center map has a **Locate shipments** action for the currently displayed records (the latest six by default, or search/mode results). Each action submits at most five distinct tracking references; matching shipments reuse the same result. Further actions process pending references, retry failures, or update existing reports through the same backend cache and quota. There is no automatic location polling or change to the existing API settings.

Ocean location markers use Panvaya's `route_data.current_position`, and available GeoJSON route segments replace schematic paths. Reported and provider-estimated positions are labelled separately. Popups show coordinates, source, observation time, fetch time and cache status. AIR markers show only the latest actual milestone airport with available coordinates, never an inferred aircraft GPS position. If the latest actual milestone lacks coordinates, no older airport is substituted. Planned events and illustrative air route points are not treated as observed positions. Missing or failed reports remain unavailable, without ETD/ETA-based location markers. Cached reports can be up to the configured 24-hour TTL old; a reported position is not a guarantee of an exact, real-time cargo location.

Panvaya reports 30-day anchorage/berthing metrics, not the old baseline ratio or a vendor congestion label. The portal derives labels from median anchorage days: below 1 Low, 1-<2 Moderate, 2-<3 High, 3+ Severe; missing values are Unknown. Unsupported baseline ratios and observation dates remain empty. The existing explicitly marked mock/fallback behavior is retained.

Panvaya documents sandbox requests as the same real flow; repeated successful provider requests, including their cache hits, can consume credits. Portal cache hits avoid that provider call entirely. Product entitlements and balance must be enabled in the Panvaya dashboard. A sandbox key is not a production credential.

Run `npm --prefix backend test` for mocked integration/cache tests and the existing smoke suite. Tests do not use Panvaya credits.

## Production hardening notes

Portal-created orders remain in memory. Before production deployment, persist portal orders and review authentication and deployment security controls.

The HTTP server supports these deployment controls:

- `CORS_ORIGIN`: set to the exact frontend origin; the development default remains permissive for compatibility.
- `MAX_BODY_BYTES`: request size limit, defaulting to 10 MiB.
- `GET /api/health`: liveness-style process check.
- `GET /api/ready`: readiness-style application check.

The server also emits an `X-Request-Id`, applies baseline security headers, and handles `SIGTERM`/`SIGINT` for managed shutdowns. CargoWise delivery should be made durable with an outbox or queue before relying on it for business-critical asynchronous processing.

*EFL — Internal · SBMS v13.4*
