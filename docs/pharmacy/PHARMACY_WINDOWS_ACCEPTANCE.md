# Pharmacy browser acceptance on Windows

The operator procedure for the pharmacy browser acceptance suite: how to run it
on the Windows acceptance host, what a pass proves, and which results only a
person at the machine can record.

**This document does not authorise anything.** It assumes a disposable
acceptance tenant. The operational journeys create real sales and real refunds
in whatever tenant they are pointed at; never point them at a tenant holding a
client's live sales.

Companion documents:

- [PRODUCTION_RELEASE_RUNBOOK.md](./PRODUCTION_RELEASE_RUNBOOK.md) — the release gate
- [TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md](./TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md) — bridge install, health, shutdown, uninstall
- [TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md](./TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md) — cut-over sign-off and the disconnect criterion
- [CLIENT_ONBOARDING_CHECKLIST.md](./CLIENT_ONBOARDING_CHECKLIST.md) — per-tenant setup

---

## 1. What the suite is

Playwright tests in `e2e-pharmacy/`, driven by `scripts/e2e-pharmacy-acceptance.mjs`.

| Layer | Spec | Needs | Runs on |
|---|---|---|---|
| `smoke` | `pharmacy-smoke.spec.ts` (22 tests) | A reachable deployment, nothing else | Any host, including CI |
| `operations` | `pharmacy-acceptance.spec.ts` (11 tests) | Windows host + disposable tenant credentials + at least one sellable product | The Windows acceptance host only |

The two layers are reported separately and never merged. A smoke pass says the
deployment's anonymous edge is correct. It says nothing about whether an
operator can sell, refund or print.

### 1.1 What the smoke layer covers

- The sign-in page is a real form with working labels, not a placeholder.
- An empty submission is refused in the browser.
- Sixteen operational routes — POS, refunds, inventory, purchases, suppliers,
  customers, credit ledger, reports, till, transactions, accounting,
  Tally import, settings, users, dashboard, integrity — redirect an anonymous
  visitor to `/login`.
- No operational control leaks into the anonymous page.
- The admin API answers JSON with a 4xx, never an HTML redirect.
- The deployment serves `X-Frame-Options`, `X-Content-Type-Options` and
  `Referrer-Policy`.
- No uncaught client error on the sign-in page.

### 1.2 What the operations layer covers

| # | Journey | What it asserts |
|---|---|---|
| 1 | Sign in | Reaches the portal shell with a Sign Out control |
| 2 | Expired session | Clearing the session cookie sends the operator back to sign-in |
| 3 | Sign out | The previous session cannot open `/portal/pos` afterwards |
| 4 | Every operational page | Eleven pages return 200, keep their URL, render a heading, raise no client error |
| 5 | Cash sale | Completes through the real POS form, with change, and is readable back through the API |
| 6 | Credit sale | Recorded as `CREDIT` and posts a receivable to the customer's credit ledger |
| 7 | Partial payment | A cash tender below the total records the balance due on the customer's account |
| 8 | Discount | A line discount and reason reach the recorded transaction |
| 9 | Refund | A completed sale is refunded through `/api/admin/refunds` and appears in the refund history as `REFUNDED` or `VOIDED` |
| 10 | Tenant isolation | Tenant B's session never lists tenant A's sale |
| 11 | Receipt | Opening a receipt submits no print job; the print control invokes the browser's print path |
| — | Tally independence | Every sale journey fails if the page contacts `127.0.0.1:9000` or `localhost:9000` |

Test 11 drives `window.print` in the page and counts calls. It proves the
application uses the browser print path rather than a print daemon. It does
**not** prove paper came out — see §8.

---

## 2. Before the run

The host must have:

| Requirement | Check |
|---|---|
| Windows 10/11 x64 | `[System.Environment]::OSVersion.Version` |
| Node.js 22 LTS | `node -v` — the repo pins `22.x` |
| Dependencies installed | `npm ci` at the repository root |
| Chrome or Edge installed | `chrome://version`, or Edge **Settings → About** |
| A disposable acceptance tenant | not the production project (`qfqakzmjatszisuqjwon` is refused) |
| At least one sellable product with stock | otherwise every sale journey fails at "Add to cart" |
| A staff account that can open POS, refunds and settings | the acceptance operator |

The suite probes for a browser before running anything. A browser that cannot
launch is reported as `NOT AVAILABLE` with the launch error, never as a pass.

Do not run this against the client's production host. The runner refuses
`*.synapseos.tech` and the production Supabase project before it starts a
browser, but the guarantee depends on the operator setting the target
honestly.

---

## 3. Configuration

Set these in the shell before running. Nothing here is committed.

| Variable | Purpose |
|---|---|
| `SYNAPSE_PHARMACY_E2E_BASE_URL` | Deployment under test. Omit to run the local dev server on `http://127.0.0.1:3002`. |
| `SYNAPSE_PHARMACY_E2E_EXTERNAL_SERVER=1` | Do not start a local server; use the one already running at the base URL |
| `SYNAPSE_PHARMACY_E2E_START_COMMAND` | Override the command that starts the app (default: `npm run dev --workspace @synapse/pharmacy`) |
| `SYNAPSE_PHARMACY_E2E_EMAIL` | Acceptance operator email |
| `SYNAPSE_PHARMACY_E2E_PASSWORD` | Acceptance operator password |
| `SYNAPSE_PHARMACY_E2E_TOTP` | Fixed 6-digit acceptance code, only if the account has a second factor |
| `SYNAPSE_PHARMACY_E2E_TENANT_B_EMAIL` / `_PASSWORD` | Second tenant operator, for test 10. Without it test 10 reports `NOT RUN — TENANT B CREDENTIALS REQUIRED`. |
| `SYNAPSE_PHARMACY_E2E_PRODUCT` | Barcode or SKU the POS journey searches for. Empty means "the first product in the list". |
| `SYNAPSE_PHARMACY_E2E_CHROME_CHANNEL` | `chrome` (default) or `chromium` (Playwright's own build) |
| `SYNAPSE_PHARMACY_E2E_CHROMIUM_EXECUTABLE` | Path to a Chromium build Playwright did not download. Wins over the channel. |
| `SYNAPSE_PHARMACY_E2E_FORBIDDEN_HOST` | An extra host that must never be contacted during a sale (appended to the two Tally bridge defaults) |
| `SYNAPSE_PHARMACY_E2E_ALLOW_NON_WINDOWS=1` | Run the operations layer on a non-Windows host. For maintainers developing the suite, not for acceptance. |
| `SYNAPSE_E2E_VERCEL_BYPASS` | Vercel protection bypass, only for a protected preview deployment |

Credentials are checked for presence and shape, never printed. A malformed
TOTP stops the run with a configuration error rather than signing in without a
second factor.

---

## 4. Running it

From the repository root:

```bash
npm run test:e2e:pharmacy:smoke
```

Runs the smoke layer only. Safe on any host, against a local server or a
deployment.

```bash
npm run test:e2e:pharmacy
```

Runs both layers. On the Windows host with credentials set, this is the
acceptance run.

Add `-- --headed` to watch the browser, for a first run on a new tenant.

The runner prints a preflight block before launching anything:

```
PHARMACY E2E PREFLIGHT
  platform:        win32
  target:          REMOTE https://<acceptance-host>
  managed server:  no (external)
  credentials:     present
  operations:      eligible
```

If `operations` says `NOT RUN — WINDOWS HOST REQUIRED`, the run produced no
operational evidence whatever the smoke result.

### 4.1 Exit codes

| Code | Meaning |
|---|---|
| `0` | Every layer that could run passed. Check the evidence block for what did not run. |
| `1` | A layer that ran failed |
| `2` | The target or configuration was refused (production host, placeholder host, bad URL) |
| `3` | No browser could be launched on this host |

---

## 5. Target refusals

`scripts/e2e-pharmacy-target.mjs` rejects, before a browser exists:

- any `synapseos.tech` host and subdomain (production);
- the production Supabase project ref, whether passed as the app URL or embedded in it;
- `.invalid`, `.example`, `.test` and `.localhost` hosts (placeholders);
- anything that is not `http` or `https`.

Loopback is accepted, because the smoke layer runs against a local dev server.
A refused target exits `2` with `PHARMACY_E2E_TARGET_REFUSED` in the message.

---

## 6. Reading the evidence

The runner ends with:

```
PHARMACY E2E EVIDENCE
  smoke/chrome         PASS (22 passed, 0 failed, 0 skipped)
  operations/chrome    PASS (11 passed, 0 failed, 0 skipped)

  A smoke PASS says the deployment's anonymous edge is correct. It is not
  operational acceptance: only operations/* on the Windows host produces that.
```

Skip reasons are printed under the layer they belong to, verbatim:

- `NOT RUN — WINDOWS HOST REQUIRED`
- `NOT RUN — DISPOSABLE ACCEPTANCE TENANT CREDENTIALS REQUIRED`
- `NOT RUN — TENANT B CREDENTIALS REQUIRED`

Per-layer JSON reports are written to `test-results/pharmacy-<layer>-<browser>.json`.
Traces, screenshots and videos of failures are written under `test-results/pharmacy/`.
Both are ignored by Git: they show a signed-in operator and the tenant's sales.

---

## 7. What the automation cannot decide

| Question | Who answers it |
|---|---|
| Did the receipt physically print? | §8 |
| Is the printer configured correctly for this till? | §8 |
| Does the bridge install, start, report healthy, stop and uninstall on this PC? | `TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md` |
| Does TallyPrime or ERP 9 export the company correctly? | `TALLY_PRIME_ERP9_ACCEPTANCE.md` |
| Are the imported figures right? | `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` |
| Does the browser behave the same on the client's actual till? | The client's own acceptance visit |

---

## 8. Printer evidence (manual)

The suite proves the application calls the browser's print path on the
operator's action and does not on page load. Everything past that needs a
person at the machine. Record four separate things — they are not
interchangeable:

| # | Observation | How | Pass |
|---|---|---|---|
| 8.1 | The receipt renders in the app | open the sale's receipt page | items, totals, payment method, change or balance due match the sale |
| 8.2 | The browser print dialog appears | click Print | dialog opens on the receipt page |
| 8.3 | A job reaches the printer | printer queue | job listed with the expected page count |
| 8.4 | Physical output | the paper | legible, correct width, correct figures, no truncation |

Printer record:

| Field | Value |
|---|---|
| Printer make and model | |
| Driver used (name and version) | |
| Paper width (58 mm / 80 mm) | |
| Connection (USB / network / Bluetooth / serial) | |
| Cut behaviour | |
| 8.1 receipt rendering | |
| 8.2 print dialog | |
| 8.3 job in the queue | |
| 8.4 physical output | |
| Operator initials and time | |

A receipt that renders but never prints is a failed cut-over for a pharmacy
that must hand paper to a patient. Do not record 8.2 as 8.4.

---

## 9. Recording the run

Fill this in per acceptance run and keep it with the release record.

| Field | Value |
|---|---|
| Date and time | |
| Windows version and build | |
| Node version | |
| Browser (Chrome / Edge) and version | |
| Target base URL | |
| Tenant (facility id) | |
| Operator account | |
| Forbidden-host check | |
| `smoke/chrome` result | |
| `smoke/edge` result | |
| `operations/chrome` result | |
| `operations/edge` result | |
| Tests not run, with reason | |
| Printer evidence (§8) | |
| Bridge lifecycle (Tally runbook) | |
| Disconnect test result | |
| Run by | |

---

## 10. What has actually been executed

Honesty section — update it when a run completes.

**2026-11-02, Linux host (this working tree), brand Chrome:**

- Smoke layer, Chrome project: **22 passed, 0 failed, 0 skipped**, exit 0.
  Run as
  `SYNAPSE_PHARMACY_E2E_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome npm run test:e2e:pharmacy:smoke`,
  which is the installed brand Chrome (`/usr/bin/google-chrome`,
  156.0.8078.79), not Chromium, against the managed dev server on
  `127.0.0.1:3002`. This supersedes the Chromium-only result below: the earlier
  failure to launch brand Chrome was an artifact of the sandboxed shell
  (`socket() failed: Operation not permitted`), not of the browser. Run from a
  terminal tab on the same host, Chrome launches and the suite passes.
- Edge: **NOT AVAILABLE** on that host (no `msedge` installation).
- Operations layer preflight, with the documented
  `SYNAPSE_PHARMACY_E2E_ALLOW_NON_WINDOWS=1` opt-in:
  `node scripts/e2e-pharmacy-acceptance.mjs operations` reported
  `platform: linux`, `operations: eligible`, `chrome (installed): available`,
  `edge (installed): NOT AVAILABLE`, `credentials: absent`, and the layer as
  `NOT RUN — DISPOSABLE ACCEPTANCE TENANT CREDENTIALS REQUIRED`, exit 0. This
  proves the non-Windows path selects the real blocker instead of crashing; it
  is not an operational run.
- Operations layer: **0 executed, 11 skipped** on the Windows host — none has
  run anywhere. The blocker on Linux is the absent disposable tenant, not the
  operating system: the opt-in exists, and no credentials or local database are
  available here.

A smoke pass on Linux is still not Windows acceptance: it runs the sign-in page,
the empty-submission refusal and the anonymous-edge redirects on a different
operating system from the till. The operations layer that would exercise sales,
refunds and printing remains skipped, and a skipped layer proves nothing about
any of them.

**2026-11-01, Linux host (this working tree), Chromium (historical):**

- `npm run test:workflow-safety` — 75 tests, 75 passed. Includes the 15 tests in
  `scripts/e2e-pharmacy-target.test.mjs`.
- Smoke layer, Chrome project: **22 passed, 0 failed, 0 skipped**, against the
  local dev server on `127.0.0.1:3002`, using
  `~/.cache/ms-playwright/chromium_headless_shell-1234` via
  `SYNAPSE_PHARMACY_E2E_CHROMIUM_EXECUTABLE`. The sandboxed shell could not
  launch the installed brand Chrome, so Chromium was used — that run was not a
  Chrome result (see the 2026-11-02 entry above for the brand-Chrome run).
- Edge: **NOT AVAILABLE** on that host (no `msedge` installation).
- Operations layer: **0 executed, 11 skipped**, all with the annotation
  `NOT RUN — WINDOWS HOST REQUIRED`. No operational journey has run anywhere.
