# Pharmacy accounting period close

**Date:** 2026-10-25
**Scope:** `apps/pharmacy/lib/accounting/close-readiness.ts`, `apps/pharmacy/app/api/admin/accounting/periods/readiness/route.ts`, `apps/pharmacy/app/api/admin/accounting/periods/route.ts`, `apps/pharmacy/app/portal/accounting/page.tsx`, `apps/pharmacy/app/api/admin/till/close/route.ts`, `supabase/migrations/20261026190000_pharmacy_period_close_integrity.sql`
**Status:** built and unit-tested in the tree. The migration is prepared, not applied. The SQL has not been executed anywhere.

---

## What the close actually did

`close_pharmacy_accounting_period` validated the date order, refused a period that had not ended, refused an overlap with a closed period, took an advisory lock, inserted the period row and wrote an audit line. Then every later posting dated inside that range was rejected with `ACCOUNTING_PERIOD_CLOSED`.

That is a correct control applied without a warning. Nothing in the tree told a supervisor what would be cut off by closing now — not the API, not the screen. The button was available the moment the dates were filled in, and `window.confirm` was the only thing between the operator and an irreversible decision.

## The failure this closes

A till session that is open at close. Pharmacy cash is not posted when the sale happens; `pharmacy_till_cash_events` is written when the till closes, and `closeTill` then posts the shift through `post_pharmacy_accounting_journal` with an entry date derived from the shift. So the sequence

1. cashier opens the 30th's till, serves all day,
2. supervisor closes the month of September on 1 October,
3. cashier closes the till on 2 October,

ends with an `ACCOUNTING_PERIOD_CLOSED` exception on the till close screen. The day's cash never reaches the ledger, the till cannot be closed, and the variance is left unexplained. The supervisor had no way to know on the 1st that a till was still open.

## What was built

`close-readiness.ts` is a pure module: it takes facts and returns a verdict. `tillBlocksPeriodClose` is one line of policy — not closed, no close time, opened on or before the period end — written once so it can be read and tested. `assessCloseReadiness` returns two blockers (`PERIOD_RANGE_INVALID`, `PERIOD_NOT_ENDED`, `OPEN_TILL_SESSIONS`) and two warnings (`UNMATCHED_BANK_LINES`, `NO_ACTIVITY`) in the operator's language rather than as codes with an error log attached.

`closeSnapshot` records the facts, not the assessment. The warnings are derived from the numbers at read time; storing the rendered messages would freeze copy that will change and let the evidence drift from the data.

`GET /api/admin/accounting/periods/readiness` calls `pharmacy_accounting_close_readiness` and returns both the verdict and the snapshot the close would record. It reports `503` when the RPC is absent, because that is a deployment gap rather than a bad request.

The accounting screen now fetches readiness whenever both dates are set, shows the blockers in place of a confirm dialog, disables **Close period** while a blocker stands, and previews the figures that will be recorded. It fails closed: while the check is in flight, or if it could not be answered at all, the button stays disabled. An unanswered check is not a pass. The trade is that an outage of the readiness endpoint also stops month close from the screen, which is the deliberate direction — a delayed close is recoverable, a wrong one is not.

The database still enforces the rule. `close_pharmacy_accounting_period` now assesses inside its advisory lock and raises `ACCOUNTING_PERIOD_OPEN_TILLS` before inserting; the route maps that to a `409` with an explanation. The UI is a courtesy, not the control.

## Deliberate omissions

Open till sessions are a blocker, not a warning. Closing anyway cannot be undone and cannot be repaired from inside the system: the period is locked, and an adjusting entry dated in a later period would move cash into the wrong month.

Unmatched bank statement lines are a warning. The ledger balances without them; only the bank position is unverified, and forcing reconciliation before close would push operators to match lines they cannot yet explain.

There is no "unposted sales" check. `post_pharmacy_pos_sale_to_ledger()` is a trigger on `pharmacy_pos_sales`, so a completed sale is posted in the same transaction that creates it. A check for it would be a check for something structurally impossible, and would only teach the operator to ignore the panel.

## Performance, in the same migration

The readiness queries needed indexes that did not exist. Open sessions had only single-column indexes; the new partial index `pharmacy_cashier_sessions_open_idx (tenant_id, opened_at) where status <> 'closed' and closed_at is null` covers exactly the predicate and holds one row per open till rather than every shift ever recorded. `pharmacy_pos_sales` had `created_at` alone with no tenant prefix; `pharmacy_pos_sales_tenant_status_created_idx (tenant_id, status, created_at)` gives the sales roll-up a tenant-first path.

The queries compare `timestamptz` as a half-open range (`created_at >= local midnight of period_start and < local midnight after period_end`) rather than casting each row to a Kampala date. The two forms mean the same thing; only the range form is sargable.

Both indexes are built without `CONCURRENTLY`, which a transactional migration forbids. On a pilot-scale pharmacy the lock is momentary; on a table large enough for it to matter, this migration is the wrong instrument and the index should be built separately.

## What is not proven

**The SQL has never run in this session.** The sandbox this migration was written in has no `psql`, no PostgreSQL server and no container runtime: its loopback refuses `127.0.0.1:54322`, no Docker socket is mounted, and the only listening ports are the outbound proxy. A local Supabase stack may well be running on the host — a host-bound port is not reachable as the VM's own `127.0.0.1`, which is the usual reason a `pg_isready` that succeeds on the host fails inside the sandbox — but that stack was not available to the process that wrote this file.

So the migration is checked by reading it and by the repository's static gates: `db:check` parses and orders it, `test:db-acl` confirms the new function is revoked from `public`, `anon` and `authenticated`. No server has parsed it and no function in it has been compiled. Treat it as prepared SQL, not working SQL, until someone runs it and records the output.

**The rule now exists twice.** `tillBlocksPeriodClose` in TypeScript and the predicate in `pharmacy_accounting_close_readiness` must agree. The test pins the TypeScript side; nothing pins the SQL side. When the RLS-repair work eventually gets a disposable database, the readiness function belongs in that harness for exactly this reason.

**The endpoint has not been called.** It type-checks and its pure logic has 17 tests, but no request has been made against it and no browser has rendered the panel.

## Gates run

`npm run test:general --workspace @synapse/pharmacy` — 576 passed, 15 skipped, 62 files.
`npm run type-check --workspace @synapse/pharmacy` — clean.
`npm run lint --workspace @synapse/pharmacy` — clean, zero warnings.
`npm run test:routes` — PASS pages=288 nav_links=73 roadmap=77.
`npm run db:check` — 197 migration files OK.
`npm run test:db-acl` — static PASS, definer_functions=68, public_grants=0.
`npm run test:security-gates` — PASS, migrations=10, failures=0.
