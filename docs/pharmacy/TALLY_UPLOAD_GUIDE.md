# Tally upload guide — which file, from which folder

Operator-facing companion to [TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md).
Everything below is what the portal actually accepts; the parsers are in
`apps/pharmacy/lib/tally/` and the format dispatch is decided by file **content**,
not by the extension.

What the dates mean — requested, sent to Tally, echoed by Tally, and actually
read — is traced separately in
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md). The first run against
a real Tally installation on Windows, start to finish, is
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md).

The Tally cut-over is a **one-time** migration, reachable only by the pharmacy
administrator, and it locks itself once applied.

---

## Pick one of three routes

| Route | What you upload | Where it comes from | Use when |
|---|---|---|---|
| **A. Tally Bridge** (recommended) | nothing — no file picking | Tally itself, over its local HTTP port | Tally is installed on, or reachable from, the pharmacy PC |
| **B. Tally XML export** | one `.xml` file | Tally's own export, saved wherever you choose | You can export from Tally but not run the bridge |
| **C. Synapse template** | one `.xlsx` or `.csv` file | Downloaded from the Tally Cut-over page | Tally cannot export, so you key the data into the template |

You do **not** upload a folder, a backup, or Tally's company data. The browser
takes a single file.

---

## Route A — Tally Bridge (no file to choose)

Run this on the Windows PC where the pharmacy portal is used. It can also reach
a Tally server on the private LAN.

**Folder:** `apps/tally-bridge` in this repository — that folder alone. The
bridge imports nothing outside Node.js, so there is no `npm install` step and no
need for the rest of the repository. Node.js 22 is the only prerequisite.

```powershell
cd C:\SynapseOS
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$env:SYNAPSE_TALLY_BRIDGE_TOKEN = -join ($bytes | ForEach-Object { $_.ToString("x2") })
$rng.Dispose()

$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "https://pharm.synapseos.tech"
$env:SYNAPSE_TALLY_TARGET_HOST = "127.0.0.1"
$env:SYNAPSE_TALLY_TARGET_PORT = "9000"
$env:SYNAPSE_TALLY_EXECUTABLE = "C:\Program Files\TallyPrime\tally.exe"   # optional
# $env:SYNAPSE_TALLY_FROM_DATE = "20200401"                                # optional; omit for full history
# $env:SYNAPSE_TALLY_TO_DATE = "20260331"                                  # optional; defaults to today

Write-Host "Copy this token into the portal: $env:SYNAPSE_TALLY_BRIDGE_TOKEN"
node apps\tally-bridge\src\cli.mjs
```

What it does: asks Tally for its masters (one collection per type) and its
vouchers (the `Voucher Register`) and pushes the result through the same preview
as a manual upload.

- **Opening balances and history** reads the masters once, then the voucher
  history one date range at a time. The portal takes the period you entered on
  the page, splits it into ranges, and sends each range to the bridge with its
  own `from` / `to`. A range Tally returns too large is halved and read again;
  a failed range is retried, and the extraction resumes from the ranges already
  read rather than starting over. Nothing is trimmed to make a range fit.
- **Closing balances only** reads masters in a single request. The masters
  request carries the end date because Tally only reports each ledger's and
  stock item's **closing balance** when `SVTODATE` is part of the request. Set
  the period end on the page to the date the balances should close on.

`SYNAPSE_TALLY_FROM_DATE` and `SYNAPSE_TALLY_TO_DATE` are only fallbacks for a
request that states no dates; the portal always states them, so what you type on
the page is what Tally is asked for. The bridge answers each request with the
range, company, mode and scope it actually served, and the portal refuses a
response whose answer does not match its request.

Then in the portal: **Tally Cut-over**. The page builds this same command from
the portal's own origin plus the Tally host, port, program path and start date
you enter above it, behind a **Copy command** button — so you never type the
token or the origin by hand.

### Or let the setup assistant do it

**Set up Tally connection**, in the banner at the top of Tally Cut-over, walks
through the same thing on screen: paste the token, **Check My Computer**, fix
whatever the check reports, verify, choose the company, done. It fills in the
fields Step 1 uses, so nothing is retyped afterwards. See
[TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md) for the
connector installer that sits behind it.

The check is one read-only call to the bridge (`GET /api/tally/preflight`). It
returns a verdict per prerequisite — Windows build, Node version, disk space,
connector files, bind address, token, allowed origin, Tally install, port 9000,
open company, pinned company, portal HTTPS, read-only guarantee, and whether
this page understands the connector's contract version. Each row says what was
measured and what to do about it. It uploads nothing and reads no balances.

It blocks only on a check that is both required and `missing`/`failed`/`blocked`.
A warning — for example an older Node major, or a portal origin that is plain
HTTP on a LAN address — is shown but does not stop the cut-over.

Paste the token into the token field and press **Check bridge** before
**Connect and review**. It makes one read-only request to the bridge — it does not
export anything — and reports which layer is failing:

| Result on the page | Meaning |
|---|---|
| Bridge is running and Tally answered | ready to connect |
| Bridge is running, but nothing answered at `http://127.0.0.1:9000` | Tally is closed, or its HTTP server is disabled |
| The bridge is running, but it did not accept this token | the field and the command hold different tokens |
| Nothing answered at `127.0.0.1:17890` | the bridge is not running on this computer, or it does not allow this page's origin |

The last line covers two causes because the browser cannot read a cross-origin
failure: a bridge that is stopped and a bridge that rejects the origin look
identical from the page. If the bridge is running, check that
`SYNAPSE_TALLY_ALLOWED_ORIGINS` names this page's origin exactly, with no
trailing slash.

When Tally answers, **Check bridge** also lists the companies Tally currently
has open and names the edition it detected. Pick the company on the page and the
command above pins it with `SYNAPSE_TALLY_COMPANY`. The bridge reads that
variable at start-up, so if you change the company, run the command again before
**Connect and review**. The pin is required: leaving it blank makes the bridge
refuse every export with `TALLY_BRIDGE_COMPANY_UNPINNED`, so pick the company on
the page and run the command again.

| Variable | Meaning |
|---|---|
| `SYNAPSE_TALLY_BRIDGE_TOKEN` | 64 hex chars; required; pasted into the portal |
| `SYNAPSE_TALLY_ALLOWED_ORIGINS` | exact portal origin, HTTPS |
| `SYNAPSE_TALLY_TARGET_HOST` / `_PORT` | where Tally's HTTP server listens (default `127.0.0.1:9000`) |
| `SYNAPSE_TALLY_COMPANY` | required; pins the company. Without it the bridge refuses every export |
| `SYNAPSE_TALLY_EXECUTABLE` | optional; Tally is launched only if port 9000 is not already accepting |
| `SYNAPSE_TALLY_FROM_DATE` | optional fallback; `YYYYMMDD`; used only when a request states no dates (default `19000101`) |
| `SYNAPSE_TALLY_TO_DATE` | optional fallback; `YYYYMMDD`; used only when a request states no dates (default today) |

The bridge listens only on `127.0.0.1:17890`. It cannot type a Tally password or
pick a company — open Tally, sign in, select the correct company, then connect.

This page requires connector **0.2.0** and bridge contract **2** (which adds the
prerequisite endpoint). An older connector still exports, but the page reports it
as incompatible and asks for the installer; it does not fall back silently.

---

## Route B — Tally XML export

In Tally Prime, export **All Masters** and **Day Book** to XML
(`Gateway of Tally → Export → Data`), choosing the output folder yourself. This
route uses Tally's own reports; the bridge does not, because `All Masters`
answers empty and `Day Book` ignores the dates on some builds.
Upload the resulting `.xml`. Any folder on the machine is fine — the portal
upload is a file picker, not a folder watcher.

The file is accepted when it parses as XML and carries these record elements:

```
VOUCHER  LEDGER  GROUP  STOCKITEM  STOCKGROUP  UNIT  GODOWN  COMPANY
```

Refused: anything containing a DTD or entity declaration (`<!…`), files over
**25 MB**, and non-UTF-8 XML. A renamed file is still detected by its bytes.

If the export is larger than 25 MB, narrow the Day Book date range and export
again — the cut-over is resumed from its existing session, not restarted. (A
live extraction over the bridge avoids this: it reads one range at a time and
halves a range Tally returns too large.)

---

## Route C — Synapse templates

Two download buttons sit on the Tally Cut-over page:

- **Excel template** → `/api/admin/tally/template` → `tally-import-template.xlsx`
- **CSV template** → `/api/admin/tally/template?format=csv` → `tally-import-template.csv`

Fill the download in place and upload that same file. Do not re-save it through
another tool that renames the sheets or columns.

Sheets in the workbook, and their required columns:

| Sheet | Required | Optional |
|---|---|---|
| `Meta` | `key`, `value` | — |
| `Accounts` | `name`, `parent` | `guid`, `opening_balance`, `closing_balance`, `email`, `phone`, `address` |
| `StockItems` | `name` | `guid`, `parent`, `unit`, `opening_quantity`, `opening_rate`, `opening_value`, `closing_quantity`, `closing_value` |
| `StockBatches` | `stock_item` | `batch`, `expiry`, `quantity`, `amount`, `godown` |
| `Vouchers` | `id`, `type`, `date` | `guid`, `number`, `party`, `narration`, `currency`, `cancelled` |
| `VoucherLines` | `voucher_id`, `ledger` | `debit`, `credit`, `narration`, `party` |
| `StockLines` | `voucher_id`, `stock_item` | `quantity`, `unit`, `rate`, `amount`, `godown`, `batch`, `expiry`, `account_ledger` |
| `BillAllocations` | `ledger`, `name`, `amount` | `bill_type`, `credit_days` |

`Meta` carries `company`, `company_guid`, `currency`, `period_from`, `period_to`.

In the CSV template every row is discriminated by a `record_type` column whose
value is one of: `meta`, `account`, `stock_item`, `stock_batch`, `voucher`,
`voucher_line`, `stock_line`, `bill`. An unknown `record_type` is rejected
rather than skipped, so a typo cannot silently drop vouchers.

Unknown or duplicated column headers are rejected per sheet.

---

## What never to upload here

- **Tally's company data folder** — the path set in Tally under the company's
  data path. Tally manages those files; copying or parsing them is unsupported.
- **A normal one-sheet Tally Excel report.** It has no linked masters, opening
  balances, batches, or voucher lines, so it is not a company export. For a
  plain stock list, use **Portal → Import Assistant**, which adds quantities as
  stock receipts rather than treating them as an absolute balance.
- **Zipped files or other archives.** A `.zip` is read as Unicode text unless
  the name ends in `.xlsx`, and is refused.
- **Anything over 25 MB.**

---

## Where each thing lives

| Thing | Location |
|---|---|
| Bridge source | `apps/tally-bridge` |
| Connector installer | `apps/tally-bridge/scripts/synapse-tally-connector.ps1` |
| Connector launcher | `apps/tally-bridge/scripts/Start-SynapseTallyConnector.ps1` |
| Setup assistant | `apps/pharmacy/components/tally/tally-setup-assistant.tsx` |
| Installed connector (Windows) | `%LOCALAPPDATA%\Synapse\TallyConnector` |
| Portal page | `apps/pharmacy/app/portal/tally-import/page.tsx` |
| Parsers | `apps/pharmacy/lib/tally/` |
| Uploaded import files (server side) | Supabase storage bucket `pharmacy-imports`, path `tenants/<tenant>/imports/<session>/source.<ext>` |
| Tally program folder | wherever Tally is installed, e.g. `C:\Program Files\TallyPrime\` |
| Tally company data folder | **never uploaded** |
| Your export / filled template | any local folder you choose |

---

## Two ways to start

The page asks what the export carries before it reads the file.

| Mode | What it posts | When to use it |
|---|---|---|
| **Opening balances and history** | Tally's opening balances, then every Day Book voucher replayed on top | You want the pharmacy's history in Synapse — reports, customer debt and stock movement from the Tally period onwards. |
| **Closing balances only** | The balances the export closes on, taken as the opening; no voucher is posted | You want to start Synapse from where Tally stands today and keep the history in Tally. Nothing from the Day Book is posted. |

In closing mode the cut-over date defaults to the date the export closes on
(`SVTODATE`). If it closes on a different date from the one you chose, the
review blocks until the two agree. Ledgers without a closing balance are
reported and left at zero. Stock items whose master batches were taken at the
period start rather than at the close are dropped, because those quantities are
not today's stock; supply the closing batches in the `StockBatches` sheet.

---

## After the upload

Preview → mapping → reconciliation → apply. Nothing is written to Synapse until
the administrator applies a validated plan, and a completed cut-over blocks
further Tally imports for that tenant.

### Live extraction — what the page shows while it reads

A live extraction is read range by range. Under **Progress** the page lists how
many ranges are complete, which dates they cover, and any range that failed with
its reason and attempt count. **Retry unfinished ranges** resumes from the
manifest the server saved, so ranges already read are not read again.

When every range is complete the page merges them and shows:

- master records, with duplicates and conflicting duplicates counted
- vouchers read versus vouchers unique, so a re-delivered range is visible
- cancelled vouchers, and undated or keyless vouchers kept rather than dropped
- voucher types the cut-over cannot post, with counts and a reason
- amounts per voucher type, for comparing against Tally's own report

**Apply stays disabled until every range is read and no blocking exception
remains.** A merge that had no independent source count is shown as
**unverified** and needs the acknowledgement described below.

### Opening and closing stock

The review shows the stock valuation Tally's profit and loss account presents
for the exported period: the total **opening stock** and **closing stock**, and
each item's opening and closing value. They come from `OPENINGVALUE` and
`CLOSINGVALUE` on the stock items (or from the template's `opening_value` and
`closing_value` columns).

These figures are shown for comparison and are never adjusted to make the two
sides agree. In opening-balances mode the cut-over posts the opening stock you
reviewed and the transactions you imported; it never posts a closing balance. In
closing-balances mode the closing figures are what it posts, as the opening.

If the export carries opening values but no closing values, the review says so
and the closing total is left unavailable rather than shown as zero. To get a
closing figure, export Tally's stock summary, or set the export period to end on
the cut-over date.

## Turning the cut-over on

The cut-over is **closed by default in production**. While it is closed, every
cut-over route answers `503` with `code: "TALLY_CUTOVER_DISABLED"`, and this page
shows the closed state instead of the upload and bridge controls. The Excel and
CSV template downloads stay available — they read nothing and write nothing.

| Environment | Default | How to change it |
|---|---|---|
| production | closed | set `SYNAPSE_TALLY_CUTOVER_ENABLED=true` and redeploy |
| anything else | open | set `SYNAPSE_TALLY_CUTOVER_ENABLED=false` to close |

The flag is checked on every request, but a server-side variable change reaches
the running deployment only when it is redeployed. Setting the variable back to
`false`, or removing it, closes the cut-over again the same way.

Production support stays disabled until the TallyPrime and Tally.ERP 9 runtime
gates in the architecture document have recorded evidence. The bridge has **not**
been round-tripped against a live Tally installation from this repository.
