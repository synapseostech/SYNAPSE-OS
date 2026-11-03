# Deploy gate — avoid broken production deploys

## Vercel projects (same GitHub repo)

| Project | Root directory | Production URL | Build |
|---------|----------------|----------------|-------|
| `synpase-os` | `.` (repo root) | **synapseos.tech** (landing) + app.synapseos.tech + admin.synapseos.tech | `vercel.json` at root |
| `synapse-demo` | `.` | demo.synapseos.tech | same root `vercel.json` |
| `synapse-pharm` | `apps/pharmacy` | pharm.synapseos.tech | `apps/pharmacy/vercel.json` |

**Domain setup (required):** In Vercel → `synpase-os` → Settings → Domains, add:
- `synapseos.tech` (apex — marketing landing)
- `www.synapseos.tech` (redirect to apex)
- `app.synapseos.tech` (consumer health portal)
- `admin.synapseos.tech` (platform console)

All subdomains point to the **same** `synpase-os` deployment; middleware routes by host.

All three deploy on push to `main` via Vercel Git integration.

## Build gate (branch filter, not a verification gate)

Only the **root** `vercel.json` has an `ignoreCommand`:

```json
"ignoreCommand": "node scripts/vercel-build-gate.mjs web"
```

`apps/pharmacy/vercel.json` has **none**, so the Pharmacy project builds every
deployment Vercel receives.

`scripts/vercel-build-gate.mjs` decides from `VERCEL_ENV` and the branch name
alone. It does **not** run `verify`, type-check or lint — its own header says so,
because `ignoreCommand` often runs before install. Its exit codes are Vercel's,
not a pass/fail of the code:

- Exit **1** → proceed with the build
- Exit **0** → skip this deployment

In practice it skips only preview deployments on branches outside
`main`/`release/`/`hotfix/`/`clinical/`/`staging/`/`integration/`/`fix/`/`feat/`.
Production always builds.

The argument (`web`, `pharmacy`) is ignored by the script.

**Therefore a Vercel deploy is not gated on tests.** The real gate is the CI
`verify` job in `.github/workflows/ci.yml`, which runs on pull requests and on
pushes to `main`. Protect `main` so a red CI run cannot merge — see “CI vs
Vercel Git” below.

## Sync dashboard settings (optional)

Dashboard may still show stale values (e.g. an old Vite `build:demo` command). Repo `vercel.json` overrides on deploy, but to align the dashboard:

1. Create a token at https://vercel.com/account/tokens  
2. Run:

```bash
VERCEL_TOKEN=xxx npm run vercel:sync
```

This runs `scripts/sync-vercel-projects.mjs` and sets build/output/ignore/node version for all three projects.

## Local linking (monorepo)

```bash
# Web (synpase-os) — from repo root
npx vercel link --project synpase-os

# Pharmacy — from apps/pharmacy
cd apps/pharmacy && npx vercel link --project synapse-pharm

# Demo shares root with synpase-os; link when deploying demo explicitly
npx vercel link --project synapse-demo
```

`.vercel/repo.json` maps all three for `vercel link --repo` (local only, gitignored).

## Before pushing to `main`

```bash
npm ci
npm run verify:web
npm run build --workspace @synapse/pharmacy   # if pharmacy changed
```

Only push when both pass.

## CI vs Vercel Git

- **GitHub Actions `verify`** — runs on every push/PR; this is the real gate
- **Vercel Git** — deploys on push regardless of test results; its
  `ignoreCommand` only filters branches, and Pharmacy has none
- **`deploy-vercel` job** — optional CLI deploy after verify (needs `VERCEL_TOKEN` secret)

Required: turn on `main` branch protection with GitHub **`verify`** as a
required status check. Without that setting, a red build can reach production.

## Build commands (source of truth)

| App | Command |
|-----|---------|
| Web | `node scripts/sync-web-public.mjs && npm run build --workspace @synapse/web` |
| Pharmacy | `cd ../.. && NODE_OPTIONS=--max-old-space-size=4096 npm run build --workspace @synapse/pharmacy` |

## Manual production deploy (CLI, after verify)

```bash
npm ci && npm run verify:web
npx vercel pull --yes --environment=production   # synpase-os linked at root
npx vercel build --prod
npx vercel deploy --prebuilt --prod
```

Pharmacy: run from `apps/pharmacy` with that project linked.
