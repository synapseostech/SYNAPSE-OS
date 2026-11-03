# SYNAPSE Pharmacy — operational monitoring and alerts

**Status: specification. Nothing in this file is configured in the Vercel account yet.**
The account could not be inspected from the build environment this was written in
(no network route to `vercel.com`); every dashboard step below is therefore an
instruction for a person with account access, not a record of a completed change.

The rule that shapes all of it: **a metric names a workflow, never a person or a
payment.** No patient name, phone number, receipt number, amount, diagnosis,
prescription or account identifier leaves the application except into the
application's own database.

---

## 1. What is visible, and where

| Surface | What it answers | Where it lives | Configured? |
| --- | --- | --- | --- |
| Web Analytics | which portal screens are used, how often, how they are reached | Vercel project → Analytics | **no** — enable per project |
| Speed Insights | real-user Core Web Vitals per route | Vercel project → Speed Insights | **no** — enable per project |
| Observability / Logs | function invocations, errors, duration, cold starts | Vercel project → Logs | available on every plan; retention by plan |
| Deployment health | build success, build duration, failed deployments | same project → Deployments | already recorded by the platform |
| Firewall / WAF / Bot management | blocked requests, attack patterns | project → Firewall | plan-dependent; **not enabled** |
| Rate limiting | per-route abuse protection | project → Firewall rules | plan-dependent; **not enabled** |
| Spending alerts | cost anomalies | team → Usage | **not enabled** |

The application-side hook is `apps/pharmacy/lib/telemetry/events.ts`. It emits
five events, with a closed schema:

| Event | Properties | Why it is safe |
| --- | --- | --- |
| `sale_completed` | `items`, `payment`, `credit`, `offline` | counts and closed enums; no receipt number, customer, or amount |
| `sale_failed` | `stage`, `status` | HTTP status only; no response body |
| `refund_recorded` | `items`, `reason` | closed reason set; no customer |
| `tally_cutover_completed` | `chunks`, `documents` | counts only |
| `tally_cutover_blocked` | `reason` | one of six closed values, mapped from the refusal code |

`eventPayload` drops every property the event does not declare, so a caller that
mistakenly passes a customer name sends nothing extra. The inline bootstrap
(`lib/telemetry/bootstrap.ts`) also strips query strings and fragments from
pageview URLs before either loader sees them.

Nothing is sent unless the deployment's `NEXT_PUBLIC_VERCEL_INSIGHTS` is `1`.
Set it in **production only**. Preview deployments then record nothing, which is
what keeps test traffic out of production numbers.

---

## 2. Signals, thresholds, and routing

Each row is one alert. A signal without a threshold and an owner is noise, so
each row names both.

### 2.1 Availability

| Signal | Source | Threshold | Route |
| --- | --- | --- | --- |
| Portal unreachable | external probe on `/api/ready` | 2 consecutive failures from 2 regions | on-call, immediate |
| Readiness degraded | `apps/pharmacy/app/api/ready/route.ts` | non-200 for 3 consecutive minutes | on-call, immediate |
| Deployment failed | Vercel deployments | any production deployment failing to build or promote | release owner, immediate |

### 2.2 Authentication and authorisation

| Signal | Source | Threshold | Route |
| --- | --- | --- | --- |
| Auth failure burst | Logs filtered on 401/403 from `/api/admin/*` | > 3× the trailing 24 h hourly median, sustained 10 min | on-call, investigate |
| Repeated 403 on one account | Logs | > 20 in 5 minutes for the same route | release owner, next business morning |
| Suspicious sign-in volume | GoTrue/Supabase auth logs | > 10 failed sign-ins per email in 10 min | security owner, immediate |

Deliberately excluded: any alert payload containing an email address or token.
The alert carries the route, the count, and the window; the investigation reads
the logs in the console.

### 2.3 API and function health

| Signal | Source | Threshold | Route |
| --- | --- | --- | --- |
| 5xx rate | Vercel Functions logs | > 1 % of invocations over 5 min | on-call |
| Function error spike | same | > 10 errors in 1 min on one route | on-call |
| Function timeout | same | any invocation at the plan's max duration | release owner |
| Slow API | Speed Insights / logs | p95 > 1.5 s on POS routes for 10 min | release owner |

### 2.4 Sales and payments

| Signal | Source | Threshold | Route |
| --- | --- | --- | --- |
| Failed sale attempts | `sale_failed` event + server logs on `/api/admin/pos/complete-sale` | > 5 in 15 min | on-call |
| Sale succeeded, credit not recorded (`creditWarning`) | server log line | any occurrence | on-call, same day |
| Completed-sale route errors | logs | any 5xx | on-call |
| Refund failures | logs on `/api/admin/refunds` | any 5xx | release owner |

The event tells us a workflow failed; it never tells us which sale. The
correlation is done inside the database by the operator.

### 2.5 Database connectivity

| Signal | Source | Threshold | Route |
| --- | --- | --- | --- |
| Database unreachable | readiness route + 5xx with connection errors | 2 minutes | on-call, immediate |
| Write failures | logs where PostgREST returns a write error | > 3 in 5 min | on-call |
| Connection pool saturation | provider metrics | > 80 % of pool for 5 min | release owner |

### 2.6 Tally bridge and cut-over

| Signal | Source | Threshold | Route |
| --- | --- | --- | --- |
| Bridge unreachable during an extraction | **no server signal exists**: the portal calls the bridge directly, so the failure is shown to the operator in the browser. Adding a server-side beacon is the follow-up. | any `TALLY_BRIDGE_*` failure the operator reports | release owner |
| Cut-over blocked | `tally_cutover_blocked` event | any, during a scheduled cut-over window | release owner + pharmacy owner |
| Apply lease held too long | database: `pharmacy_tally_cutover_locks` older than 15 min | any | on-call |
| Audit row missing on a completed cut-over | preflight state `blocked` with an `audit` failure | any | release owner, immediate |

#### Reading a cut-over failure from the logs

Every apply request writes one line per unit of work before that work runs, and
one line if the request stops. Both are single-line JSON on the
`[pharmacy][tally]` prefix, so the session id alone finds everything one
cut-over did.

| Line | Level | When | Carries |
| --- | --- | --- | --- |
| `tally.apply.step` | `log` | before each stage and each 250-voucher chunk | `sessionId`, `tenantId`, `stage`, `offset`, `counts`, `failures` |
| `tally.apply.failed` | `error` | a step could not continue | the same position, plus `phase`, `errorName`, `errorMessage`, `failedStage`, `failedItem`, `dbError`, `recentFailures` |
| `tally.apply.request_failed` | `error` | the recovery path itself threw, so no checkpoint may exist | `sessionId`, `tenantId`, the error |
| `tally.request.failed` | `error` | any Tally route ending in an unmapped 500 | the error, no session context |

`phase` says how far the request got, and is the difference between "nothing was
written" and "some of it was, and the next call resumes from here":

| `phase` | Meaning |
| --- | --- |
| `load-plan` | the step's input could not be read; no row was touched by this step |
| `apply` | the database refused a write inside the step; earlier items in it may have landed |
| `checkpoint` | the work landed but its resume position did not save — the log is the only record of where it got to |
| `finalize` | the cut-over applied, but its audit row or completion update failed |

`dbError` is PostgREST's own report: `code` is the SQLSTATE (`42501` insufficient
privilege, `23505` unique violation), `details` and `hint` usually name the
offending key. `failedItem` is the account code or batch label for `accounts`,
and the sale or purchase source id for `journals`.

The step line is written **before** the work, so a request the platform kills on
timeout still shows the last step it entered; the failure line never appears in
that case, because nothing caught it.

`progress.failures` — listed in `recentFailures` and checkpointed to the session
— are item-level refusals that do **not** stop the cut-over: an unmapped
account, an unbalanced journal, a product a sale line could not be linked to.
They are the exceptions §5 of the acceptance criteria reviews. A cut-over can
complete with them; they are not what `tally.apply.failed` means.

The same reason is saved to the session's `error_message` as one sentence naming
the phase, the step and the database's message, so an operator who never opens
the log can still read it on the session screen. The next successful step clears
it.

Reading the lines from a terminal, with the CLI linked to the project:

```bash
npx vercel logs --environment production --json --since 24h | grep 'tally.apply'
```

Narrowing to one cut-over:

```bash
npx vercel logs --environment production --json --since 24h | grep '"sessionId":"<id>"'
```

Runtime-log retention is a plan setting; the session's `error_message` has no
retention limit and is the record to fall back on.

### 2.7 Independence after cut-over

This is the one alert that is about absence, so it must be explicit:

- **After the cut-over is marked complete, a Tally bridge or Tally host must not
  appear in logs at all.** Any bridge request from a pharmacy whose cut-over is
  complete is an alert to the release owner.
- A scheduled synthetic check performs one POS read and one sale-shaped
  validation **once the bridge is stopped**, and alerts if either depends on
  Tally. This is the only signal that proves independence rather than assuming it.
- Reconnecting Tally after completion is refused server-side by every upload,
  extract, preview, mapping, delete and apply route (`TALLY_CUTOVER_COMPLETE`).
  Those refusals are **not** written to the audit log today, so this is not yet
  an alertable signal; adding an audit row on each refusal is the follow-up.

---

## 3. Noise control

- Every alert has one owner and one action. No alert is sent to a channel that
  only reads it.
- Thresholds above are starting points; each is tuned after the first quiet
  week, and an alert that fires more than three times without an action is
  deleted or re-thresholded, not muted.
- Maintenance windows suppress availability alerts only; error-spike and
  audit-missing alerts still fire.
- Never include request bodies in an alert. Logs may hold them; notifications do
  not.

---

## 4. What is not monitored, and why

| Gap | Reason | Consequence |
| --- | --- | --- |
| Per-customer behaviour | would require identifying a person | not attempted; analytics is workflow-level only |
| Payment-provider reconciliation | provider not connected in this environment | money settlement is checked manually until it is |
| Production latency | no production traffic exists yet | Speed Insights shows nothing until real users arrive |
| Alert routing | no notification channel is configured in the account | alerts must be created before the first customer goes live |

---

## 5. Enabling it (account steps, in order)

1. Open the project in Vercel → **Analytics** → enable Web Analytics.
2. Project → **Speed Insights** → enable.
3. Project → **Settings → Environment Variables** → add
   `NEXT_PUBLIC_VERCEL_INSIGHTS=1` **for Production only**.
4. Deploy. Confirm `/_vercel/insights/script.js` and
   `/_vercel/speed-insights/script.js` return 200 in production and 404 in a
   preview deployment.
5. Create the alerts in §2 that the plan supports, starting with availability,
   5xx rate, and sale-failure burst.
6. Project → **Firewall** → add a rate-limit rule on
   `/api/admin/pos/complete-sale` and the auth routes (plan permitting).
7. Team → **Usage** → enable spending alerts.

Steps 1–7 require account access that this environment does not have. Until
they are done, the application sends nothing and no alert exists.
