# Claude Code — the work that is actually left

**Written:** 2026-10-26, after auditing the previous work order against the tree.
**Repo:** `SYNAPSE-OS` (npm workspaces + Turborepo, Node 22)
**Branch:** `integration/synapse-2026-10-09`, HEAD `c9e53e37`
**Tree state now:** 52 modified tracked files, 63 untracked, nothing committed. That is deliberate. Do not tidy it.

The previous handover (`docs/prompts/GOOSE_REQUIRED_CHANGES_2026-10-26.md`) has been executed and independently verified. **Do not redo it.** What follows is only what survived that work.

Read these first — they are short, and they explain why the code looks the way it does:

- `docs/audits/WORK_ORDER_VERIFICATION_2026-10-26.md` — what was verified, what was found wrong, what could not be established
- `docs/decisions/CONNECTOR_RUNTIME_2026-10-25.md`
- `docs/decisions/ACCOUNTING_PERIOD_CLOSE_2026-10-25.md`

---

## Ground rules — not negotiable

1. **Never commit, push, merge, rebase, amend or rewrite history. Never deploy.** Work in the tree and leave it dirty for review.
2. **Never connect to, or mutate, any remote, staging, linked or shared database. Never apply a migration anywhere, including a local stack, unless the owner asks for that specific run in the same message.** Everything under `supabase/migrations/*` is read-only here.
3. **Never run destructive Git commands.** No `reset --hard`, `clean`, `stash`, `checkout -- <path>`. A clean-looking tree means you destroyed someone's work.
4. **Never print secrets, never use real patient data, never invent clinical data.** No dosages, no interaction tables, no catalogue entries.
5. **A static test never proves a runtime control.** If you cannot execute it, write "not executed", not "verified".
6. Match the surrounding style. No new dependencies, no reformatting of files you are not changing, no drive-by renames.

---

## Already done — do not redo, do not "improve"

- `vercel.json` schedules `billing-sweep` and `dhis2-export`; `apps/web/vercel.json` has no `crons`; `scripts/vercel-crons.test.mjs` fails if it ever gains one (4 tests).
- `scripts/evidence-drift.test.mjs` reads `supabase/migrations` and compares the recorded count to the directory; `artifacts/readiness/evidence.json` records 197.
- `scripts/collect-evidence.mjs` parses both node reporters (`ℹ tests N` and `# tests N`). It was silently writing `null` before; do not revert that.
- `apps/web/src/app/api/cron/domain-event-health/route.ts` counts with four `head: true` queries and falls back to a 60-minute threshold on a malformed env value (10 tests). It is deliberately **not** in `vercel.json`.
- `packages/interop` and `packages/db` each have an `eslint.config.mjs` and a `lint` script.
- `packages/db/src/types.ts` describes `synapse_domain_events` and `pharmacy_accounting_periods` (including `close_snapshot`).
- `apps/pharmacy` periods GET selects `close_snapshot` and the portal renders it; the readiness route has 4 tests.

---

## Task A — stop the drift assertion describing the previous run

`test:security-gates` (root `package.json`) runs four files, one of which is `scripts/evidence-drift.test.mjs`. `scripts/collect-evidence.mjs` runs `test:security-gates` while it is collecting evidence. So the drift check compares the file **it is in the middle of regenerating**: it reads the previous `evidence.json`, and the first collection after any evidence change always records one failure that describes the last run rather than the tree. That is where the `46 pass / 1 fail` in the artifact came from. It was never a failing security gate, and it is currently papered over with a comment in the script header.

**Do this.**

- Give the drift assertion its own script — `"test:evidence-drift": "node --test scripts/evidence-drift.test.mjs"` — and remove that file from `test:security-gates`.
- Add the new script to CI so a stale `evidence.json` still fails the build — `.github/workflows/ci.yml:136` already runs `npm run test:security-gates`; put `npm run test:evidence-drift` beside it. Keep the failure message that names `node scripts/collect-evidence.mjs` as the remedy.
- Delete the "Known self-reference" paragraph from `scripts/collect-evidence.mjs`'s header. Once the test is out of that suite, the paragraph is false.

**Prove it, don't assert it.** Edit `artifacts/readiness/evidence.json` to `migrationCount: 196`, run `npm run test:evidence-drift` and confirm it fails with the regeneration message; then restore 197 and confirm it passes, and confirm `npm run test:security-gates` passes in both states. Restore the file exactly — verify with `git diff --stat artifacts/` that the only change is the one you intend.

**Do not** delete the assertion, loosen it to a range, or make it skip when evidence is absent.

## Task B — make `packages/db`'s lint mean something

The package now has a config that turns off both rules it ships: `@typescript-eslint/no-explicit-any` off, and `no-unused-vars` off ("pre-existing unused type imports"). A lint with no rules proves the package parses. That is the honest description of what it does today, and it is not worth a CI slot.

The comment in that config claims "11 existing PostgREST boundaries". There are **7**, in three files: `identity-persist.ts` (4), `audit.ts` (2), `till-service.ts` (1). That is the size of the job — small, and worth doing properly rather than suppressing.

**Do this.**

- Enable `no-explicit-any` and fix the boundaries it reports. The `Database` type is already in `packages/db/src/types.ts`; most of these are a `.from("table")` call that can be typed, or a row that can be `Tables<"table">["Row"]`. Where a value genuinely crosses an untyped PostgREST boundary, cast to the narrowest type that is true rather than to `any`.
- If a single line cannot be typed without changing behaviour, use `// eslint-disable-next-line @typescript-eslint/no-explicit-any` **on that line** with a comment saying why, and leave the rule itself on. Do not solve this at the rule level.
- Then re-enable `no-unused-vars` with `argsIgnorePattern: "^_"` and `varsIgnorePattern: "^_"` rather than `off`, and fix what still reports. Unused type imports are deletions, not suppressions.

**Gate:** `npm run lint --workspace @synapse/db` exits 0 with `--max-warnings 0` and both rules **on**, and the two workspaces that consume this package still type-check (`npm run type-check --workspace @synapse/web` and `--workspace @synapse/pharmacy`). Note that `packages/db` has no `type-check` script at all — root `type-check` is `turbo type-check`, which skips it — so if you want the package checked on its own, adding `"type-check": "tsc --noEmit"` is a one-line change; say so in your report if you add it. Report the count of line-level disables that remain and where.

**Do not** fix this by editing `types.ts` to make handlers loosely typed.

## Task C — spend the types the last change bought

Two call sites still cast away the types that now exist.

- `apps/pharmacy/app/api/admin/accounting/periods/route.ts` casts the client to `any` for both the `.select(...)` and the `.rpc("close_pharmacy_accounting_period", …)`. `pharmacy_accounting_periods` is in `types.ts` now. Type the select and the RPC return; the file's header comment explains why the `close_snapshot` column is coupled to `20261026190000`, and that explanation should stay.
- `packages/db/src/domain-event-outbox-store.ts` — `createDurableOutboxStore` leaves its generic open, which is why callers pass `unknown`. Now that `synapse_domain_events` is typed, see whether the store can be narrowed to it. If it cannot without changing the store's deliberate generics, say so in one sentence and leave it.

**Do not** call the durable store from application code, and do not wire the relay to anything. `20261026180000_domain_event_outbox_dispatch.sql` is unapplied; the store queries columns that do not exist yet.

**Gate:** `npm run type-check --workspace @synapse/pharmacy`, `--workspace @synapse/web`, `--workspace @synapse/db` all exit 0; `npm run test:general --workspace @synapse/pharmacy` still 576 passed.

## Task D — the remaining four packages

`packages/auth`, `packages/config`, `packages/email`, `packages/ui` still have no `lint` script, so root `turbo lint` no-ops for them. Same config shape as `packages/interop`. Add the script and config, fix what reports, and **report per package** what you had to disable and why — "clean" from a config with no rules is not clean. If a package has nothing worth linting (a constants package, for instance), say that instead of adding a ceremonial config.

Lowest priority of the four tasks. Do it after A, B and C are green.

---

## Blocked — needs the owner, do not attempt

**Which cron gets the two Hobby slots.** `billing-sweep` and `dhis2-export` hold them. `mobile-alerts` is now declared in no config at all, and `domain-event-health` has no caller. Choosing means dropping one of the three, and that is a product decision, not an engineering one. Do not add a cron, do not delete either route. If you were given a choice in your prompt, implement exactly that choice and say so.

**Applying migrations.** `20261025120000`, `20261026120000`, `20261026130000`, `20261026160000`, `20261026170000`, `20261026180000` and `20261026190000` are prepared and unapplied by design. Dispatch is the owner's decision. So the readiness RPC, the `close_snapshot` select and the `ACCOUNTING_PERIOD_OPEN_TILLS` branch have never executed against a database — do not describe them as working.

**`supabase/held/scope_staff_intake_policies_to_tenant.sql`.** Deliberately outside every applying glob, pending a policy decision. Do not move it, do not "restore" a timestamp prefix.

**Clinical catalogues and drug codes.** Three of the four catalogues in `apps/web/src/lib/clinical-safety/` are empty because filling them is a clinical governance act. Do not populate them, and do not invent dosage or interaction data to make a test pass.

**The `PUBLIC` permissive policies** on `products`, `consult_queue`, `order_items`, `gas_cylinders` and the telemedicine tables. Which reads are legitimate is a product-position question. Do not resolve them by tightening and seeing what breaks.

**Production.** No preflight, no `psql`, no `verify` against anything but this tree.

---

## Gates before you report

```
npm run db:check                                     # 197 migration files OK
npm run test:vercel-config                           # 4 pass
npm run test:workflow-safety                         # 59 pass
npm run test:interop-runtime                         # 41 pass
npm run test:memory-sync-outbox                      # 20 pass
npm run test:security-gates                          # SECURITY GATES PASS … failures=0
npm run test:evidence-drift                          # new in Task A — 6 pass
npm run test:routes                                  # PASS pages=288 nav_links=73 roadmap=77
npm run test:db-acl                                  # definer_functions=68 public_grants=0
npm run test:general --workspace @synapse/pharmacy   # 576 passed, 15 skipped, 62 files
npm run lint --workspace @synapse/pharmacy
npm run lint --workspace @synapse/db                 # with rules ON after Task B
npm run lint --workspace @synapse/interop
npm run type-check --workspace @synapse/pharmacy
npm run type-check --workspace @synapse/web
```

(`packages/db` has no `type-check` script; it is checked only through its consumers.)

A note on `npm run verify:web`: it does complete here — it type-checks, syncs public assets and runs a full Next build over 288 routes, exiting 0. It takes minutes. Run it in the background or in CI rather than inside one long call, and report what it produced, including "nothing yet".

If a gate fails before you change anything, say so and stop on that item. Do not "fix" it to make your change look clean.

## What to report back

For each task: the files changed, the command you ran, and its real output. Then the things you could not verify and why. Mark each task `done`, `blocked` or `not attempted` — no partial credit, and no claim that a test file proves a runtime behaviour. If a rule is still disabled somewhere, say where and why in the same breath as calling the lint clean.
