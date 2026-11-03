# Tally period semantics — what each date means, and what it proves

Companion to [TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md) and
[TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md).

The cut-over uses the word "period" for four different values that travel
through different systems. They are not interchangeable, and none of them on its
own proves that every record in the window was exported. This document traces
each one from the portal to persisted evidence and states plainly where the
answer depends on a real Windows/Tally installation.

---

## The four periods

| # | Period | Where it is stated | Where it is recorded | What it proves |
|---|---|---|---|---|
| 1 | **Requested** — the range the operator typed | Portal date fields (`tallyFromDate`, `tallyToDate`), `app/portal/tally-import/page.tsx` | Preview body `period`; persisted as `manifestEvidence.requestedPeriod` | Only the operator's intent. It says nothing about what Tally returned. |
| 2 | **Sent to Tally** — the range in the export request | Bridge query parameters `from` / `to`, else the launch defaults `SYNAPSE_TALLY_FROM_DATE` / `SYNAPSE_TALLY_TO_DATE` | Not persisted in the file; returned in the `x-synapse-tally-from` / `-to` echo headers, which the client checks | What the bridge asked for. It is not echoed back into the packaged file. |
| 3 | **Echoed by Tally** — the range in Tally's response | `<SVFROMDATE>` / `<SVTODATE>` in Tally's envelope, if Tally emits them | Carried into the packaged `<DATA>` only when the bridge can attach it (see below); then `manifest.period` with `periodSource: "source"` and `manifestEvidence.declaredPeriod` | What Tally said the export covered. It is a statement by the source, not an independent count. |
| 4 | **Actual voucher range** — first and last voucher date read | Derived from the parsed vouchers | Per-chunk `firstDate` / `lastDate`; `manifestEvidence.voucherRange` | What was actually read. It does not prove that nothing else existed outside that range. |

## 1. Requested period — portal to server

The two date fields are the only period the operator sees.

- For a **live extraction**, the page sends the period with every bridge request
  (`from` / `to` query parameters) and again to the portal server when the
  extraction begins, so the server builds the chunk manifest from the same dates
  (`beginLiveExtraction` in `apps/pharmacy/lib/tally/live-extraction.ts`).
- For a **closing cut-over** the period is only used to ask for masters, since
  no voucher history is read.
- For **every route**, the page sends the same dates as `period` in the body of
  `POST /api/admin/tally/[id]/preview`
  (`requestedPeriod()` in the page, then
  `apps/pharmacy/app/api/admin/tally/[id]/preview/route.ts`). The route rejects
  a malformed period with `TALLY_PERIOD_BODY_INVALID`; it does not silently drop
  it.
- The requested period is used for the manifest's own period **only when the
  file states no period of its own** (`buildSourceManifest` in
  `apps/pharmacy/lib/tally/manifest.ts`). In that case `periodSource` is
  `"requested"`, and the review says so.

Nothing in the requested period is evidence of coverage. A file that covers one
week is still accepted when one month was asked for — it is accepted as
*unverified* and flagged with `TALLY_PERIOD_MISMATCH`, which is what the operator
must see and acknowledge.

## 2. Period sent to Tally — portal to bridge to Tally

The bridge accepts a period **per request** (`readRequestedPeriod` in
`apps/tally-bridge/src/bridge.mjs`):

```
POST http://127.0.0.1:17890/api/tally/export?mode=opening&scope=vouchers&from=20260201&to=20260228&company=Test%20Pharmacy
```

- `from` / `to` accept `YYYY-MM-DD` or `YYYYMMDD`. Stating only one bound is
  refused with `TALLY_BRIDGE_PERIOD_INCOMPLETE` rather than half-applied; an
  inverted range is `TALLY_BRIDGE_PERIOD_INVALID`.
- `scope` is `all` (the single-file behaviour), `masters` (read once per
  migration) or `vouchers` (one date chunk). A closing cut-over may ask for
  `masters` only; `vouchers` in closing mode is `TALLY_BRIDGE_SCOPE_CONFLICT`.
- `company`, when supplied, must agree case-insensitively with
  `SYNAPSE_TALLY_COMPANY`. It never replaces the pin; naming a company while
  nothing is pinned is `TALLY_BRIDGE_COMPANY_UNPINNED`, and a different name is
  `TALLY_BRIDGE_COMPANY_MISMATCH`.
- A request that states none of these falls back to the launch defaults
  (`SYNAPSE_TALLY_FROM_DATE`, default `19000101`; `SYNAPSE_TALLY_TO_DATE`,
  default today), so an older caller keeps working.

Every export request then carries the resolved period in its envelope
(`buildTallyExportRequest`):

```xml
<STATICVARIABLES>
  <SVCURRENTCOMPANY>…</SVCURRENTCOMPANY>
  <SVFROMDATE>20260201</SVFROMDATE>
  <SVTODATE>20260228</SVTODATE>
  <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
</STATICVARIABLES>
```

### The echo gate

The bridge answers every export with what it actually served, so the portal does
not have to assume it was obeyed:

| Header | Value |
|---|---|
| `x-synapse-tally-from` | the `YYYYMMDD` sent to Tally |
| `x-synapse-tally-to` | the `YYYYMMDD` sent to Tally |
| `x-synapse-tally-company` | the pinned company |
| `x-synapse-tally-mode` | `opening` or `closing` |
| `x-synapse-tally-scope` | `all`, `masters` or `vouchers` |

`requestBridgeExport` refuses a response that lacks any of them
(`TALLY_BRIDGE_PERIOD_UNVERIFIED`, `TALLY_BRIDGE_SCOPE_UNVERIFIED`) and one
whose echo disagrees with the request (`TALLY_BRIDGE_PERIOD_MISMATCH`,
`TALLY_BRIDGE_COMPANY_MISMATCH`, `TALLY_BRIDGE_MODE_MISMATCH`,
`TALLY_BRIDGE_SCOPE_MISMATCH`). A chunk therefore cannot be recorded against a
different range, company, mode or scope than the one it asked for.

### Chunking

An opening cut-over reads masters once, then one voucher range at a time. The
portal splits the requested period into parts (`splitPeriod`), each charged to
`POST /api/admin/tally/[id]/extract` as its own chunk with a stable id
(`vouchers:<from>:<to>`). A range too large to return is halved and re-read; a
one-day range that is still too large fails rather than being truncated. The
manifest — not the page — is the state the loop resumes from.

## 3. Period echoed by Tally — response to packaged file

Tally's reply may state the range it actually reported. The bridge does not
assume where:

- `echoedDate` reads `<SVFROMDATE>` / `<SVTODATE>` from the response, and
  accepts only a plausible `YYYYMMDD` or `YYYY-MM-DD` value.
- `companyElement` re-emits **only** the dates the response itself stated. A
  missing or malformed echo produces no date tag at all — never the requested
  dates. There is a regression test for this in
  `apps/tally-bridge/src/bridge.test.mjs` ("echoes only the dates the response
  itself stated", "never substitutes the period it asked for…").
- The packaged file has room for that metadata only when the bridge adds its own
  company element, which happens when the masters `<DATA>` does not already name
  the company (`combineTallyExports` / `buildMasterOnlyExport`).

The server-side parser reads the period from a `<COMPANY>` element inside
`<DATA>` (`readCompany` in `packages/db/src/tally-xml-rows.ts`). If no such
element carries dates, `financialPeriod` is empty and the manifest falls back to
the requested period.

Two facts follow, and both need confirming on Windows:

1. **Where Tally Prime puts the company.** The bridge refuses any response whose
   raw XML names no company at all (`assertPinnedCompany`); it reads
   `<COMPANY NAME="…">` or `<COMPANYNAME>…</COMPANYNAME>`, but **not**
   `<SVCURRENTCOMPANY>` in the envelope. A build that echoes the company only as
   `<SVCURRENTCOMPANY>` is therefore refused rather than guessed at — by design,
   since an unverifiable payload is indistinguishable from another company's
   books.
2. **Where Tally Prime puts the period.** If Tally states the period only in the
   envelope while the company sits inside `<DATA>`, the packaged file currently
   carries no period, and the manifest records `periodSource: "requested"`.
   Whether that is what real Tally Prime does — and therefore whether this is a
   gap or the normal case — can only be established with a Windows installation.

## 4. Actual voucher range — what was read

Each voucher chunk records `firstDate` and `lastDate` from the vouchers it parsed.
`buildManifestEvidence` reports these as `voucherRange`, alongside
`recordsRead`, `recordsStaged` and whether an independent source count was
supplied.

Vouchers dated outside the file's declared period are **not dropped** by the
bridge — a regression test packs them through unchanged — and they are **not
ignored** by the review: `buildSourceManifest` raises
`TALLY_VOUCHER_OUTSIDE_PERIOD`, and the chunk itself fails
`TALLY_CHUNK_DATES_OUTSIDE` so the plan blocks even if the stored problem list is
never read. Dropping or trimming those vouchers would make a short export look
complete, which is the failure mode this check exists to prevent.

## What is shown and acknowledged before Apply

The preview and the session reload both return the same evidence block
(`buildManifestEvidence`; persisted as `mapping.manifestEvidence`):

- period used, and whether it came from the source or the request
- period requested
- period stated by the export (if any)
- first and last voucher date actually read
- records read and records staged
- whether an independent source count was supplied
- `coverage: "unverified" | "verified"`

When coverage is `unverified`, the same distinction is preserved everywhere:

- the portal shows an amber evidence panel and a required acknowledgement
  checkbox; Apply stays disabled until it is ticked
- Apply itself refuses with `TALLY_UNVERIFIED_NOT_ACKNOWLEDGED` unless the
  request carries `acknowledgeUnverified: true` **or** a saved acknowledgement
  exists for the current manifest (`manifestUpdatedAt` must match). A
  client-only tick is not accepted.
- the acknowledgement is written to `ai_mapping.unverifiedAcknowledgement` and
  is not read back as a coverage upgrade: `manifestCoverage` stays
  `unverified`, and the audit entry says
  "source completeness unverified, acknowledged by the operator before apply".

A new preview clears both the notice and the saved acknowledgement, so an
acknowledgement can never outlive the evidence it applied to.

## Where Windows/Tally validation is required

None of the following can be established from this codebase. Each needs a real
Tally Prime installation on Windows, and none may be claimed as verified before
that run:

1. Whether `SVFROMDATE` / `SVTODATE` actually constrain **All Masters** and
   **Day Book**, and which of the two respects each bound.
2. Whether Tally states the company inside `<DATA>`, in the envelope as
   `<SVCURRENTCOMPANY>`, or both — and whether that differs between Tally Prime
   releases. (The bridge currently refuses the envelope-only shape.)
3. Whether Tally echoes the export dates at all, in which element, and in which
   format.
4. Whether a Day Book answer can include vouchers outside the requested range,
   and whether it can silently omit vouchers inside it.
5. Whether a changed request period takes effect without relaunching Tally — the
   bridge sends the new dates in each request, but Tally Prime may hold its
   company/period state between calls.
6. Whether the packaged file's synthetic company element is accepted by the rest
   of the import path on a real export.

## The rule

A requested period is not a completeness statement. Neither is an echoed one.
Only an independent count of the source can support "verified", and when none was
supplied the cut-over says `unverified`, shows the evidence, and requires the
operator to acknowledge it before anything is written.
