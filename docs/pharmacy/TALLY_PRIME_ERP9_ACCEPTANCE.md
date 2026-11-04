# TallyPrime and Tally.ERP 9 — external acceptance checklist

Two named migration targets, one shared protocol. This document says what is
already implemented in code for each edition, exactly what has to be run on a
Windows machine with a real Tally installation, and what evidence makes that run
acceptable as a release gate.

It does not replace the step-by-step procedure in
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md); that
document is the runbook. This one is the per-edition matrix that has to be
filled in twice, once per edition, and the rule for what "pass" means.

**Status: no edition has been run against a real installation from this
codebase.** `verifiedOn` and `evidenceUrl` are `null` on both profiles in
[`apps/pharmacy/lib/tally/editions.ts`](../../apps/pharmacy/lib/tally/editions.ts)
and nothing in the test suite changes that. The checks below are the only path
to a non-null value, and a synthetic XML fixture is not one of them.

The two fields are a pair. `editions.test.ts` fails if a profile carries a date
without an evidence path, or an evidence path without a date, or points at a
file that does not exist or does not name that date and edition label.

---

## 1. What the code already does, per edition

| Concern | TallyPrime | Tally.ERP 9 |
|---|---|---|
| Protocol used | Tally XML/HTTP on port 9000, `Voucher Register` + per-type TDL master collections | same requests; the ERP 9 quirks below are the ones seen so far |
| Parser | shared (`packages/db/src/tally-*`) | shared |
| Detected from | install path (`\TallyPrime\tally.exe`) | install path (`\Tally.ERP9\tally.exe`) |
| Recorded as | `edition: "prime"` on manifest and session | `edition: "erp9"` |
| Portal label | `TallyPrime` | `Tally.ERP 9` |
| Review warning | `TALLY_EDITION_UNVERIFIED` | `TALLY_EDITION_UNVERIFIED` |
| Verified date | `null` | `null` |
| Acceptance record (`evidenceUrl`) | `null` | `null` |

Anything the bridge cannot place is stored as `edition: "unknown"` and shown in
the review as `Unrecognised edition` with `TALLY_EDITION_UNKNOWN`. Neither
warning blocks Apply: the plan is reviewed on its own numbers, and the warning
records only that no edition-specific compatibility is being claimed.

Both profiles require the same extraction behaviour (stated once in
`editions.ts` and enforced by the parser and manifest checks):

- masters carry `<TALLYMESSAGE>` records for ledgers and stock items, with each
  ledger's `CLOSINGBALANCE` when the period ends on the cut-over date;
- the voucher export returns one `<VOUCHER>` per voucher inside the requested
  range and nothing outside it. The bridge may read past a mid-month end
  because the register only honours month ends, but it cuts the reply back
  before packaging, so the chunk the portal receives obeys its own range;
- the export names the company the portal pinned — a file for another company is
  refused, not imported;
- anything unreadable is a blocking exception, never a guess.

---

## 2. Before either run

1. A **test company** only. Invented or de-identified data. Never the
   pharmacy's live company.
2. The cut-over is closed on the target environment unless explicitly opened:
   `SYNAPSE_TALLY_CUTOVER_ENABLED=true`. Confirm the routes answer
   `503 TALLY_CUTOVER_DISABLED` while it is closed.
3. A dedicated Synapse test tenant. Do not use a live tenant.
4. Record the Tally company name, GST/VAT registration state, the fiscal period,
   and the currency before touching anything — these are the values the review
   is compared against.
5. Keep a copy of the runbook and the
   [evidence template](./TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md) open. Fill the
   template in as each phase completes, not afterwards.

---

## 3. Per-edition setup

The only material difference between editions at setup time is where the
HTTP/XML gateway setting lives on the F1 configuration menu. Everything else is
identical.

### 3.1 TallyPrime

1. Sign in and open **exactly one** company. The bridge reads whatever company
   is already open; it cannot select one or type a password.
2. **F1 → Settings → Advanced Configuration** — turn the HTTP/gateway server on
   for port **9000**.
3. In PowerShell, confirm something is listening:
   ```powershell
   Get-NetTCPConnection -State Listen -LocalPort 9000
   ```
4. Keep the company open for the whole run. A changed company or period makes
   the next range fail rather than return data.

### 3.2 Tally.ERP 9

1. Sign in and open **exactly one** company, as above.
2. Reach the HTTP/gateway setting from the **F1 configuration menu** and turn it
   on for port **9000**. On ERP 9 releases the setting sits in the F1
   configuration menu rather than a separate Connectivity page — if the release
   in front of you presents it differently, record the exact path you used in
   the evidence template rather than assuming this text is right.
3. Steps 3 and 4 as above.

### 3.3 Network rule for both

Port 9000 stays on loopback or the private LAN, firewalled to the bridge
computer. **Never forward port 9000 to the internet.** Do not disable Windows
Defender or weaken the firewall to make a run work; if a firewall rule blocks
the bridge, write that down as a failure and fix the rule.

---

## 4. Acceptance checklist — run once per edition

Each item records a value at the point it is observed. "Looks right" is not a
result; a number, a code, a count or a hash is.

### A. Connector surface

- [ ] `GET /status` on the bridge reports `tally: "reachable"` and an
      `edition` value. Record the exact string. It must be `prime` or `erp9` —
      an `unknown` here for a correctly installed copy is a **fail** of edition
      detection and must be reported, not worked around.
- [ ] `GET /companies` returns the open company and the same `edition`.
- [ ] `GET /preflight` passes, and its report names the same executable path you
      verified by hand.
- [ ] The bridge is bound to `127.0.0.1` only (`netstat -ano | findstr 17890`),
      and port 9000 is not reachable from another machine on the network.

### B. Masters

- [ ] Run one masters export by hand (runbook §5) and confirm it starts with a
      well-formed `<ENVELOPE>` and contains `<TALLYMESSAGE>` records for both
      ledgers and stock items.
- [ ] Count the ledgers and stock items in Tally (Display → Trial Balance /
      Stock Summary) and record both counts.
- [ ] The portal's preview shows the **same** ledger and stock item totals.
- [ ] Every ledger the cut-over maps has a closing balance at the cut-over date.
      A ledger Tally shows with a balance but the export lacks is a **fail**.

### C. Voucher export

- [ ] Run one voucher export for a short window and confirm one `<VOUCHER>`
      per voucher, each with a date inside the range that was asked for. A
      voucher outside the window is a **fail**: the bridge must have cut it
      back, and the manifest refuses the chunk if one gets through.
- [ ] Ask for a range ending mid-month and confirm the window is still obeyed —
      the register is read to the month end, so this is the case the cut-back
      exists for.
- [ ] Record Tally's voucher count for the window and the portal's
      `postedVouchers + skippedVouchers`. They must add up; a gap is a blocking
      exception, not a rounding difference.
- [ ] Cancelled and optional vouchers are handled the way Tally reports them —
      record what Tally shows and what the manifest counted.

### D. Live extraction through the portal

- [ ] Create the live session, begin extraction, and let every chunk complete.
- [ ] The review screen shows `Source edition · TallyPrime` or
      `Source edition · Tally.ERP 9` matching §A, with the corresponding
      "not confirmed against a real installation" line and the
      `TALLY_EDITION_UNVERIFIED` warning. Record the label exactly as displayed.
- [ ] Reload the page mid-extraction: the manifest resumes from the server, not
      from local state.
- [ ] `finish` returns a review whose `edition` block matches what the review
      screen shows, and the session's `ai_mapping` carries the same `edition`
      and `editionProblems`.

### E. Reconciliation and apply (test tenant only)

- [ ] Opening trial balance: debit total equals credit total to the cent.
- [ ] Stock valuation, opening stock and closing stock match Tally's P&L for the
      same date.
- [ ] Every blocking exception has been read and resolved; no warning was
      silently dismissed.
- [ ] Apply on the test tenant, then compare, per ledger and per stock item, the
      resulting Synapse balance against Tally's report printed the same day.
      Record any difference — zero, or the exact amount.
- [ ] A second apply request is refused; retrying the same session resumes
      rather than duplicating.

### F. Near-limit behaviour

- [ ] With a company whose voucher export approaches 25 MiB, the extraction
      splits rather than truncating, and the reconciliation still matches
      Tally's counts.

---

## 5. What makes the gate pass

Both editions pass independently. For each one, the evidence file must contain:

1. the run identity block, dated and signed;
2. the recorded `edition` string from `/status`, `/companies` and the review
   screen — all three the same;
3. Tally-side counts (ledgers, stock items, vouchers) and portal-side counts for
   the same window, with the difference stated explicitly;
4. the reconciliation in §E, applied and re-read from Synapse;
5. an unedited copy of any exception the run produced, and what was done about
   it;
6. a statement of what the run does **not** prove (other Tally releases,
   different fiscal-year settings, modules outside `All Masters` and `Day Book`).

A run that skips the test tenant, uses a live company, or records values from
memory does not make the gate pass regardless of how clean the numbers look.

When an edition has passed, make two changes together in
`apps/pharmacy/lib/tally/editions.ts`: set `verifiedOn` to the run date
(`YYYY-MM-DD`) and `evidenceUrl` to the repo-relative path of the record built
from §5 above. Then update
[TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md) §"Remaining
release work".

Setting one without the other fails `editions.test.ts`. So does pointing at a
record that is missing, does not contain the `verifiedOn` date, or does not
contain the edition label. Until then the review warning stays on screen for
that edition, and that is the correct behaviour.

---

## 6. Known gaps this checklist is meant to expose

These are the questions the code cannot answer about either product until a run
happens. They are listed so a tester records them rather than assuming an
answer:

- exact field set of the master collections on the tested release (batch
  details, godown detail, unit formatting, the `<OPENINGRATE>` unit suffix);
- whether `CLOSINGBALANCE` appears at the precision the schema stores;
- how each release reports cancelled and optional vouchers in the `Voucher
  Register`;
- whether the gateway setting survives a Tally restart on that release;
- ERP 9 release-specific differences in the F1 configuration layout.
