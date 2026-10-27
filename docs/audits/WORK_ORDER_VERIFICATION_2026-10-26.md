# Verification of the goose work order

**Date:** 2026-10-26
**Subject:** `docs/prompts/GOOSE_REQUIRED_CHANGES_2026-10-26.md`, executed against branch `integration/synapse-2026-10-09`, HEAD `c9e53e37`
**Method:** every claim re-checked against the tree and every gate re-run here. Nothing was committed, applied or deployed. No database was contacted.

---

## Per-task verdict

| Task | Claim | Verdict |
| --- | --- | --- |
| 1 | crons moved to root, app file emptied, test added | **holds** — root declares `billing-sweep 15 21 * * *` and `dhis2-export 0 23 * * *`; `apps/web/vercel.json` has no `crons` key; the third of four tests fails if it ever gains one, and the fourth checks each schedule is once-daily and its route exists |
| 2 | drift guard reads the directory | **holds** — `EXPECTED.migrationCount` is now `readdirSync(supabase/migrations)`; evidence records 197; gitHead stays pinned with a regeneration message on failure |
| 3 | outbox observed, not drained | **holds, then corrected** — route and 8 tests present; the row-download counting defect found in review is fixed, the route is now 10 tests |
| 4 | packages linted | **partly holds** — interop enables `no-explicit-any`; db disables both rules it ships, so db's lint proves the package parses and nothing more |
| 5 | both tables typed | **holds** — `synapse_domain_events` and `pharmacy_accounting_periods` each appear exactly once in `packages/db/src/types.ts`, with `close_snapshot: Json` on the row, insert and update shapes |
| 6 | close evidence on screen | **holds** — `close_snapshot` is in the periods select, the "Recorded at close" column renders sales, journal entries, open tills and unmatched lines; readiness route has its 4 cases |
| 7 | figures corrected | **holds for figures, not for conclusions** — both records still asserted that the drift guard compares evidence to a constant, and that no `packages/*` workspace is linted. Both are now false. Superseded notes added rather than editing the original sentences |

## Gates, re-run in this session

```
db:check                 197 migration files OK
test:vercel-config       4 pass
test:workflow-safety     59 pass
test:interop-runtime     41 pass
test:memory-sync-outbox  20 pass
test:general (pharmacy)  576 passed, 15 skipped, 62 files
  lib/accounting/close-readiness.test.ts            17
  app/api/admin/accounting/periods/readiness/…      4
type-check pharmacy      exit 0
type-check web           exit 0
lint pharmacy            exit 0, zero warnings
lint db / interop        exit 0
test:security-gates      SECURITY GATES PASS migrations=10 failures=0
test:routes              PASS pages=288 nav_links=73 roadmap=77
test:db-acl              definer_functions=68 public_grants=0 live_check=SKIPPED_NO_DATABASE_ACL_URL
evidence-drift           6 pass
```

## Three defects found in the delivered work

**`collect-evidence.mjs` recorded `null` for every `node:test` suite.** `parseNodeTestCounts` matched only the spec reporter's `ℹ tests N`; whenever output is redirected — which is how the script always runs it — node emits TAP and prints `# tests N`. Two regenerations therefore blanked `rls-tenant-isolation`, `security-gates`, `workflow-safety` and `rls-matrix` in `evidence.json` *and* in the generated block of both audit documents. Fixed to accept either reporter; the drift test caught it, which is the guard doing its job.

**The `security-gates` figure is self-referential.** `test:security-gates` includes `scripts/evidence-drift.test.mjs`, and that test compares `evidence.json` to the tree. While `collect-evidence` is collecting, the test reads the *previous* file, so the first collection after any evidence change always records one failure that describes the last run. That is the `46 pass / 1 fail` that was sitting in the artifact; it was never a failing security gate. Recorded in the script header. The correct reading of `exitCode: 1` there is "evidence was stale when this started".

**The outbox health route counted by downloading rows.** `select("status", { count: "exact", head: false })` fetches every row and counts them in JS. PostgREST caps the rows it returns, and `synapse_domain_events` is never drained, so past that cap every count would report "at most the cap" — understating a backlog in the one route built to detect it. Rewritten to four `head: true` counts, which is the idiom the rest of this codebase already uses (`dhis2-export-actions.ts`, `hospital-os-data.ts`, `platform-data.ts`). A second fail-open went with it: a non-numeric `DOMAIN_EVENT_PENDING_ALERT_MINUTES` produced an Invalid Date threshold, making every comparison false and the queue permanently healthy. Both covered; the route is now 10 tests, including one that asserts the counts come from head requests and one that asserts the 60-minute fallback.

## What this does not establish

**That the root Vercel project reads the root file.** Task 1 rests on `scripts/vercel-crons.test.mjs`'s own premise — Root Directory ".". If a second Vercel project points at `apps/web`, deleting that file's `crons` array removed a live `mobile-alerts` schedule. It could not be checked from here: it is a fact about the Vercel project, not about the repository.

**That any of the new SQL exists.** `20261026190000` is unchanged and unapplied. The `close_snapshot` select, the readiness RPC and the `ACCOUNTING_PERIOD_OPEN_TILLS` branch all depend on it, and no request has been made against a database.

**That `packages/db` is linted in any meaningful sense.** At the time of writing its config disabled `no-explicit-any` at seven `as any` sites (`identity-persist.ts` 4, `audit.ts` 2, `till-service.ts` 1 — the config comment's "eleven" was wrong) and `no-unused-vars` outright. Both rules were turned on later the same day; see the follow-up section.

**That the health route runs anywhere.** It is deliberately not in `vercel.json`; the two Hobby cron slots are taken by `billing-sweep` and `dhis2-export`, and `mobile-alerts` remains declared nowhere.

---

# Follow-up: verification of Tasks A–D (same day)

The work order at `docs/prompts/CLAUDE_CODE_NEXT_2026-10-26.md` was executed. Everything below was re-run here rather than read off the report.

## Verified

| Claim | Result |
| --- | --- |
| drift split out of the security-gates suite | `package.json` has `test:evidence-drift`; `test:security-gates` is back to its three files; `ci.yml` runs the new gate at line 139 |
| the reference paragraph is gone from the collector | header no longer contains it. It now reads "It writes `artifacts/readiness/evidence.json` and refreshes the delimited evidence block in the two audit documents below. Nothing else." — a correction, since "writes exactly one file" was false: lines 143–153 rewrite both documents |
| both rules on in `packages/db` | `no-explicit-any: error`, `no-unused-vars` with `_` ignore patterns; lint exit 0; 11 line-level disables in `src`, 1 added and 10 pre-existing |
| the accounting route is typed | no `any` left in the file; the migration-coupling header survives |
| four more packages linted | `auth`, `config`, `email`, `ui` each exit 0; root `npm run lint` exit 0 |
| gates | security-gates 41 pass (47 − 6 drift tests), drift 6 pass, pharmacy 576 passed / 15 skipped / 62 files, web + pharmacy type-check exit 0, db:check 197 |

`test:memory-sync-outbox` was reported unexecuted for a sandbox AF_UNIX restriction. It runs here: **20 pass, 0 fail**. The restriction was that environment's, not the gate's.

## One defect: the new CI step cannot pass on a clean checkout

`scripts/evidence-drift.test.mjs` reads `artifacts/readiness/evidence.json` at module scope — `readFileSync`, no existence check (`grep -c existsSync` → 0). That file is **gitignored**: `.gitignore:25–33` ignores `/artifacts/readiness/*` and un-ignores exactly four siblings (`PRODUCTION_GREEN_REPORT.json`, `web-route-manifest.json`, `route-integrity.json`, `db-acl-inventory.json`) — not `evidence.json`, and `git ls-files` confirms it has never been tracked.

Proved on an isolated copy of the tree, not asserted:

```
# evidence.json absent, everything else present
Error: ENOENT … artifacts/readiness/evidence.json
# pass 0   fail 1

# evidence.json restored, docs/audits absent
error: ENOENT … docs/audits/REMEDIATION_CLOSURE_2026-10-25.md
# pass 4   fail 2
```

So the `Evidence drift guard` step is red on every fresh clone, for a reason that has nothing to do with drift — which is the failure mode that teaches people to delete a gate. `docs/audits/` and `scripts/evidence-drift.test.mjs` are merely untracked, so a commit would carry them; the blocker is specifically the generated file.

Three ways out, and the choice is the owner's because it decides what enters git:

1. **Track it.** Add `!/artifacts/readiness/evidence.json` to `.gitignore` and commit it. The gate then means what it says. Cost: every regeneration rewrites the timestamp, so it diffs on each collection — which is also the proof it was regenerated.
2. **Generate it in CI before the gate.** Rejected: `collect-evidence.mjs` writes that file *and* the doc blocks the test compares against, so the step would regenerate whatever it is about to assert.
3. **Keep the gate local.** Drop the CI step and run `npm run test:evidence-drift` on the developer machine, where the artifact exists. Honest, but nothing stops a stale figure from reaching the branch.

**Resolved the same day: option 1, and verified.** `.gitignore:34` now carries `!/artifacts/readiness/evidence.json`, `git check-ignore` matches that negation, and `git status` reports the file as untracked-but-trackable. The artifact was then regenerated from the tree rather than hand-corrected: `node scripts/collect-evidence.mjs` exit 0, producing a file **identical apart from its timestamp** to the hand-patched one that preceded it. Every suite is now machine-produced — `security-gates` 41/41, `rls-tenant-isolation` 21, `hardening` 72, `tenancy` 59, `workflow-safety` 59, `rls-matrix` 10, `dbAcl` 68/0/20, routes 288/73/77, migrations 197 — with no `null` anywhere in the file. `npm run test:evidence-drift` is 6 pass.

The commit that lands this must contain the artifact, both audit documents, `scripts/evidence-drift.test.mjs` and `scripts/lib/evidence-block.mjs`, plus the four new eslint configs. Omit any of them and the step returns to ENOENT.

## Two housekeeping findings

**Index-taking git commands leave a lock behind here, and removal is unreliable.** The facts, in order. A 0-byte `.git/index.lock` dated 2026-10-24 sat in the tree with no git process holding it. It was removed (`rm` exited 0), and then a fresh lock appeared at 17:17:24 — created by a `git add --dry-run` used as the acceptance check, because `git add` refreshes the index and therefore takes the lock. Removing that one succeeded too (`rm` exited 0) a few minutes later; a separate `rm` attempt in between failed with `Operation not permitted`. Read-only commands (`git status`, `git ls-files`, `git diff`) work either way and print `warning: unable to unlink '…/index.lock'` while a lock is present.

So the earlier claim in this document that the lock "cannot be cleared from this sandbox" was wrong, and is corrected here: deletion sometimes succeeds and sometimes does not, in the same session, and the difference was not isolated. What is reliable is the cause — an index-refreshing command leaves the lock behind. Practical consequence unchanged and now better grounded: **commit from the host**, `rm .git/index.lock` first with no git process live, and do not use `git add --dry-run` as an acceptance check; it manufactures the condition it is meant to test for. The current tree carries no lock (`ls` → no such file), and `git status` runs without a warning.

**`packages/db` still has no `type-check` script**, so root `turbo type-check` skips the package entirely and it is checked only through `apps/web` and `apps/pharmacy`. The decision not to add one is defensible — a temporary tsconfig surfaced ten pre-existing errors in four test files — but the consequence should be stated plainly: lint covers `src`, and nothing type-checks `src` on its own.

## Not established here

`verify:web` was reported exit 0 with 308/308 static pages; it was not re-run in this pass. The same migration, cron-slot, held-file, clinical-catalogue and `PUBLIC`-policy blocks stand unchanged.
