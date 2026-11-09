from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor

OUT = "docs/EFL_Booking_Portal_Solution_and_Deployment_Guide.docx"


def shade(cell, color):
    props = cell._tc.get_or_add_tcPr()
    item = OxmlElement("w:shd")
    item.set(qn("w:fill"), color)
    props.append(item)


def make_table(doc, headers, rows):
    tab = doc.add_table(rows=1, cols=len(headers))
    tab.style = "Table Grid"
    tab.alignment = WD_TABLE_ALIGNMENT.CENTER
    for i, value in enumerate(headers):
        tab.rows[0].cells[i].text = value
        shade(tab.rows[0].cells[i], "1F4E79")
        for run in tab.rows[0].cells[i].paragraphs[0].runs:
            run.bold = True
            run.font.color.rgb = RGBColor(255, 255, 255)
    for row in rows:
        cells = tab.add_row().cells
        for i, value in enumerate(row):
            cells[i].text = str(value)
            if len(tab.rows) % 2 == 0:
                shade(cells[i], "EAF2F8")
    doc.add_paragraph()


def bullets(doc, items):
    for item in items:
        doc.add_paragraph(item, style="List Bullet")


def steps(doc, items):
    for item in items:
        doc.add_paragraph(item, style="List Number")


def build():
    doc = Document()
    sec = doc.sections[0]
    sec.top_margin = Inches(.65)
    sec.bottom_margin = Inches(.65)
    sec.left_margin = Inches(.7)
    sec.right_margin = Inches(.7)
    doc.styles["Normal"].font.name = "Aptos"
    doc.styles["Normal"].font.size = Pt(9.5)
    doc.styles["Heading 1"].font.color.rgb = RGBColor(31, 78, 121)
    doc.styles["Heading 2"].font.color.rgb = RGBColor(46, 116, 181)
    header = sec.header.paragraphs[0]
    header.text = "EFL BOOKING PORTAL | SOLUTION AND DEPLOYMENT GUIDE"
    header.runs[0].font.size = Pt(8)
    footer = sec.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    footer.add_run("Page ")
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), "PAGE")
    footer._p.append(field)

    title = doc.add_paragraph(style="Title")
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.add_run("EFL Booking Portal\nAzure Solution and Deployment Guide")
    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = sub.add_run("Microsoft Azure architecture, delivery approach, testing and production deployment")
    r.italic = True
    r.font.size = Pt(12)
    make_table(doc, ["Document control", "Value"], [
        ("Application", "EFL Booking Portal / SBMS v13.4.0"),
        ("Review basis", "Complete source inventory under backend, frontend, docs, tests and manifests"),
        ("Prepared", "15 September 2026"),
        ("Status", "Azure solution proposal for test and production readiness"),
        ("Cost basis", "Indicative USD planning estimates, excluding tax and vendor quotations"),
    ])

    doc.add_heading("1. Executive Summary", 1)
    doc.add_paragraph("The EFL Booking Portal is a browser-based freight-forwarding application. The current implementation combines a React 18/Vite single-page application with a Node.js 18+ HTTP API. It supports booking creation and approval, order management, CSV/XLSX imports, document attachments, audit records, reference data, role-based permissions, Cloudwise (CW) booking payload generation, and a tracking command-center experience.")
    doc.add_paragraph("The repository is a functional prototype or pilot baseline rather than a production-ready deployment package. The main readiness items are replacing the in-memory datastore, integrating enterprise identity, moving uploaded files to durable object storage, sourcing live tracking data, adding production observability and CI/CD, and implementing the Cloudwise contract with production credentials and network controls.")
    doc.add_paragraph("Recommended Azure pattern: host the static frontend on Azure Static Web Apps, run the API on Azure App Service or Azure Container Apps, use Azure Database for PostgreSQL Flexible Server, store documents in Azure Blob Storage, protect secrets with Azure Key Vault, authenticate through Microsoft Entra ID, and expose the API through Azure API Management and a WAF-enabled ingress.")

    doc.add_heading("2. Current-State Application Inventory", 1)
    make_table(doc, ["Area", "Observed implementation", "Deployment implication"], [
        ("Frontend", "React 18.3.1, React Router 6, Vite 5, Leaflet and React Leaflet. Pages cover dashboard, bookings, booking detail/create, approvals, orders, imports, admin, audit, completed work and tracking.", "Build static assets and host behind CDN/TLS. Configure API URL and SPA fallback routes."),
        ("Backend", "Node.js ES modules, custom HTTP/router helpers, routes for bookings, approvals, imports, orders, miscellaneous reference/me endpoints and templates.", "Run Node 18+ as managed service with health checks, structured logs and graceful shutdown."),
        ("Persistence", "backend/src/db.js stores users, roles, bookings, orders, approvals, imports and audit data in process memory and seeds demo records.", "Data is lost on restart or scale-out. Production requires PostgreSQL and migrations."),
        ("Authentication", "auth.js resolves a user from demo headers and falls back to a seeded admin user; role can be overridden by a request header.", "Replace with OIDC/OAuth JWT validation, group mapping and token/session policy."),
        ("Authorization", "rbac.js and route handlers enforce role permissions and organization scopes.", "Retain the policy model, persist scopes and test every route with real claims."),
        ("Cloudwise", "cwClient.js supports mock mode and outbound HTTP; cwPayload.js builds XML; booking stores response/status metadata.", "Use secrets manager, egress allow-listing, retries/idempotency and integration monitoring."),
        ("Files/imports", "CSV parser, XLSX reader, booking/order imports, and base64 document content in records.", "Use object storage, malware/content validation, streaming and size/type limits."),
        ("Tracking", "Tracking pages load sample CSV data and calculate route positions on a Leaflet map; several fields remain unavailable.", "Connect an approved live tracking source and define freshness and mapping rules."),
        ("Tests", "Backend smoke and Cloudwise tests exist. Frontend has build/preview scripts but no automated UI suite.", "Add API, authorization, migration, contract, accessibility and browser tests in CI."),
    ])

    doc.add_heading("3. Azure Target Solution Architecture", 1)
    doc.add_paragraph("The application layer is present in the repository. The following Azure services and supporting components are required for a production-capable deployment:")
    make_table(doc, ["Component", "Purpose", "Key requirements"], [
        ("Azure Static Web Apps", "React/Vite static SPA hosting", "Versioned builds, HTTPS, custom domain, SPA fallback and CDN delivery."),
        ("Azure App Service or Container Apps", "Node.js API runtime", "Node 18+, managed identity, health checks, autoscaling, deployment slots and graceful shutdown."),
        ("Azure API Management + Application Gateway WAF", "API ingress and protection", "TLS, JWT policy, rate limits, CORS, request limits, WAF rules and access logs."),
        ("Azure Database for PostgreSQL Flexible Server", "Transactional application data", "Private access, zone redundancy, encryption, backups, migrations, indexes and restore tests."),
        ("Azure Blob Storage", "Documents and import artifacts", "Private containers, encryption, lifecycle, malware scanning and short-lived download URLs."),
        ("Microsoft Entra ID", "Enterprise login and claims", "OIDC, MFA/Conditional Access, group-to-role mapping and user lifecycle."),
        ("Azure Key Vault", "CW and application secrets", "Managed identity access, RBAC, rotation, purge protection and audit logging."),
        ("Azure Monitor + Application Insights + Log Analytics", "Logs, metrics, traces and alerts", "Correlation IDs, CW/import KPIs, latency, errors, saturation and alert routing."),
        ("GitHub Actions or Azure DevOps + Azure Container Registry", "Build, scan, test and promote", "Pinned dependencies, SBOM, image scanning, approvals, slots and rollback."),
        ("Azure integration/network services", "Cloudwise and live tracking connectivity", "VNet integration, private endpoints where supported, controlled egress, DNS and reconciliation."),
    ])

    doc.add_heading("3.1 Azure Environment Topology", 2)
    doc.add_paragraph("Use separate Azure subscriptions or, at minimum, separate resource groups and identities for testing and production. A recommended production topology is a hub-and-spoke virtual network: shared hub services provide controlled DNS, firewall and monitoring, while the application spoke contains the API, PostgreSQL private access, storage private access and integration egress. Keep Static Web Apps public through HTTPS, but restrict the API and data services to approved network paths.")
    make_table(doc, ["Environment", "Azure resources", "Isolation and release policy"], [
        ("Testing", "Static Web Apps, App Service/Container Apps, PostgreSQL Flexible Server, Blob Storage, Key Vault, API Management, Log Analytics and Entra test app registration.", "Synthetic or masked data, CW mock/sandbox mode, separate secrets, budget alerts and automatic deployment from the test branch."),
        ("Production", "Separate subscription/resource group with zone-redundant API/database options, production storage, Key Vault, API Management/WAF, Monitor and Entra production app registration.", "Production data and credentials only; deployment requires approval, tested artifact promotion, backup verification and rollback readiness."),
    ])

    doc.add_heading("4. Functional Scope", 1)
    bullets(doc, [
        "Booking lifecycle: draft, validation, approval rules, completion, Cloudwise submission and CW status capture.",
        "Order lifecycle: create, edit, filter, organization-scoped visibility, link/unlink to bookings, import and CSV template download.",
        "Operations: dashboards, completed records, approvals, audit log, administration and reference/master data endpoints.",
        "Documents: attach, list, download and delete documents on bookings and orders, subject to production storage controls.",
        "Tracking: sample-data command center, shipment search, route visualization and shipment detail; live integration remains outstanding.",
    ])

    doc.add_heading("5. Security, Compliance and Reliability Requirements", 1)
    bullets(doc, [
        "Replace demo identity resolution with OIDC/OAuth 2.0. Validate issuer, audience, expiry, signature and required claims on every protected request.",
        "Use least privilege for application, database, storage, deployment and Cloudwise identities. Separate admin and operational permissions.",
        "Apply TLS in transit and encryption at rest. Never log tokens, credentials, full documents or sensitive payloads.",
        "Add server-side limits for master-data codes, dates, numbers, file types, file size, CSV/XLSX rows and XML payloads.",
        "Add idempotency keys and a durable outbound transaction record for Cloudwise calls. Retry only transient failures.",
        "Use database transactions for approval, booking/order updates and link operations. Keep immutable audit events with actor, time, action and correlation ID.",
        "Define RPO/RTO with the business. An initial planning target is RPO 15 minutes and RTO 4 hours, subject to approval.",
        "Run dependency, container, SAST, DAST, secrets and image scans in CI; patch dependencies through a controlled process.",
    ])

    doc.add_heading("6. Testing Environment Deployment Activities", 1)
    doc.add_paragraph("Keep testing isolated from production data and Cloudwise production endpoints. Use synthetic or masked data and CW sandbox/mock mode unless an integration owner approves a test tenant. Deploy into a dedicated Azure subscription or resource group with separate managed identities and Key Vault secrets.")
    steps(doc, [
        "Confirm owners, cloud/region, DNS, data classification, test identity groups, CW sandbox endpoint and test exit criteria.",
        "Create the Azure test subscription/resource group with Azure Policy, tags, budget alerts, RBAC, VNet integration, private DNS, TLS certificates and non-production Key Vault secrets.",
        "Provision Azure Database for PostgreSQL Flexible Server, Blob Storage containers, Key Vault, Log Analytics, Application Insights, API Management and the App Service/Container Apps target.",
        "Implement schema migrations and seed approved reference data only. Do not use demo users or hard-coded credentials as test identity.",
        "Build from a tagged commit, run dependency/security scans, publish immutable artifacts and deploy through the pipeline.",
        "Configure Static Web Apps, API Management routes/policies, CORS, SPA fallback, health checks, diagnostic settings, alerting, rate limits and environment-specific API/CW settings.",
        "Run smoke, API contract, authentication/RBAC, booking validation/approval, import, document, CW sandbox and browser tests.",
        "Run negative tests for unauthorized scopes, malformed/oversized files, invalid codes, duplicate submissions and CW timeouts.",
        "Test database and object-storage restore, confirm audit records, and document known gaps and evidence.",
        "Obtain business, security, integration and operations sign-off. Promote the exact tested artifact.",
    ])

    doc.add_heading("7. Production Deployment Activities", 1)
    doc.add_paragraph("Production release is gated by test exit criteria, security approval, operational readiness and a rollback rehearsal. Use a separate Azure subscription or production resource group, network, managed identities, Key Vault secrets and data stores.")
    steps(doc, [
        "Approve architecture, service limits, availability target, RPO/RTO, support model, maintenance window and rollback decision makers.",
        "Provision production with Bicep or Terraform: zone-redundant API/database options, Static Web Apps, Blob Storage, API Management/WAF, Azure Monitor, Key Vault, backups and private connectivity.",
        "Complete identity integration, MFA policy, role/group mapping, break-glass admin procedure and user provisioning/deprovisioning.",
        "Migrate reference data and approved legacy records through versioned reversible migrations. Reconcile counts, scopes, statuses and audit history.",
        "Configure Cloudwise production endpoint, Key Vault credentials, certificates, VNet egress and payload/response contract. Validate one controlled transaction.",
        "Configure live tracking source, mapping, freshness alerts, timeout behavior and ownership for unavailable tracking data.",
        "Deploy the tested artifact through GitHub Actions or Azure DevOps using App Service deployment slots or Container Apps revisions. Verify health, errors, latency, DB and storage access.",
        "Run production smoke tests with non-sensitive records: booking, order, approval, audit, documents, search, tracking and CW acknowledgement.",
        "Monitor hypercare, record incidents and reconciliation results, and keep the previous artifact ready for rollback.",
        "Close temporary access, rotate release credentials if required, update runbooks and hand over to support.",
    ])

    doc.add_heading("8. Indicative Azure Cost Model", 1)
    doc.add_paragraph("Estimates are planning figures for a modest workload in one Azure region, in USD. Actual Azure prices vary by region, reservation, consumption, support plan, retention, egress and licensing. Cloudwise, Entra ID and tracking fees require commercial confirmation and are shown as allowances. Validate the final estimate with the Azure Pricing Calculator.")
    make_table(doc, ["Azure component", "Test monthly", "Production monthly", "One-time setup", "Notes"], [
        ("Azure Static Web Apps/CDN", "$25", "$75", "$300", "Frontend, TLS and SPA routing."),
        ("Azure App Service or Container Apps", "$100", "$450", "$1,500", "Test single service; production multi-instance."),
        ("API Management + WAF ingress", "$75", "$250", "$1,000", "Ingress, TLS, rate limiting and WAF."),
        ("Azure Database for PostgreSQL", "$150", "$700", "$3,500", "HA production, backups and migrations."),
        ("Azure Blob Storage + scanning", "$30", "$125", "$1,000", "Private document/import storage."),
        ("Microsoft Entra ID", "$100", "$500", "$2,500", "Integration and user-license allowance."),
        ("Azure Key Vault + certificates", "$35", "$100", "$800", "Keys, secrets and certificates."),
        ("Azure Monitor + Application Insights", "$100", "$400", "$1,500", "Usage and retention sensitive."),
        ("Azure DevOps/GitHub + Container Registry", "$75", "$200", "$2,000", "Build, SBOM and security scanning."),
        ("Azure VNet, DNS, Firewall and egress", "$75", "$250", "$1,000", "Private network and integration egress."),
        ("Cloudwise fees", "$0-$500", "$500-$2,500", "$3,000", "Placeholder; confirm commercial terms."),
        ("Live tracking source/API", "$0-$500", "$500-$3,000", "$2,500", "Placeholder; current source is sample CSV."),
        ("QA/security/performance", "$150", "$300", "$4,000", "Automation, DAST and performance baseline."),
        ("Operations/support", "$500", "$1,500", "$2,000", "Runbooks, on-call and support allowance."),
    ])
    make_table(doc, ["Estimate", "Amount"], [
        ("Test recurring subtotal excluding variable/vendor ranges", "$1,415/month"),
        ("Production recurring subtotal excluding variable/vendor ranges", "$5,050/month"),
        ("Planning range including Cloudwise/tracking allowances", "Test: $1,415-$2,415/month; Production: $6,050-$10,550/month"),
        ("Indicative one-time implementation subtotal", "Approximately $26,100"),
        ("Recommended contingency", "15%-25% for quotes, migration, security and scaling"),
    ])
    doc.add_paragraph("These are not quotations. Refresh the estimate after sizing concurrent users, requests, database growth, document volume, retention, tracking events, regions, identity licensing and Cloudwise terms.")

    doc.add_heading("9. Delivery Work Breakdown", 1)
    make_table(doc, ["Workstream", "Activities", "Acceptance evidence"], [
        ("Application hardening", "Replace memory DB, migrations, durable files, limits and idempotency.", "Automated tests, migrations, restore evidence and release artifact."),
        ("Identity/access", "OIDC, claims mapping, scope enforcement, MFA and lifecycle.", "RBAC matrix, test results and access review."),
        ("Integration", "Cloudwise contract, secrets, egress, retries, reconciliation and tracking.", "Connectivity evidence and contract tests."),
        ("Platform", "Network, runtime, DB, storage, WAF, CDN, CI/CD and observability.", "Infrastructure plan, logs, dashboards and alerts."),
        ("Quality/operations", "Browser/API/security/performance tests, runbooks, restore and hypercare.", "Test report, rollback rehearsal and sign-offs."),
    ])

    doc.add_heading("10. Risks, Assumptions and Decisions Required", 1)
    bullets(doc, [
        "Choose cloud provider, supported regions, availability target and data residency requirements.",
        "Confirm whether seeded data is prototype-only; decide whether any records require migration.",
        "Confirm Cloudwise authentication, endpoint, rate limits, payload/response contract and pricing.",
        "Provide a live tracking source and ownership model; sample CSV does not provide production status and milestone data.",
        "The repository has no visible infrastructure-as-code, container definition, CI workflow, migration framework or frontend automated tests.",
        "Base64 in-memory document storage creates availability, memory, privacy and scale risk until object storage is implemented.",
        "One-region modest-usage estimates can increase materially for multi-region HA, premium support, large files or high-volume tracking.",
    ])

    doc.add_heading("11. Recommended Go-Live Exit Criteria", 1)
    bullets(doc, [
        "No critical/high security findings; secrets scan is clean; production secrets are externalized.",
        "Migrations, backup/restore, object recovery and rollback have been rehearsed and evidenced.",
        "OIDC authentication and every role/organization rule pass automated tests.",
        "Cloudwise connectivity and idempotent retry behavior pass approved contract tests with monitoring.",
        "Live tracking is connected or explicitly deferred with business ownership.",
        "Performance, accessibility, browser compatibility and API smoke tests meet agreed thresholds.",
        "Operations owns dashboards, alerts, runbooks, on-call contacts, incident process and reconciliation.",
        "Business, security, integration, data and operations owners sign the release approval.",
    ])

    doc.add_heading("Appendix A. Repository Evidence Reviewed", 1)
    make_table(doc, ["Evidence", "Coverage"], [
        ("backend/server.js and backend/src", "Runtime, auth, RBAC, data model, validation, routes, Cloudwise, imports and HTTP behavior."),
        ("backend/test", "Smoke and Cloudwise tests."),
        ("frontend/src", "Routing, API client, auth context, components, pages, tracking data and styles."),
        ("Manifests and lockfiles", "Node version, React/Vite/Leaflet dependencies and scripts."),
        ("README.md and docs/CW_INTEGRATION.md", "Existing setup and Cloudwise integration guidance."),
        ("CSV files and public tracking sample", "Tracking, shipment and field-mapping sample data."),
    ])
    end = doc.add_paragraph()
    end.alignment = WD_ALIGN_PARAGRAPH.CENTER
    end.add_run("End of document").italic = True
    doc.save(OUT)


if __name__ == "__main__":
    build()
    print(OUT)
