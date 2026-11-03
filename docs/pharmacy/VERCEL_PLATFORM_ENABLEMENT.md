# Vercel platform enablement — inspection record

**Date: 2026-11-01. Result: the account could not be inspected. Nothing in the
Vercel account was read or changed.**

## What was attempted

| Attempt | Result |
| --- | --- |
| `vercel whoami` | `FetchError … getaddrinfo ENOTFOUND vercel.com` — this environment has no route to Vercel |
| `vercel projects ls` | same DNS failure before any request was made |
| `gh api` on the repository's deployment records | used only for repository facts; it does not expose team, project, plan or integration state |
| npm install of `@vercel/analytics` / `@vercel/speed-insights` | refused by the sandbox (`registry.npmjs.org: 403 user denied`); **not** worked around |

There is no cached Vercel token in this environment and none was used. No
project setting, environment variable, domain, DNS record, integration, or
deployment was read or written.

## What therefore cannot be stated

Anything below that would normally be answered by inspecting the account:

- whether `synapse-pharm`, `synapse-os` and `synapse-demo` exist as projects, in
  which team, on which plan;
- which integrations are installed (Supabase, Sentry, Upstash, …), and whether
  any of them duplicates a resource the application already has;
- whether Web Analytics, Speed Insights, Firewall, WAF, Bot management, rate
  limiting or Feature Flags are available on the plan or already enabled;
- current deployment status, build minutes, function regions, and logs
  retention;
- cost of enabling each surface.

**None of these is guessed at below.** Where a value is plan-dependent, the
document says so.

## Native capability inventory

| Capability | Native to Vercel | Application-side work required | Dashboard work required | Status in this repo |
| --- | --- | --- | --- | --- |
| Web Analytics | yes | script tags + five business events — **done** in `lib/telemetry/` | enable per project; set `NEXT_PUBLIC_VERCEL_INSIGHTS=1` in production | code ready; not enabled |
| Speed Insights | yes | script tag — **done** | enable per project | code ready; not enabled |
| Observability / Logs | yes (all plans; retention varies) | none | none | available once deployed |
| Deployment & release health | yes | none | none | platform-owned |
| Firewall / WAF | plan-dependent (Pro+) | none | create rules | not configured |
| Bot management | plan-dependent (Enterprise) | none | enable | not available to check |
| Rate limiting | plan-dependent | none | rule on POS and auth routes | not configured |
| Security headers | yes, via `vercel.json` | root `vercel.json` owns them — the only one Vercel reads | none | owned by repo config |
| Feature Flags | plan-dependent (Enterprise) | SDK or REST integration | flag definitions | not needed by any current workflow |
| Function performance / cache / error rates | yes | none | none | platform-owned |
| Marketplace integrations | yes | none | install per project | **not installed; not needed** |

No Marketplace provider was discovered or installed. Nothing in the application
needs one today: the database is Supabase (already the application's own
provider), and the analytics, speed and log surfaces above are native.

## The decision this produced

Because the account cannot be inspected, the application was built to be
**inert until a person enables it**:

- nothing loads unless `NEXT_PUBLIC_VERCEL_INSIGHTS=1`, which is set per
  environment, so a preview deployment cannot feed production numbers;
- the loaders are the platform's own `/_vercel/insights/script.js` and
  `/_vercel/speed-insights/script.js`, addressed directly — no new dependency,
  and no duplicate collector alongside a package that would load the same file;
- the events carry a closed schema, so no customer, amount, receipt or clinical
  value can be sent even by mistake;
- pageview URLs are stripped of query strings and fragments before either loader
  sees them.

## What a person with account access must do

See `docs/pharmacy/OPERATIONAL_MONITORING.md` §5. In short: enable the two
analytics surfaces, set the environment variable in production only, deploy,
confirm the two scripts return 200 in production and 404 in a preview, then
create the alerts.

Until that happens, **the application records no telemetry**, and this document
must not be read as evidence that it does.

---

## Precise action list (prepared 2026-11-02, nothing executed)

Everything below is derived from files in this repository. No Vercel API was
called to prepare it; the account state remains unverified (see the top of this
document). Amounts and plan eligibility are stated as *unverified* wherever they
would require the pricing page or the dashboard.

### A. Team identity — resolved from repository history (2026-11-02)

Two team ids appear in the repository. Commit `f7479bb1` (2026-10-08,
"fix stale Vercel IDs") replaced one with the other in the deploy workflow and
named the change explicitly:

```diff
-  VERCEL_ORG_ID: team_ZHaBdLFb1hunAs68QC70HTBy
-  VERCEL_PROJECT_ID: prj_ST72DC6VkMfhon3M1yW2PL575mcd
+  VERCEL_ORG_ID: team_IfLX69fKbBxupsNAtDVzF573
+  VERCEL_PROJECT_ID: prj_k3fiiNA4tfB14Mfv0ZMcSM34MbUB
```

Its commit message says the old pair "pointed at a retired team/project" and the
new pair is "the live synapse-os1 / synapse-os IDs".

Canonical mapping from that evidence:

| Purpose | Team id | Project id | Status |
| --- | --- | --- | --- |
| Live team (`synapse-os1`) | `team_IfLX69fKbBxupsNAtDVzF573` | — | current |
| Live OS root project (`synapse-os`, Root Directory `.`) | `team_IfLX69fKbBxupsNAtDVzF573` | `prj_k3fiiNA4tfB14Mfv0ZMcSM34MbUB` | current; agrees with `.vercel/project.json` |
| Retired team | `team_ZHaBdLFb1hunAs68QC70HTBy` | — | **must not be targeted** |
| Retired project (`synpase-os`, one-letter typo) | retired team | `prj_ST72DC6VkMfhon3M1yW2PL575mcd` | **must not be targeted** |

Two files carried the retired ids and would have acted on them. Both are
corrected in the working tree (2026-11-02, uncommitted):

| File | Correction |
| --- | --- |
| `scripts/sync-vercel-projects.mjs` | team id set to the live team; the retired `synpase-os` entry removed — a PATCH to it would 404 and abort the script before `synapse-demo` and `synapse-pharm` |
| `apps/web/src/lib/vercel-domains.ts` | fallback team id set to the live team |

**Action (owner):** confirm in the dashboard that `synapse-pharm` and
`synapse-demo` belong to the live team; neither id has been verified through an
API call from this repository.

Nothing in this section was executed: no sync, no PATCH, no settings change.

### B. Project inventory and what each one builds

| Project | Project id | Root directory | vercel.json that governs it | Notes |
| --- | --- | --- | --- | --- |
| `synapse-os` | `prj_k3fiiNA4tfB14Mfv0ZMcSM34MbUB` | `.` | root `vercel.json` | live; the only project whose identity is corroborated by both the workflow and the local link |
| `synapse-demo` | `prj_pMAegOucrRxzMOdNgjNYCXE8G7aM` | `.` | root `vercel.json` | demo host redirects live in the root file; owning team unverified |
| `synapse-pharm` | `prj_CHbxKSy0pee2nieRVvQ3Rhyw4cnh` | `apps/pharmacy` | `apps/pharmacy/vercel.json` | the pharmacy portal is **not** deployed by the root project; owning team unverified |
| `synpase-os` *(retired, typo)* | `prj_ST72DC6VkMfhon3M1yW2PL575mcd` | `.` | — | superseded by `synapse-os`; do not target |

If `synapse-pharm` does not exist, the pharmacy portal has no deployment at all.
**Action:** `vercel projects ls --scope <team>` (or the dashboard) and record
which ids resolve. Do not create a project until the name and root directory are
confirmed — a project with the wrong Root Directory builds the wrong app.

### C. Cron capacity (a hard deployment constraint, not a preference)

The root `vercel.json` declares exactly two crons:

- `/api/cron/billing-sweep` at `15 21 * * *`
- `/api/cron/dhis2-export` at `0 23 * * *`

The Hobby plan allows two. `scripts/vercel-crons.test.mjs` pins both schedules
and asserts that `apps/web/vercel.json` declares none. **Action:** add no third
cron on Hobby; a third entry fails the deployment rather than adding a
schedule. Raising the cron count requires a paid plan — amount unverified here.

### D. Ordered dashboard actions

Each row names the capability the person needs. Vercel's role model varies by
plan (Owner / Member / Developer / Viewer and, on paid plans, narrower project
roles); the requirement is the **capability**, not a guessed role name.

| # | Where | Action | Capability required | Plan | Cost |
| --- | --- | --- | --- | --- | --- |
| 1 | Team settings | Confirm the live team is `team_IfLX69fKbBxupsNAtDVzF573` ("synapse-os1"); `sync-vercel-projects.mjs` and `vercel-domains.ts` were corrected to it in the working tree (§A) | View team settings | any | none |
| 2 | Projects list | Confirm the three live/unverified ids in §B resolve; treat `synpase-os` as retired | View projects | any | none |
| 3 | `synapse-pharm` → Settings → General | Confirm Root Directory is `apps/pharmacy` and framework is Next.js | Manage project settings | any | none |
| 4 | `synapse-pharm` → Analytics | Enable **Web Analytics** | Manage project integrations | Hobby or Pro — **unverified which tiers include it** | Free allowance per plan; overage billed per event — **amount unverified** |
| 5 | `synapse-pharm` → Speed Insights | Enable **Speed Insights** | Manage project integrations | Hobby or Pro — **unverified** | Free allowance per plan; overage billed per data point — **amount unverified** |
| 6 | `synapse-pharm` → Settings → Environment Variables | Add `NEXT_PUBLIC_VERCEL_INSIGHTS=1` to **Production only** (not Preview, not Development) | Manage environment variables | any | none |
| 7 | Deploy (or redeploy) `synapse-pharm` | Build from the current commit | Trigger deployment | any | Build minutes per plan — **unverified** |
| 8 | Production URL | `curl -I https://<prod>/_vercel/insights/script.js` and `.../speed-insights/script.js` → **200** | none | any | none |
| 9 | A preview deployment of the same project | The same two URLs → **404**, and `window.va` undefined | none | any | none |
| 10 | `synapse-pharm` → Observability / Logs | Create the alerts in `OPERATIONAL_MONITORING.md` §2 that the plan supports | Manage alerts / integrations | error-spike and availability alerts are plan-dependent — **unverified** | none stated here — **unverified** |
| 11 | `synapse-pharm` → Firewall | Rate-limit `/api/admin/pos/complete-sale` and the auth routes | Manage firewall rules | **Pro or above** | Pro plan required — **price unverified** |
| 12 | Team → Usage / Billing | Enable spending alerts | Billing/owner | any | none |

Blocked or unnecessary:

| Surface | Status | Why |
| --- | --- | --- |
| Marketplace integrations (Supabase, Sentry, Upstash, …) | **do not install** | The database is the application's own Supabase project; no Marketplace resource is required by any current workflow |
| Bot management, Feature Flags | **not needed** | Enterprise-tier; no workflow uses them |
| A third cron | **do not add** | Hobby capacity is full (§C) |

### E. What is configured in code, and what that does *not* prove

Configured and reviewable in this repository:

- root `vercel.json` — build/install/output/framework, the ignore command, the
  two crons, the two `demo.synapseos.tech` redirects;
- `apps/pharmacy/vercel.json` — the second project's build/install/output;
- `apps/web/vercel.json` — inert while the root project's Root Directory is `.`
  (`scripts/vercel-crons.test.mjs` enforces that it stays cron-free);
- `scripts/sync-vercel-projects.mjs` — the intended settings for all four
  projects (requires `VERCEL_TOKEN`; CLI session auth cannot PATCH project
  settings through the REST API, per the script's own refusal);
- `apps/pharmacy/lib/telemetry/` — the inline bootstrap, the closed event
  schema and the `beforeSend` scrubbers, rendered from
  `apps/pharmacy/app/layout.tsx`.

None of that is evidence of account state. Specifically, this repository cannot
tell you whether any project exists, which team owns it, which plan it is on,
whether Analytics or Speed Insights is enabled, whether the environment variable
is set, whether the sync script was ever run, or what any of it costs.

### F. Evidence to capture after each action

1. Dashboard screenshot of the project's General page (name, root directory).
2. Screenshot of the environment-variable list showing `NEXT_PUBLIC_VERCEL_INSIGHTS`
   with scope **Production** only.
3. `curl -sI` output for both loader URLs on production (**200**) and on a
   preview (**404**).
4. A pageview visible in the Analytics dashboard after one real page load — this
   is the first point at which collection, as opposed to code integration, is
   proven.
5. Team → Usage showing the current spend and alert threshold.
6. `vercel projects ls --scope <team>` output listing the projects in §B.

Record the date, the person, and the URL for each. A dashboard toggle is not
evidence; the loader returning 200 in production and the pageview appearing in
the dashboard are.
