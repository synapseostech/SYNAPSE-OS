# Tally migration architecture

> Operator instructions — which file to upload, from which folder — are in
> [TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md).

## Goal

Move an existing Tally pharmacy into Synapse without creating a second inventory,
accounting, or clinical authority. Version one is file-based and remains staged
until an authorised operator commits it.

## Current boundary

The pharmacy portal imports a Tally XML export, or the provided XLSX/legacy XLS/CSV templates,
through a reviewed and resumable cut-over flow. A local Windows bridge now reads
Tally's `All Masters` and `Day Book` XML reports over HTTP and sends their
combined response through the same staged upload and preview. It never writes
to Tally or directly to Synapse domain tables.

Cut-over actions are restricted to pharmacy administrators, and a completed
cut-over blocks further imports for that tenant. The bridge is a pilot
implementation: TallyPrime and Tally.ERP 9 must each pass a test-company
round-trip before either is described as production-supported.

### Spreadsheet and company-data scope

The cut-over's Excel and CSV uploads use the downloadable multi-sheet Synapse
templates. A normal one-sheet Tally Excel report does not contain the linked
masters, opening balances, stock batches, and voucher lines needed for a
complete company migration. Use the stock import assistant for a single-sheet
stock list; its quantities are added as stock receipts, not treated as an
absolute balance.

The browser cannot read a user's local Tally data directory. Tally's company
files are application-managed, so the supported full-history route is to ask
Tally itself for `All Masters` and `Day Book` through its local XML/HTTP
interface, or to prepare the supplied templates. Do not copy or parse Tally's
raw company files directly. The migration covers the data represented by the
supported reports and Synapse templates, not every possible Tally module.

The database migration
[`20261030120000_pharmacy_tally_cutover_lock.sql`](../../supabase/migrations/20261030120000_pharmacy_tally_cutover_lock.sql)
must be applied before deploying this version. It reserves one import session
per pharmacy and serializes apply requests with a 15-minute lease; retries
reacquire the lease for that same session. Once applying starts, resume that
session rather than creating or discarding another one.

### Run the Windows bridge

Use Node.js 22 on the Windows computer where the pharmacy portal browser runs.
That computer can also run Tally, or reach a Tally HTTP server on the private
pharmacy LAN. The bridge itself listens only on `127.0.0.1`.

In PowerShell from the repository root:

```powershell
npm install

$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$env:SYNAPSE_TALLY_BRIDGE_TOKEN = -join ($bytes | ForEach-Object { $_.ToString("x2") })
$rng.Dispose()

# Use the exact origin in the browser address bar for the pharmacy portal.
$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "https://pharm.synapseos.tech"

# Same PC as Tally: 127.0.0.1. Another Tally PC: its private IPv4 address.
$env:SYNAPSE_TALLY_TARGET_HOST = "127.0.0.1"
$env:SYNAPSE_TALLY_TARGET_PORT = "9000"

# Set this to the installed Tally executable to auto-launch local Tally if needed.
$env:SYNAPSE_TALLY_EXECUTABLE = "C:\Program Files\TallyPrime\tally.exe"

# Print the one-time token so it can be pasted into the admin portal.
Write-Host "Copy this token into the portal: $env:SYNAPSE_TALLY_BRIDGE_TOKEN"
npm run start --workspace @synapse/tally-bridge
```

Keep the terminal open. Sign in to the pharmacy portal as the pharmacy
administrator, open **Tally Cut-over**, paste the token shown by
`$env:SYNAPSE_TALLY_BRIDGE_TOKEN`, and choose **Connect and review**. The browser
uploads the returned XML to the private import bucket and opens the existing
preview. The token is not stored by the page. The operator must review the
company, mapping, opening balance, exceptions, and reconciliation before
explicitly applying the cut-over.

The bridge launches the configured executable only when the local HTTP port is
not already accepting connections. It cannot enter a Tally password or choose a
company; the operator must sign in and open the correct company, then retry the
export if Tally is waiting at its company-selection screen.

For Tally on another LAN computer, set `SYNAPSE_TALLY_TARGET_HOST` to that
computer's private IPv4 address. Enable Tally's HTTP server on port 9000 and
allow port 9000 only from the bridge computer on the private network. Never
expose Tally's HTTP port to the public internet. `SYNAPSE_TALLY_COMPANY` may be
set to pin the company name; otherwise the active Tally company is used and must
be checked in the preview. `SYNAPSE_TALLY_FROM_DATE` accepts `YYYYMMDD` and
defaults to `19000101`.

The bridge is a user-started, one-shot migration tool, not a Windows service or
continuous synchronizer. The combined result is subject to the existing 25 MB
limit. Its XML request shape follows the official [Tally XML integration
guide](https://help.tallysolutions.com/xml-integration/); live compatibility
with the pharmacy's TallyPrime and Tally.ERP 9 test companies remains a release
gate.

## Existing and reusable

- `portal/import-assistant` and `api/admin/import-sessions` provide the current
  staged import session and review surface.
- `api/admin/inventory/bulk-upload` and `packages/db/src/import-validation.ts`
  provide row validation and the existing inventory authority.
- `import_batches`, `import_batch_rows`, `import_column_mappings`, and
  `pharmacy_import_sessions` are the canonical staging records.
- Pharmacy products, packages, batches, suppliers, customers, purchases, sales,
  stock movements, billing, FEFO, RLS, tenant checks, audit, and idempotency
  remain the canonical domain services.

## Remaining release work

1. **Windows runtime gate:** run on the supported Node.js 22 Windows runtime;
   verify a clean bridge start, local-only binding, Tally launch when configured,
   helpful failure when the executable or HTTP server is unavailable, and safe
   shutdown. This repository's Linux tests do not satisfy this gate.
2. **TallyPrime and Tally.ERP 9 gates:** run separately against isolated test
   companies, never production. For each edition, verify report availability,
   selected-company identity, date boundaries, stock batches, opening values,
   voucher completeness, cancellation handling, and exports near the 25 MiB
   limit. Save the original Tally totals, the bridge preview, exception report,
   and post-apply reconciliation as release evidence.
3. **End-to-end gate:** complete upload and preview on a dedicated Synapse test
   tenant for each edition. Confirm company identity, medicines and pack units,
   godowns, batch quantities/expiry, opening balances, voucher totals, and every
   blocking or warning exception against Tally. Apply only after a reviewer
   approves the reconciliation; verify resulting balances, audit history, and
   retry behavior. Do not use a live tenant for this test.
4. Confirm the cut-over lock migration is present in the target database and
   verify that a second session and concurrent apply request are rejected.
5. Expand extraction beyond the standard `All Masters` and `Day Book` reports
   where the pharmacy needs additional fields or historical stock detail. Tally
   editions and configurations can return different fields.
6. Keep the existing mapping/review step explicit for medicine identity, units,
   categories, godowns, suppliers, customers, batches, and transactions. Do not
   fuzzy-match a medicine directly into sellable stock.
7. Define and test a compensating rollback for a committed cut-over. A Tally
   import must never create a clinical prescription or diagnosis.
8. Add a signed Windows installer/service only after the pilot flow is proven.
   The current bridge is a user-started Node.js process and must not be presented
   as unattended synchronization.

Production support must remain disabled until all three runtime/edition gates
above have evidence and the open rollback/reconciliation work is accepted.

## Required flow

`analyse → map → stage → validate → reconcile → dry run → commit → verify → cutover`.

Masters precede inventory; inventory precedes transactions; accounting and
reconciliation follow the dependent phases. Every phase is tenant-scoped,
audited, retry-safe, and idempotent on `(source_system, company_identity,
source_object_id, source_hash)`.

## Input safety

Uploads are untrusted. Enforce MIME/size/row limits, reject XML entities and
malformed documents, parse JSON safely, never execute spreadsheet formulas, and
neutralise CSV formula prefixes. Raw imported HTML is never rendered.

## Identity and matching

Prefer Tally GUID, then SKU/barcode, normalized exact name, and finally a
suggestion-only fuzzy match. Deterministic matches may auto-map; medium and low
confidence matches require review. Strength, dosage form, and pack size are part
of medicine identity—similar names must not collapse.

## Safety gates

No production writes during analysis, mapping, or dry-run. Missing batch expiry is
an explicit `EXPIRY_MISSING` exception and does not become sellable stock without
policy approval. Commit requires reconciliation approval, audit success, and
idempotency checks. Rollback is a compensating action, never deletion of source
history. Production database resets and automatic migration repair are out of
scope.

## Future synchronization

The local bridge is for one-time cut-over only. Ongoing Tally-to-Synapse or
Synapse-to-Tally synchronization is a separate project requiring connection
credentials, change detection, durable queues, conflict rules, reconciliation,
and per-tenant revocation. Do not reuse this one-shot import button as a live
sync control.
