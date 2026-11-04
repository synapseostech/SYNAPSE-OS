# First Windows integration test — procedure

Companion to [TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md),
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md) and
[TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md).

The packaged route — the installer, the Start Menu shortcuts and the portal's six
setup screens — is in
[TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md). This page
is the manual route, kept because it exercises each part by hand and because it
is what the packaged route has to be checked against.

This is the procedure for the **first** run against a real Tally installation on
Windows. It is written from the code in this repository, not from a Windows
session. **Nothing in it has been executed on Windows, and no real Tally export
has been read.** Everywhere the answer depends on Tally's own behaviour it says
so, and the run itself is what produces the evidence.

The bridge is read-only. It reads Tally and writes nothing anywhere except to the
portal you point it at. This procedure stops at **review**; it never presses
Apply, so no ledger entry is created.

---

## 0. Decide which portal you are connecting to, before anything else

The browser page and the bridge must agree on **one exact origin**. Two options:

| Portal | Origin to put in `SYNAPSE_TALLY_ALLOWED_ORIGINS` | What the test writes |
|---|---|---|
| Local dev (`npm run dev` in `apps/pharmacy`, port 3002) | `http://localhost:3002` | a session in your **local** database only |
| The deployed portal | its exact origin, e.g. `https://pharm.synapseos.tech` | a staging session row in **that** database |

An extraction always creates a `pharmacy_import_sessions` row — that is how the
manifest and chunk state survive a reload. It does not post anything to the
ledger; only Apply does. If writing a staging session to the deployed database is
not acceptable for this run, use the local portal, or stop after §5 — the bridge
and the hand-run export in that section write nothing to any database.

Also decide: `http://…` is only accepted for `localhost`, `127.0.0.1` and
`[::1]`. Any other origin must be `https:` and must match exactly — no trailing
slash, no path.

---

## 1. What has to be on the Windows machine

| Thing | Where | Notes |
|---|---|---|
| Node.js **22.x** | nodejs.org LTS | `apps/tally-bridge/package.json` and `apps/pharmacy/package.json` both declare `engines.node: "22.x"` |
| The bridge source | `apps/tally-bridge/src/cli.mjs`, `apps/tally-bridge/src/bridge.mjs` | **no dependencies, no build step, no `npm install`** |
| Tally, installed and running | `C:\Program Files\TallyPrime\tally.exe` (or ERP 9) | detected automatically only from the four default folders; otherwise set `SYNAPSE_TALLY_EXECUTABLE` |
| PowerShell 5.1 or later | built into Windows | |

Verify Node before anything else:

```powershell
node --version
```

Expected: `v22.` followed by a version number. A different major version is not
what the packages declare. (The test suite in this repository was last run on
Node v24.22.2, so the 22.x path is declared but not exercised here.)

### Packaged route — the installer does all of this

```powershell
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -PortalOrigin https://pharm.synapseos.tech -Company "YOUR COMPANY"
```

It finds or installs Node.js 22 (SHA-256 and Authenticode checked against
`nodejs.org`), copies the bridge to
`%LOCALAPPDATA%\Synapse\TallyConnector`, writes an ACL-restricted `config.json`,
creates the Start Menu shortcuts, runs the prerequisite report and prints the
token once. From then on the connector is started, checked and stopped from the
Start Menu instead of §4 and §9 below. See
[TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md).

Either route ends with the same bridge on the same port answering the same
endpoints, so §2 and §5–§8 apply unchanged to both.

### Packaging note — the portal's command uses a relative path

The command the page copies ends with:

```powershell
node apps\tally-bridge\src\cli.mjs
```

That path is **relative**, so the shell must be sitting in the repository root
when it runs. If you copy only `apps\tally-bridge` to the Windows machine (which
is all the code needs), the last line must instead be the absolute path:

```powershell
node C:\wherever-you-put-it\apps\tally-bridge\src\cli.mjs
```

Everything before that line is identical.

---

## 2. Start Tally and turn its HTTP gateway on

1. Sign in to Windows, open Tally, and open **one** company. The bridge cannot
   pick a company, type a password, or open a data folder — it can only read the
   company that is already open.
2. Turn the gateway on: `F1` → **Settings** → **Advanced Configuration**, and
   enable the HTTP/gateway server on port **9000**. On ERP 9 the same setting is
   reached from the F1 configuration menu.
3. Confirm something is listening:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9000 | Select-Object LocalAddress, LocalPort, OwningProcess
```

Expected: one or more rows with `LocalPort 9000`. No rows means the gateway is
off or Tally is not running — the bridge will report `tally: "unreachable"` and
say so rather than guess.

If port 9000 is already held by another program, either free it or point the
bridge elsewhere with `SYNAPSE_TALLY_TARGET_PORT` after changing Tally's setting
to match. The two must be the same number.

---

## 3. Run the read-only probe first (recommended, writes nothing)

`apps/tally-bridge/scripts/tally-probe.ps1` asks Tally the same questions the
importer will, and writes a text report to a folder. It sends nothing off the
machine, changes nothing in Tally, and does not touch the portal or its database.
It is the cheapest way to learn whether this company's books are even shaped the
way the importer expects.

```powershell
cd C:\wherever-you-put-it\apps\tally-bridge\scripts
powershell -ExecutionPolicy Bypass -File .\tally-probe.ps1 -Company "YOUR COMPANY" -From 20261001 -To 20261031
```

`-Company` may be omitted when exactly one company is open — the probe then uses
it — but with several open it asks you to type a number, so naming it is
simpler. `-From` defaults to `19000101` and `-To` to today, which is not what you
want for a first look. `-Port` defaults to `9000`.

Expected: a console report with numbered questions and a verdict, and a folder
`%USERPROFILE%\Desktop\SynapseTallyProbe` holding `tally-probe-report.txt` plus
the raw XML it read. Open it. The three answers that matter for this run are:

- does the response name its company inside `<DATA>` (the bridge refuses a
  payload that names no company at all);
- does it state a period at all, and in which element;
- do the record counts fit inside the importer's ceilings (25 MB, 2,000,000
  tags, 250,000 records).

If the probe verdict is BLOCKED for counts, stop here — a live extraction will
hit the same wall, and the fix belongs in the chunking, not in the test.

---

## 4. Start the bridge

Open a **new** PowerShell window (leave the probe's alone) in the repository
root, and run the block the portal generates. Copy the same token, origin, host,
port and company the page shows — the page builds this from what you typed, so
it is the authoritative copy:

```powershell
cd C:\SynapseOS
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$rng.GetBytes($bytes)
$env:SYNAPSE_TALLY_BRIDGE_TOKEN = -join ($bytes | ForEach-Object { $_.ToString("x2") })
$rng.Dispose()

$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "https://pharm.synapseos.tech"
$env:SYNAPSE_TALLY_TARGET_HOST = "127.0.0.1"
$env:SYNAPSE_TALLY_TARGET_PORT = "9000"
$env:SYNAPSE_TALLY_COMPANY = "YOUR COMPANY"

Write-Host "Copy this token into the portal: $env:SYNAPSE_TALLY_BRIDGE_TOKEN"
node apps\tally-bridge\src\cli.mjs
```

Requirements the bridge enforces at start-up, from `readBridgeConfig` in
`apps/tally-bridge/src/bridge.mjs`:

| Variable | Required | Refused if |
|---|---|---|
| `SYNAPSE_TALLY_BRIDGE_TOKEN` | yes | not exactly 64 hex characters |
| `SYNAPSE_TALLY_ALLOWED_ORIGINS` | yes | empty, or an origin that is not an exact `https:` origin (or `http:` on loopback) |
| `SYNAPSE_TALLY_TARGET_HOST` | no (default `127.0.0.1`) | not loopback and not a private LAN address |
| `SYNAPSE_TALLY_COMPANY` | no at start-up; **required to export** | — an unpinned bridge refuses every export with `TALLY_BRIDGE_COMPANY_UNPINNED` |
| `SYNAPSE_TALLY_EXECUTABLE` | no | — if set, the bridge may launch Tally when port 9000 does not answer |

The block the page copies may also contain `SYNAPSE_TALLY_FROM_DATE` and
`SYNAPSE_TALLY_TO_DATE`, taken from the date fields. They are only fallbacks for
a request that states no dates, and the portal always states its own, so leave
them in and do not read them as the period being exported.

Expected console output, exactly four lines:

```
Synapse Tally Bridge listening at http://127.0.0.1:17890
Tally XML target: http://127.0.0.1:9000
Allowed portal origins: https://pharm.synapseos.tech
Exports are read-only and remain staged until a pharmacy administrator applies them.
```

A stack trace instead of those four lines means start-up configuration was
rejected; the exception message names the variable and the rule it broke. Fix it
and run the block again — there is no restart command.

The bridge listens on `127.0.0.1:17890` only. Nothing outside this computer can
reach it, and Windows Firewall needs no new inbound rule.

---

## 5. Verify connectivity without the browser

The bridge rejects any request whose `Origin` header is missing or is not one of
the allowed origins — **before** it looks at the token. So a plain `curl` gets
403 here; send the header yourself.

```powershell
$headers = @{
  Origin = $env:SYNAPSE_TALLY_ALLOWED_ORIGINS
  "x-synapse-tally-bridge-token" = $env:SYNAPSE_TALLY_BRIDGE_TOKEN
}
Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/status" -Headers $headers | ConvertTo-Json
```

Expected (`edition` comes from `SYNAPSE_TALLY_EXECUTABLE` if set, otherwise from
the first Tally found in a default folder, otherwise `"unknown"`; `to` is today):

```json
{
  "bridge": "ok",
  "tally": "reachable",
  "target": "http://127.0.0.1:9000",
  "edition": "prime",
  "installations": ["prime"],
  "period": { "from": "19000101", "to": "20261101" },
  "company": "YOUR COMPANY"
}
```

What each failure means:

| Result | Meaning |
|---|---|
| 403 `Origin is not allowed.` | the `Origin` header is missing or does not match `SYNAPSE_TALLY_ALLOWED_ORIGINS` exactly |
| 401 `Invalid bridge token.` | the token in the header is not the one the bridge started with |
| `"tally": "unreachable"` | the bridge is fine; nothing accepted a TCP connection on `127.0.0.1:9000` |
| connection refused | the bridge is not running |

Then list the companies Tally actually has open:

```powershell
Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/companies" -Headers $headers | ConvertTo-Json
```

Expected:

```json
{ "companies": ["YOUR COMPANY"], "edition": "prime" }
```

This is discovery only — it reads no balances and no vouchers.

### The prerequisite report — what the setup screens see

```powershell
$report = Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/preflight" -Headers $headers
$report.summary | ConvertTo-Json
$report.checks | Select-Object id, status, required, message | Format-Table -AutoSize
```

Expected on a prepared computer: every check `passed`, `summary.ready` `true`,
`summary.blocking` empty, and `connector.contractVersion` `2`. This is the same
call the portal's **Check My Computer** makes; running it here separates a
connector problem from a page problem.

What the report may contain: check ids, measured values (Windows build, Node
version, port state, company count), and error codes. What it must not contain —
and what to stop the run over if you see: the bridge token, a Tally payload, a
ledger or voucher value, or a company's financial data. `bridge_token` reports
only `tokenConfigured: true`.

A `404` here means the running connector predates this endpoint — an older
`cli.mjs` is still on the port. Stop it and start the one from this tree.

### One guarded export, by hand, before using the page

This is the single most informative step of the whole run: it proves whether
Tally answers a dated voucher request at all, and what it says about the range.
It writes nothing.

```powershell
$q = "mode=opening&scope=vouchers&from=20261001&to=20261031"
$r = Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:17890/api/tally/export?$q" -Headers $headers
$r.StatusCode
$r.Headers["x-synapse-tally-from"]
$r.Headers["x-synapse-tally-to"]
$r.Headers["x-synapse-tally-company"]
$r.Headers["x-synapse-tally-mode"]
$r.Headers["x-synapse-tally-scope"]
$r.RawContentLength
```

Expected: `200`, then `20261001`, `20261031`, your company name, `opening`,
`vouchers`, and a byte count.

The five `x-synapse-tally-*` values are the echo the portal checks. They state
what the bridge **sent**, not what Tally returned — a `200` with matching echoes
means "Tally accepted the request", not "Tally returned the right period". Keep
that distinction; it is the whole reason the evidence panel says *unverified*.

Now look at what Tally actually put in the answer:

```powershell
$r.Content | Select-String -Pattern '<COMPANYNAME>|<COMPANY |SVFROMDATE|SVTODATE' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Select-Object -Unique
```

This is Windows question 2 and 3 from
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md): does the company sit
inside `<DATA>`, and does Tally echo a period anywhere? Whatever this prints is
the answer to record. If nothing matches `<COMPANYNAME>` or `<COMPANY `, the
bridge will refuse the payload (`TALLY_BRIDGE_COMPANY_UNVERIFIED`) — by design,
because an unidentifiable payload cannot be told apart from another company's
books.

Error codes from this call, and what they mean:

| Code | HTTP | Cause |
|---|---|---|
| `TALLY_BRIDGE_PERIOD_INCOMPLETE` | 400 | only one of `from` / `to` was supplied |
| `TALLY_BRIDGE_PERIOD_INVALID` | 400 | the range is reversed |
| `TALLY_BRIDGE_FROM_DATE_INVALID` / `_TO_DATE_INVALID` | 422 | a date is not `YYYY-MM-DD` or `YYYYMMDD` |
| `TALLY_BRIDGE_SCOPE_INVALID` | 422 | `scope` is not `all`, `masters` or `vouchers` |
| `TALLY_BRIDGE_SCOPE_CONFLICT` | 422 | `mode=closing` together with `scope=vouchers` |
| `TALLY_BRIDGE_COMPANY_UNPINNED` | 422 | `company` was named while nothing is pinned |
| `TALLY_BRIDGE_COMPANY_MISMATCH` | 422 | `company` disagrees with the pin |
| `TALLY_BRIDGE_COMPANY_UNVERIFIED` | 422 | the reply names no company at all |
| `TALLY_BRIDGE_NO_IMPORTABLE_RECORDS` | 422 | the reply parsed but carried no records |
| `TALLY_BRIDGE_EXPORT_TOO_LARGE` | 413 | the packaged export passed 25 MB |
| `TALLY_BRIDGE_TALLY_UNAVAILABLE` | 502 | nothing answered on port 9000 |
| `TALLY_BRIDGE_TALLY_TIMEOUT` | 502 | Tally accepted the connection but did not answer within 60 s |
| `TALLY_BRIDGE_TALLY_HTTP_<status>` | 502, or 503 | Tally itself answered with an error |
| `A Tally export is already running.` | 409 | a second export arrived while one was in flight |

---

## 6. How the portal finds and connects to the bridge

There is no discovery mechanism — no mDNS, no port scan, no service registry. The
page is told where to look, and looks at exactly two URLs. This is the whole
sequence, from `apps/pharmacy/app/portal/tally-import/page.tsx`:

1. **The page loads** and records its own origin (`window.location.origin`). That
   value — not a config file — is what must appear in
   `SYNAPSE_TALLY_ALLOWED_ORIGINS`. This is why a bridge started for
   `https://pharm.synapseos.tech` cannot be driven from `http://localhost:3002`.
2. **You enter** the Tally host, port, an optional executable path, the company,
   and the period. **Copy command** runs `buildBridgeCommand`
   (`apps/pharmacy/lib/tally/bridge-command.ts`) over those values and gives you
   the PowerShell in §4. The page sanitises each value before quoting it: a
   company name or path containing `"`, `$` or a backtick is dropped rather than
   repaired.
3. **Check bridge** sends
   `GET http://127.0.0.1:17890/api/tally/status` with
   `x-synapse-tally-bridge-token`. The browser attaches the page's `Origin`, and
   for a public page reaching a loopback address it may also send an
   `Access-Control-Request-Private-Network` preflight — the bridge answers it
   only for an allowed origin.
4. **The bridge checks the origin first, then the token**, then opens a one-second
   TCP connection to the Tally host and port. It reads nothing from Tally here and
   returns no company data.
5. **On success the page then calls**
   `GET http://127.0.0.1:17890/api/tally/companies`, fills the company list, and
   selects the first entry unless you already chose one. The company it shows is
   then pinned into the command above with `SYNAPSE_TALLY_COMPANY`.
6. **Connect and review** branches on the mode:
   - **Closing balances only** — one export with `scope=masters`, posted to the
     portal through the normal signed upload URL, then previewed.
   - **Opening balances and history** — a live extraction, §7.

The page cannot distinguish "bridge stopped" from "bridge rejected this origin":
both are an opaque cross-origin failure with no body. That ambiguity is not a
bug in the page — the browser will not let it read the response. If **Check
bridge** fails while the four startup lines are on screen, the origin is the
first thing to compare, character for character.

---

## 7. The first extraction — one company, one month

Use the smallest thing that proves the path: **one company**, **one calendar
month**, opening mode. A range of 31 days splits into one voucher chunk, so the
whole run is exactly two Tally reads — one `masters`, then one dated voucher
export — behind the six collection requests that make up the masters document.

1. On the page, choose **Opening balances and history**.
2. Set the period to `2026-10-01` – `2026-10-31` (or any month you can verify
   against Tally's own Day Book report for that month).
3. Pick the company. Press **Check bridge** — it must report ready and list the
   company.
4. Run the command from **Copy command** (re-run it if you changed the company:
   the pin is read at start-up only).
5. Press **Connect and review**.

What happens, exactly, from
`apps/pharmacy/lib/tally/live-extraction.ts` and
`apps/pharmacy/app/api/admin/tally/[id]/extract/route.ts`:

| Step | Call | What it does |
|---|---|---|
| 1 | `POST /api/admin/tally/upload-url` `{"source":"bridge"}` | creates the session, returns `{"sessionId":"…"}` — no file, no upload path of its own |
| 2 | `POST /api/admin/tally/<id>/extract` `{action:"begin", company, period}` | builds the chunk manifest and returns it; the session moves to `mapping` |
| 3 | `POST …/extract` `{action:"target", chunkId:"masters"}` | signed PUT URL for that chunk |
| 4 | `POST http://127.0.0.1:17890/api/tally/export?mode=opening&scope=masters` | Tally's masters |
| 5 | `PUT <signed url>` with the XML | the chunk reaches storage |
| 6 | `POST …/extract` `{action:"chunk", chunkId, path}` | the **server** parses it and records the result |
| 7–9 | steps 3–6 again for `vouchers:2026-10-01:2026-10-31` | Tally's voucher register for that month |
| 10 | `POST …/extract` `{action:"finish"}` | merges the chunks, stages the plan, session moves to `review` |

A range Tally returns as too large is halved and read again; a failed range is
retried up to three times
(`EXTRACTION_MAX_ATTEMPTS`). A chunk the server could not parse blocks the merge
instead of being skipped.

The same endpoint carries the rest of the loop, if you want to follow it in the
network tab: `{action:"status"}` returns the saved manifest, `{action:"start",
chunkId, attempt}` marks a chunk in flight, `{action:"fail", chunkId, error}`
records an attempt, `{action:"split", chunkId, ranges}` replaces an oversized
chunk with smaller ones, and `{action:"chunk", chunkId, path}` is the only one
that reads and parses the XML — it is the server's answer, never the page's,
that decides whether a chunk is complete.

**Expected on success:** the card reads
`Extraction — 2 of 2 ranges read`, with **Ranges read** `2 / 2`, **Ranges
failed** `0`, and a non-zero **Records read**. Then the review appears with the
chart of accounts, stock items, parties and vouchers, and an amber evidence panel
saying coverage is **unverified** — that is correct and expected, because no
independent count of Tally's own totals was supplied. Apply will stay disabled
until that panel is acknowledged, and this procedure does not ask you to
acknowledge or apply it.

---

## 8. Reading the session, the chunks and the reconciliation

### On the page

- **Extraction — N of M ranges read**: per-range progress, the dates actually
  covered, any gap between complete ranges, and every failed range with its error
  and attempt count. **Retry unfinished ranges** resumes from the manifest the
  server saved, so ranges already read are not read again.
- **Records read** vs the consolidation block: `read` counts what the parser
  produced across all parts, `unique` counts what survived de-duplication. The
  masters chunk and a voucher range can deliver the same voucher twice; that is
  why `read` may exceed `unique` without anything being wrong.
- **Voucher types**, **unsupported types** (with counts and a reason), and
  **totals per type** — the last is for comparing against Tally's own report.

### Over the API

`GET /api/admin/tally/<sessionId>` returns everything needed to resume or audit
(`apps/pharmacy/app/api/admin/tally/[id]/route.ts`). The three fields that matter
here:

**`extraction`** — the same summary the page shows:

```
totalChunks, complete, failed, pending, attempts,
recordsRead, recordsExtracted,
coveredFrom, coveredTo,          // dates covered by COMPLETE chunks only
gaps: [{ after, before }],       // gaps between complete voucher ranges
failures: [{ id, error, attempts }],
completeAll
```

`coveredFrom`/`coveredTo` are the **ranges** of the voucher chunks that finished,
not the dates of the vouchers inside them, and not the period you typed. If they
are narrower than `2026-10-01`–`2026-10-31`, some range at an end never
completed — and note that `gaps` only lists holes *between* two complete ranges,
so a missing first or last range shows up as the narrower span, not as a gap.
`failures` is where the missing range and its error are named.

**`consolidation`** — the merge report:

```
company, parts
masters:   { groups, ledgers, stockGroups, stockItems, units, godowns,
             total, duplicates, conflicts }
vouchers:  { read, unique, duplicates, cancelled, undated, keyless,
             types: [...], unsupported: [...] }
dates:     { first, last, gaps: [{ from, to }] }
totals:    [{ type, amount }]
reconciliation: "verified" | "unverified" | "mismatch"
problems:  [...]
```

`duplicates` and `conflicts` in masters are different things: a duplicate is the
same record delivered twice; a conflict is the same identifier delivered twice
with **different content**. The first copy is kept, and every conflict is raised
in `problems` as `TALLY_CONSOLIDATION_CONFLICT`, because two different ledgers
sharing a name is a question about the source, not a merge detail.

**`manifest`** — the coverage evidence: `period`, `periodSource`
(`"source"` if the file stated it, `"requested"` if it fell back to your dates),
`declaredPeriod`, `coverage`, `problems`, `evidence`, `manifestUpdatedAt`.
`manifest.evidence` is the block described in
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md) — period requested,
period stated, first and last voucher date actually read, records read and
staged, whether an independent count was supplied.

Also returned: `unverifiedAcknowledged`, `failures` (capped at 200) and
`failureCount`.

### Comparing against Tally

The numbers worth checking by hand on this first run, because they are the ones
the code cannot check for you:

1. **Voucher count for the month.** `consolidation.vouchers.unique` against the
   number of vouchers Tally's own Day Book shows for `2026-10-01`–`2026-10-31`.
2. **Per-type totals.** `consolidation.totals` against Tally's Day Book
   summary.
3. **Dates.** `consolidation.dates.first` / `last` should sit inside the month.
   A voucher dated outside it is not dropped — the chunk fails
   `TALLY_CHUNK_DATES_OUTSIDE` and the plan blocks. If you see that, Tally
   answered with a wider range than it was asked for, which is Windows question 4
   in the period document.

Write the three answers down. They are the evidence this run exists to produce.

---

## 9. Stopping the bridge, and what to collect if it fails

### Stopping

`Ctrl+C` in the bridge's PowerShell window. The process handles `SIGINT` and
`SIGTERM` by closing the server and exiting, so an export already in flight is
allowed to finish rather than being cut mid-write. There is no other state to
clean up in the bridge: it holds no files, no database and no queue.

If the window is unresponsive:

```powershell
Get-Process node | Select-Object Id, StartTime, Path
Stop-Process -Id 12345   # the Id from the row above
```

Prefer `Ctrl+C`. If the window is closed instead, Windows may end the process
without that clean shutdown, which loses the export in flight — the portal's
manifest still lists that chunk as pending either way, and **Retry unfinished
ranges** reads it again.

Nothing needs stopping in Tally. Closing Tally, or turning its gateway off, makes
the bridge report `tally: "unreachable"` and nothing more.

### What to collect after a failed run

Collect these before closing anything:

1. **The bridge console transcript.** Start the window with
   `Start-Transcript -Path "$env:USERPROFILE\Desktop\synapse-bridge.txt"` and end
   it with `Stop-Transcript`. The four startup lines and every error the bridge
   printed land there.
2. **The token in that transcript.** The startup block prints the token so you
   can paste it into the portal, so the transcript contains it. Treat the file as
   a secret: redact the line beginning `Copy this token into the portal:` before
   sending it anywhere.
3. **The status and companies output** from §5, verbatim — including the exact
   text of any error body.
4. **The probe report** `%USERPROFILE%\Desktop\SynapseTallyProbe\` — the whole
   folder, including the XML.
5. **The session JSON** from `GET /api/admin/tally/<sessionId>`. Its
   `extraction.failures` is the authoritative list of what failed and why, and
   `manifest.problems` explains a blocked merge. The browser page shows the same
   list, but the JSON keeps the codes verbatim.
6. **The page's own message.** When **Check bridge** fails, the toast text names
   which layer failed (bridge, token, Tally unreachable, origin). That sentence
   is the fastest way to tell the first three apart.
7. **Whether port 9000 stayed open** through the run:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9000
```

A Tally that drops its gateway mid-run is a different fault from a Tally that
never had it on, and only this distinguishes them after the fact.

Do not collect company data, customer names, or the token, unless whoever is
diagnosing it has agreed to hold them.

---

## 10. What a successful run proves — and what it does not

A run that completes §7 proves:

- the bridge starts on Windows under Node 22 with the declared configuration;
- the browser can reach it on loopback, through the private-network preflight,
  with the origin and token gates satisfied;
- Tally accepts the master collections and a dated voucher request, and answers
  in XML the bridge can parse;
- the server parses every chunk, records it against the range it was asked for,
  and merges them into a staged plan;
- the portal's copy-command → check → connect → review path works end to end;
- if the packaged route was used: the installer, the shortcuts and the six setup
  screens against a real Windows machine and a real Tally (see the checklist at
  the end of [TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md)).

It does **not** prove, and must not be reported as proving:

- that `SVFROMDATE` / `SVTODATE` actually constrain both reports, or which bound
  each one respects;
- that Tally's answer contains every voucher in the range and none outside it;
- that Tally states the company or the period in any particular element across
  releases — only whether it did on this build, on this day;
- that a second run on a different Tally build would behave the same way;
- that coverage is complete. A completed extraction with no independent count is
  `unverified`, by design, and stays that way until an operator acknowledges it;
- anything about the setup assistant's own behaviour until it has been clicked
  through on Windows: the six screens, the installer, the three Start Menu
  shortcuts and UAC elevation have been reviewed from the code and covered by
  static tests only (see §11 of
  [TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md)).

Record which Tally edition and version was used. The edition string the bridge
reports (`prime` / `erp9` / `unknown`) comes from the executable's path, not from
Tally itself, so note the version from `Help → About` too.

---

## Appendix — what the suite already proves about the request protocol

The dynamic company and date-range protocol is covered by tests that run without
Tally. They prove the contract on both sides of the wire; they cannot prove that
Tally honours it. Run them with:

```bash
cd apps/pharmacy && ../../node_modules/.bin/vitest run lib/tally/bridge-client.test.ts lib/tally/live-extraction.test.ts "app/api/admin/tally/[id]/extract/route.test.ts"
```

```bash
cd apps/tally-bridge && node --test src/bridge.test.mjs
```

The setup screens add two more suites: the portal's reading of the report, and a
contract test that runs the bridge's real prerequisite engine and parses its
output with the portal's reader.

```bash
cd apps/pharmacy && ../../node_modules/.bin/vitest run lib/tally/bridge-preflight.test.ts lib/tally/bridge-preflight.integration.test.ts
```

```bash
cd apps/tally-bridge && node --test src/preflight.test.mjs src/installer.test.mjs
```

Last recorded result in this repository: **37 passed** across the three portal
Tally files — 13 in `bridge-client.test.ts`, 7 in `live-extraction.test.ts`, 17
in the extract route — and **108 passed, 1 skipped, 0 failed** out of 109 in the
bridge suite (the skip is "starts a configured local executable with the Windows
process launcher", which cannot run off Windows). The preflight pair adds 18
portal tests, and the prerequisite and installer suites add 20 + 25. The
installer tests read the shipped PowerShell and assert what it must not contain;
they are not a Windows run.

What each block establishes:

**The bridge honours a per-request period and says so** — `bridge.test.mjs`,
"local HTTP bridge": *sends the period each request states and echoes it back*,
*uses the request's start date even when the process was launched with another*,
*uses the request's end date even when the process was launched with another*,
*refuses half a period instead of filling the missing bound in*, *refuses an
impossible or reversed period before asking Tally*, *keeps the company pinned
when a request names it*, *reads masters once and one voucher range per request
when asked*, *refuses a scope the bridge cannot serve*, *carries an empty voucher
range as an empty document, not a failed export*, *reads only the masters when
the page asks for closing balances*.

**The bridge's gates are ordered and specific** — same file: *only serves the
exact portal origin and a valid token*, *guards the status probe with the same
origin and token as the export*, *lists the open Tally companies and refuses
without the token*, *answers the browser private-network preflight only for an
allowed origin*, *rejects request bodies rather than exposing a general-purpose
local proxy*, *reports reachability without running an export*.

**The portal refuses anything it did not ask for** —
`apps/pharmacy/lib/tally/bridge-client.test.ts`: *sends the requested period and
accepts an exact echo*, *refuses an export whose start date differs from the
request*, *…whose end date differs*, *refuses an export that states no period at
all*, *never exports when the operator has not stated a period*, *does not accept
an old bridge's launch period after the page's dates change*, *accepts a
restarted bridge that honours the page's new dates*, *refuses another company or
mode even when the period matches*, *refuses a payload that is not the part of
the books it asked for*, *refuses a bridge that does not state the scope*, *asks a
closing cut-over for masters only*.

**The loop that drives it is wired correctly** —
`apps/pharmacy/lib/tally/live-extraction.test.ts`: *asks for masters once, and for
the exact voucher range each time*, *refuses an export whose echo does not match
the range that was asked for*, *uploads a chunk to its signed target and then
records its path*, *never records a chunk whose upload failed*, *sends the
manifest actions the server expects*, *creates a session with no file, and states
the company and period it will read*, *reports why the server refused to stage an
incomplete extraction*.

**The server is the authority on what was read** —
`apps/pharmacy/app/api/admin/tally/[id]/extract/route.test.ts`: *builds a manifest
of masters plus one range per month from the requested period*, *splits a
multi-year session into the parts asked for and refuses more than the cap*,
*resumes the saved extraction instead of rebuilding it*, *refuses to resume an
extraction for a different company or period*, *records a chunk the server could
read as complete, once*, *fails a chunk whose vouchers fall outside the range that
was asked for*, *fails a chunk that names a different company*, *refuses to finish
while any chunk is unread*, *consolidates the chunks, stages the plan and leaves
the migration unverified*.

Read together, they mean: if the Windows run misbehaves, the fault is most likely
in what Tally actually returned, not in whether the bridge and the portal agree
about the request — that part is pinned by these tests.
