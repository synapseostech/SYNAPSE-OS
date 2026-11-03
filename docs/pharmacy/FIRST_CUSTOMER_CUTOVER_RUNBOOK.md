# First-customer cutover runbook

Everything between "the code passed its gate" and "the first real sale on the
client's live tenant", in the order it has to happen.

**This document does not authorise anything.** Every production action below is
the owner's to approve and run. It exists so the owner can see the exact steps,
the exact variables and the exact checks before saying yes.

Companion documents:

- [PRODUCTION_RELEASE_RUNBOOK.md](./PRODUCTION_RELEASE_RUNBOOK.md) — gate, deploy, rollback
- [CLIENT_ONBOARDING_CHECKLIST.md](./CLIENT_ONBOARDING_CHECKLIST.md) — per-tenant setup, line by line
- [CLIENT_PRODUCTION_READINESS.md](./CLIENT_PRODUCTION_READINESS.md) — the client-facing statement
- [TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md](./TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md) — Tally sign-off, incl. AC-9
- [PHARMACY_WINDOWS_ACCEPTANCE.md](./PHARMACY_WINDOWS_ACCEPTANCE.md) — browser acceptance on Windows
- [TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md](./TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md) — bridge install and shutdown
- [TALLY_PRIME_ERP9_ACCEPTANCE.md](./TALLY_PRIME_ERP9_ACCEPTANCE.md) — both Tally editions
- [DISPOSABLE_ACCEPTANCE_ENVIRONMENT.md](./DISPOSABLE_ACCEPTANCE_ENVIRONMENT.md) — where acceptance evidence comes from

---

## 1. Two cut-overs, not one

| Cut-over | Question it answers | Gate |
|---|---|---|
| Data | Does the client's Tally history exist correctly in Pharmacy? | `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` |
| Independence | Does the pharmacy keep selling with Tally switched off? | AC-9, the disconnect test |

Neither implies the other. A clean import with Tally still running is *staged*,
not migrated. The tenant is not cut over until the disconnect test passes on the
client's own PC.

---

## 2. Environment variables

Two Vercel projects are involved. The root `vercel.json` governs `synapse-os`;
`apps/pharmacy/vercel.json` governs `synapse-pharm`.

### 2.1 `synapse-pharm` — Production scope

| Key | Read by | Required for | Notes |
|---|---|---|---|
| `SUPABASE_URL` | `apps/pharmacy/lib/supabase/admin.ts`, `middleware.ts` | server-side database | Falls back to `NEXT_PUBLIC_SUPABASE_URL`, but set it explicitly: `NEXT_PUBLIC_*` values are baked into the build, so a cached build can carry a stale project |
| `NEXT_PUBLIC_SUPABASE_URL` | browser client | browser-side queries | The production project URL only |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | browser client | browser-side queries | Anon key, safe to ship |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | every admin route | Never expose as `NEXT_PUBLIC_*`, never in browser code, never in a client bundle |
| `SYNAPSE_JWT_SECRET` | `packages/auth` tokens + MFA, `lib/customer-session.ts` | staff sign-in, MFA, customer portal cookie | Signing staff out and invalidating customer sessions is the effect of rotating it. Customer-session signing requires ≥16 characters |
| `RATE_LIMIT_PEPPER` | `lib/distributed-rate-limit.ts` | shared rate limiting | Optional; falls back to `SYNAPSE_JWT_SECRET`. Set separately so a JWT rotation does not reset every bucket |
| `RESEND_API_KEY` | `lib/email.ts` | invitations and notifications | Email silently fails (`success: false`) when absent; it does not break the app |
| `RESEND_FROM_EMAIL` | `lib/email.ts` | sender address | Defaults to `noreply@synapseos.tech` |
| `NEXT_PUBLIC_PHARMACY_APP_URL` | `lib/app-url.ts` | absolute links the app builds | Must be the deployed pharmacy host |
| `FLUTTERWAVE_SECRET_KEY`, `FLUTTERWAVE_PUBLIC_KEY` | subscription billing | self-serve card payment | Omit if the first customer is billed manually; onboarding does not depend on it |
| `SYNAPSE_TALLY_CUTOVER_ENABLED` | Tally cut-over routes | enables the import for one tenant at a time | In Production it is closed unless the value is exactly `true`; `false` closes it in every environment. Set it for the migration window and remove it after apply |
| `NEXT_PUBLIC_VERCEL_INSIGHTS` | telemetry bootstrap | Web Analytics/Speed Insights | `1`, Production scope only — see `VERCEL_PLATFORM_ENABLEMENT.md` §D |

The Flutterwave **webhook** secret belongs to `apps/web`, not this project; the
canonical webhook is `https://synapseos.tech/api/billing/webhook/flutterwave`
(see `apps/pharmacy/.env.example`).

### 2.2 `synapse-os` — the values it shares

`SYNAPSE_JWT_SECRET`, the Supabase trio and `NEXT_PUBLIC_APP_URL` must describe
the **same** production project and the **same** JWT secret as the pharmacy
project. If the two projects sign with different secrets, a staff session issued
by one is not recognised by the other.

### 2.3 What must never happen

- Acceptance (`jbojujxpyxsdiukmrwzs`) credentials in a production variable.
- Production credentials (`qfqakzmjatszisuqjwon`) in acceptance.
- A service-role key in any `NEXT_PUBLIC_*` name or any browser file.
- Secrets pasted into chat, tickets, or this runbook when it is filled in.

---

## 3. Database: backup, then migrate

The database is shared by web OS and Pharmacy, so a migration is never
"pharmacy only".

### 3.1 Before anything

| Step | Command / where | Record |
|---|---|---|
| 1 | `git status` — the tree contains only what is intended to ship | output |
| 2 | `npm run db:check` | pass |
| 3 | `npm run db:history:check` | pass, and the list of migrations not yet applied to production |
| 4 | `npm run db:prod:ledger` (`supabase migration list --linked`) | applied vs pending, captured as text |
| 5 | Take a backup in the Supabase dashboard (Database → Backups) and store it off the machine | backup name, date, location |
| 6 | Record whether point-in-time recovery is available on the current plan | yes/no — plan-dependent, unverified here |

If §3.1 step 5 cannot be completed, stop. A migration with no restore point is
not a maintenance window, it is a gamble.

### 3.2 Applying

1. One maintenance window, announced to anyone using the system.
2. Apply the reviewed migration list **in order**. No ad-hoc SQL in the same
   window.
3. Do not resolve a remote/local difference by deleting remote data. A mismatch
   is escalated, not smoothed over.
4. After apply: `npm run db:prod:ledger` again and compare with §3.1 step 4; then
   `GET /api/ready` on both hosts.

The repository's rule stands: `db push` against production is not a routine
step. Migrations are applied deliberately, from a reviewed list, by the owner.

### 3.3 When there is nothing to migrate

A release that carries no migration still needs §3.1 steps 1–4. The backup and
restore point matter less, but the migration ledger is how the next window is
scoped.

---

## 4. Rollback

| Layer | How | Limit |
|---|---|---|
| Application | Redeploy the previous known-good Vercel deployment | Instant; does not touch data |
| Configuration | Restore the previous environment-variable values | Instant |
| Schema | Only if a written down-migration was reviewed **before** apply | Application rollback alone never undoes a migration |
| Tenant | Not resettable once it holds real sales | A tenant with real sales cannot be recreated without destroying them |

Rules:

- Write the rollback plan into the release record **before** the window.
- Do not "fix forward" on `main` without re-running `npm run verify:pharm-release`.
- For the Tally cut-over, the import is one-shot per tenant
  (`CUTOVER_ALREADY_COMPLETE` refuses a second apply). Rolling back a migration
  means a fresh tenant, not a re-import. Tally itself is untouched either way —
  the bridge only reads.

---

## 5. Administrator account

| Step | Where | Check |
|---|---|---|
| 1 | Provision the tenant (facility console, or pharmacy self-serve register) | the tenant exists with a slug and a host |
| 2 | Create the administrator with an email the client controls | sign-in succeeds |
| 3 | Confirm the account is `ADMIN` | every area opens, including Settings, Users and Accounting |
| 4 | Confirm the account is not shared | one person, one login |

Two provisioning facts that decide how step 1 is done:

- `POST /api/auth/register` creates the tenant, its main store, the
  administrator profile and a 7-day `trialing` `tenant_subscriptions` row, and
  rolls the tenant back if a later insert fails
  (`app/api/auth/register/route.ts`).
- A tenant with **no** `tenant_subscriptions` row is entitled by design
  (`packages/auth/src/billing/entitlement.ts`, fail-open). Creating the row sets
  an explicit trial or paid window; it is not what lets the tenant in.

Never create the production administrator with a password that was sent through
chat or email in plain text. Use the platform's reset flow.

---

## 6. First-customer onboarding

Follow [CLIENT_ONBOARDING_CHECKLIST.md](./CLIENT_ONBOARDING_CHECKLIST.md)
line by line; it is the record. The items that block a safe first sale:

1. VAT position confirmed before any price is entered (§0.2, §2.4).
2. Receipt legal name, footer and paper width set (§2.2–2.5).
3. Opening stock counted and **signed** by someone accountable (§3.4).
4. One account per person; refunds and purchasing granted deliberately (§4).
5. Till float recorded, cash-up exercised once (§5).
6. A trial sale completed and refunded correctly on the live tenant (§7.1).

Do not schedule the client's first trading day until §3.4 and §5.5 are ticked.

---

## 7. Opening stock and opening balances

This is the step most likely to be skipped, and the one that makes the
accounting statements wrong if it is.

The cut-over plan has **two modes** (`packages/db/src/tally-normalise.ts`):

| Mode | What is posted | When to use |
|---|---|---|
| `opening` | Tally's opening balances as an opening journal, opening stock received per batch, and the Day Book replayed as historical vouchers | The client wants their transaction history readable in Pharmacy |
| `closing` | Only the balances the export closes on: accounts, parties and stock at the cut-over date. No vouchers are posted | The client wants to start clean from a dated stock and balance position |

Both are built by the importer and reviewed before apply. The opening journal is
never plugged: if the imported lines do not balance, apply refuses and names the
difference (`opening-journal`, "nothing is plugged"). Opening stock with no
future expiry, or with an unusable quantity, is reported and skipped rather than
rejected mid-import.

### 7.1 What happens when nothing posts an opening

A tenant that has **not** been migrated — a manual go-live, or any tenant whose
first entry is a sale — gets no opening cash and no opening stock in the
accounting ledger. The accounting page says so in its own banner: the ledger
starts recording new completed sales and received purchases, and earlier
activity is not backfilled.

The acceptance tenant is exactly that case. After one sale and one refund its
statements read:

| Figure | Value | What it should tie to |
|---|---|---|
| Cash on hand | **−2,080** | physical cash + bank at conversion |
| Inventory | **2,150** | stock at cost, from the signed count |
| Physical stock at cost | **468,230** | the signed stock sheet |

The equation balanced (assets = liabilities + equity + income − expense) and
every sale and refund posted correctly. The gap is the **missing opening
balances**, not a posting defect. On a live tenant the same gap makes the first
trial balance look broken while the till is behaving correctly.

### 7.2 Procedure for a manual go-live

1. Freeze a signed stock count at cost, per batch where the client tracks
   batches. This is the inventory opening figure.
2. Record physical cash per till plus bank balances. This is the cash opening
   figure.
3. List receivables (customer credit) and payables (suppliers) as at the same
   date.
4. Post one balanced **Journal** voucher — Accounting → New voucher → *Journal* —
   dated the conversion date, against *Opening balance equity*:
   - Dr Cash / Dr Bank / Dr Inventory / Dr Receivables
   - Cr Payables / Cr Opening balance equity
5. Check, in this order:
   - the voucher balances and the trial balance equation is zero;
   - Inventory equals the signed stock sheet at cost;
   - Cash on hand equals the physical count plus bank;
   - receivables and payables equal the client's own lists.
6. Only then complete the first live sale.

### 7.3 Procedure for a Tally cut-over

The opening journal and opening stock are produced by the import (§8), so this
section is the **check**, not a second posting:

1. In the review screen, confirm the mode (`opening` or `closing`), the
   conversion date and the opening journal's debit and credit totals match.
2. Confirm the stock items and quantities shown are the signed count for the
   conversion date.
3. After apply, the same checks as §7.2 step 5, plus: the migrated vouchers
   appear in the day book and the trial balance ties to Tally's closing figures
   for the migrated period.
4. Do **not** post a manual opening journal as well; that would double-count.

---

## 8. Tally cut-over, in order

The mechanics are in `TALLY_UPLOAD_GUIDE.md`; the sign-off is in
`TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md`. The sequence:

1. Take a Tally company backup **before** extraction and store it off the PC.
2. Install the connector on the client's PC
   (`TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md`).
3. Run the preflight — the connector reports its edition (TallyPrime or ERP 9),
   the company it is pinned to, and whether Tally answers on port 9000.
4. Open cut-over for this tenant only (`SYNAPSE_TALLY_CUTOVER_ENABLED`).
5. Read masters once, then voucher ranges chunk by chunk. Every chunk must
   reconcile; a gap, overlap or date outside its range refuses the apply.
6. Review the plan — mode, conversion date, opening journal, stock and every
   exception — then apply. The import is one-shot per tenant.
7. Close the switch.
8. Run the disconnect test (AC-9) on the client's PC: stop the connector, make
   Tally unreachable, sign in, sell, refund, view the migrated period.

Until step 8 passes on the client's hardware, the state is *staged*.

---

## 9. Post-deployment smoke tests

| # | Check | Pass |
|---|---|---|
| 1 | `GET https://<pharmacy-host>/api/ready` | `200`, `status: "ready"`, `checks.database.ok: true`, `commitSha` equals the deployed commit |
| 2 | `npm run health:smoke` | exits 0 |
| 3 | Sign in as the administrator | reaches the portal |
| 4 | One cash sale on the live tenant | receipt renders; stock decrements by the sold quantity |
| 5 | One partial-payment sale | balance appears on the customer's credit ledger |
| 6 | Refund that sale | cash and receivable split as tendered; sale reads `REFUNDED`; batch restored |
| 7 | Till cash-up | expected cash equals opening float + cash sales − cash refunds; variance explained |
| 8 | Accounting | day book shows the sale and refund; trial balance equation is zero |
| 9 | Reports | gross sales, discounts, VAT, net and stock tie to the sales just made |
| 10 | Tally independence | with the connector stopped, sign in and complete a sale; nothing waits or errors |

The detailed browser suites are `PHARMACY_WINDOWS_ACCEPTANCE.md`; the Tally
editions are `TALLY_PRIME_ERP9_ACCEPTANCE.md`.

---

## 10. Production actions that need explicit approval

Nothing below happens on the strength of this document.

| # | Action | Why it needs a decision |
|---|---|---|
| 1 | Merge the release branch and push to `main` | starts CI and the Vercel build |
| 2 | Deploy `synapse-pharm` (and `synapse-os` if shared code changed) to Production | makes the release live |
| 3 | Apply any pending migration to production | schema change; requires the §3.1 backup and restore point first |
| 4 | Set or rotate production environment variables | secrets and project identity |
| 5 | Create the production tenant and administrator | first real client data |
| 6 | Enable `SYNAPSE_TALLY_CUTOVER_ENABLED` for that tenant | opens the import path |
| 7 | Take the Tally backup and install the connector on the client PC | touches the client's machine |
| 8 | Declare the cut-over complete | only after AC-9 passes on the client's hardware |

---

## 11. What this runbook cannot tell you

- Whether the client's Tally data is correct — that is the migration criteria.
- Whether the connector works on their PC — that is the controlled Windows test.
- Whether paper comes out of their printer — only the person at the till can say.
- Whether point-in-time recovery is included in the current Supabase plan.
- Whether the production deployment is healthy — that is §9, run after it exists.
