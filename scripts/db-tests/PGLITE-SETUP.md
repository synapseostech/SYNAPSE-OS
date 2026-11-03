# Running the pharmacy chain on a real PostgreSQL engine without Docker

`run-pharmacy-db-harness.sh` needs a Supabase CLI stack, and `supabase start`
needs a reachable Docker daemon. On a host where the daemon is unreachable and
no PostgreSQL server binary is installed, `run-pharmacy-db-pglite.mjs` is the
remaining way to execute SQL against a real engine.

**What it is.** [PGlite](https://github.com/electric-sql/pglite) is PostgreSQL
compiled to WebAssembly and linked into the Node process. It runs the real
planner, executor, constraint system, triggers, `SECURITY DEFINER` semantics and
row-level security. It is not a mock and not a SQL reimplementation. Row
filtering, policy `USING`/`WITH CHECK` evaluation and cross-tenant write refusal
all execute in PostgreSQL's own code (`src/backend/utils/security/policy.c`,
`rls.c`).

**What it cannot prove.** Be explicit about this when quoting a run:

| Not available | Consequence |
|---|---|
| A second connection | No statement-level or transaction-level concurrency. Race conditions, `FOR UPDATE` contention and "last unit" oversell cannot be exercised. `run-pharmacy-db-harness.sh`'s `concurrency` suite stays unproven. |
| PostgREST and Supabase Auth | Policies are proven under `SET ROLE` plus `request.jwt.claim.*`, which is the same claim shape GoTrue mints and PostgREST reads, but it is not an HTTP request through PostgREST. |
| `pgvector` | The two `ivfflat` indexes and the `public.vector` column type are not available. The runner substitutes `text` and skips the indexes. Nothing the pharmacy suites touch uses them. |
| The production PostgreSQL major version | PGlite 0.5.11 embeds PostgreSQL 18.6. Production runs whatever Supabase provisioned. Where a statement's behaviour is version-dependent the runner says so rather than hiding it. |

## 1. Get the engine

The package is **not** a dependency of this repository, and must not become one.

### With network access

```bash
mkdir -p "$HOME/.cache/synapse-pglite" && cd "$HOME/.cache/synapse-pglite"
npm init -y >/dev/null
npm install --no-audit --no-fund @electric-sql/pglite@0.5.11
export PGLITE_DIST="$PWD/node_modules/@electric-sql/pglite/dist"
```

### Offline, from an npm cache that already holds the tarball

`npm install --offline` fails here even when the tarball is cached, because the
registry *metadata* is not cached — only the tarball. Resolve the tarball by its
content address instead:

```bash
mkdir -p "$HOME/.cache/synapse-pglite" && cd "$HOME/.cache/synapse-pglite"
node -e '
const { execFileSync } = require("node:child_process")
const fs = require("node:fs")
const entry = execFileSync("grep", ["-rl", "pglite-0.5.11.tgz", process.env.HOME + "/.npm/_cacache/index-v5"])
  .toString().trim().split("\n")[0]
// Each cacache index line is "\t<sha1>\t<json>"; only the JSON matters.
const line = fs.readFileSync(entry, "utf8").split("\n").at(-1)
const { integrity } = JSON.parse(line.slice(line.indexOf("{")))
const hex = Buffer.from(integrity.replace(/^sha512-/, ""), "base64").toString("hex")
const tarball = process.env.HOME + "/.npm/_cacache/content-v2/sha512/" + hex.slice(0, 2) + "/" + hex.slice(2, 4) + "/" + hex.slice(4)
fs.mkdirSync("pkg", { recursive: true })
execFileSync("tar", ["-xzf", tarball, "-C", "pkg", "--strip-components=1"])
console.log("extracted")
'
export PGLITE_DIST="$PWD/pkg/dist"
```

If neither route is available, the runner exits 2 with
`CANNOT RUN: PGLITE_DIST is not set` and no proof is produced. That is the
honest outcome, not a skip to paper over.

## 2. Run it

```bash
# Apply the canonical snapshot and every migration after SNAPSHOT_CUTOFF.
node scripts/db-tests/run-pharmacy-db-pglite.mjs chain

# Same, then the pharmacy tenant-isolation assertions.
node scripts/db-tests/run-pharmacy-db-pglite.mjs isolation

# Same, then the sale, tax and ledger assertions.
node scripts/db-tests/run-pharmacy-db-pglite.mjs financial
```

`chain` reports every migration file that fails and keeps going, so one failure
never hides the rest. `isolation` seeds two tenants and nine accounts and
asserts eighteen access rules from the outside, as a signed-in caller:
cross-tenant read and write, tenant administrators, both membership sources
(`pharmacy_user_settings` and `staff_scope_assignments`, active and withdrawn),
an archived profile, `anon`, profile privilege escalation, the
`pharmacy_caller_tenants()` ACL surface, and storage.

`financial` takes a sale through `complete_pharmacy_sale` and checks the stored
sale, the per-line tax snapshot and the accounting journal; then the refund and
receivable paths — a fully-credit sale, a part-paid one, one the customer had
already partly repaid, a receivable that posted short, and one never posted at
all — against `reverse_pharmacy_sale`; a received purchase, the supplier payable
it leaves and the payment that settles it; the till cash events and the drawer
total they add up to; and the five purchase-table policies. Every expected
figure is computed in the runner from the inputs, never read back out of the
database to form its own expectation.

The runner takes no options. It applies the canonical snapshot and the
migration files exactly as the repository contains them, so a `42/42` means
this tree builds a database.

`20261102130000` used to abort on a fresh database because five purchase-table
policies created by `20260921120000` defaulted to `PUBLIC` and were missing
from its repair list (PR-013). The runner used to inject that repair behind
`--assume-repair`; the ten lines now live in the migration itself, so the flag
is gone and an unknown option is rejected rather than ignored.

## 3. Interpreting a run

- `[summary] outcomes: PASS` with exit 0 means every migration applied and every
  assertion passed **on PostgreSQL 18.6 (WASM)** with the deviations listed at
  the top of the output.
- `CANNOT RUN` (exit 2) means the engine was missing. Nothing was proven.
- Any `FAIL` line is a real result from the engine. Do not re-run with a changed
  flag until you understand which one.
