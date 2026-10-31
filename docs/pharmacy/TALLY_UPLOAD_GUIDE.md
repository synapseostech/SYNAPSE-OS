# Tally upload guide — which file, from which folder

Operator-facing companion to [TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md).
Everything below is what the portal actually accepts; the parsers are in
`apps/pharmacy/lib/tally/` and the format dispatch is decided by file **content**,
not by the extension.

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

**Folder:** `apps/tally-bridge` in this repository.

```powershell
npm install
$env:SYNAPSE_TALLY_BRIDGE_TOKEN = "<64 hex characters>"
$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "https://pharm.synapseos.tech"
$env:SYNAPSE_TALLY_TARGET_HOST = "127.0.0.1"
$env:SYNAPSE_TALLY_TARGET_PORT = "9000"
$env:SYNAPSE_TALLY_EXECUTABLE = "C:\Program Files\TallyPrime\tally.exe"
npm run start --workspace @synapse/tally-bridge
```

Then in the portal: **Tally Cut-over → paste the token → Connect and review**.

What it does: asks Tally for exactly two reports, `All Masters` and `Day Book`
(bounded by `SYNAPSE_TALLY_FROM_DATE`, default `19000101`), combines them, and
pushes the result through the same preview as a manual upload.

| Variable | Meaning |
|---|---|
| `SYNAPSE_TALLY_BRIDGE_TOKEN` | 64 hex chars; required; pasted into the portal |
| `SYNAPSE_TALLY_ALLOWED_ORIGINS` | exact portal origin, HTTPS |
| `SYNAPSE_TALLY_TARGET_HOST` / `_PORT` | where Tally's HTTP server listens (default `127.0.0.1:9000`) |
| `SYNAPSE_TALLY_COMPANY` | optional; pins the company, otherwise the open company is used |
| `SYNAPSE_TALLY_EXECUTABLE` | optional; Tally is launched only if port 9000 is not already accepting |
| `SYNAPSE_TALLY_FROM_DATE` | optional; `YYYYMMDD` |

The bridge listens only on `127.0.0.1:17890`. It cannot type a Tally password or
pick a company — open Tally, sign in, select the correct company, then connect.

---

## Route B — Tally XML export

In Tally Prime, export **All Masters** and **Day Book** to XML
(`Gateway of Tally → Export → Data`), choosing the output folder yourself.
Upload the resulting `.xml`. Any folder on the machine is fine — the portal
upload is a file picker, not a folder watcher.

The file is accepted when it parses as XML and carries these record elements:

```
VOUCHER  LEDGER  GROUP  STOCKITEM  STOCKGROUP  UNIT  GODOWN  COMPANY
```

Refused: anything containing a DTD or entity declaration (`<!…`), files over
**25 MB**, and non-UTF-8 XML. A renamed file is still detected by its bytes.

If the export is larger than 25 MB, narrow the Day Book date range and export
again — the cut-over is resumed from its existing session, not restarted.

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
| `StockItems` | `name` | `guid`, `parent`, `unit`, `opening_quantity`, `opening_rate`, `opening_value` |
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
| Portal page | `apps/pharmacy/app/portal/tally-import/page.tsx` |
| Parsers | `apps/pharmacy/lib/tally/` |
| Uploaded import files (server side) | Supabase storage bucket `pharmacy-imports`, path `tenants/<tenant>/imports/<session>/source.<ext>` |
| Tally program folder | wherever Tally is installed, e.g. `C:\Program Files\TallyPrime\` |
| Tally company data folder | **never uploaded** |
| Your export / filled template | any local folder you choose |

---

## After the upload

Preview → mapping → reconciliation → apply. Nothing is written to Synapse until
the administrator applies a validated plan, and a completed cut-over blocks
further Tally imports for that tenant.

Production support stays disabled until the TallyPrime and Tally.ERP 9 runtime
gates in the architecture document have recorded evidence. The bridge has **not**
been round-tripped against a live Tally installation from this repository.
