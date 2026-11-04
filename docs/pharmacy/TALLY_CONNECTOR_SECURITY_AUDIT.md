# Tally Connector — security audit and hardening

Date: 2026-11-01  
Repository: `/home/ebrine/Desktop/SYNAPSE-OS`  
Branch: `feat/tally-bridge-command` (HEAD `85b6732f`, working tree uncommitted)  
Companion documents: [TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md),
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md),
[TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md)

## Evidence key

Every claim below carries one of these markers:

| Marker | Meaning |
|---|---|
| **Executed** | A command was run in this working tree and its output is the evidence. |
| **Automated test** | A test in the repository asserts it and passed in this session. |
| **Static** | The relevant code was read. This proves what the code contains, not what a platform does with it. |
| **Inferred** | Reasoning from platform documentation or from code that could not be run here. |
| **Not verified** | Could not be established in this environment. |

**Nothing in this audit was executed on Windows.** No PowerShell, `msiexec`,
UAC prompt, Tally process or Tally XML gateway was run. No database was
contacted and no migration was applied. Where the audit says a Windows control
is present, it means the shipped script contains that control — not that
Windows honoured it.

---

## 1. Scope, method and authority

**Scope.** The connector shipped in `apps/tally-bridge` (installer, launcher,
Node bridge, prerequisite checks), the portal page and server routes that talk
to it, and the database objects the cut-over depends on.

**Method.** The audit read the actual request builders, the HTTP gate, the
route handlers, the storage helpers and the installer script; it then wrote
runtime tests against a listening bridge and static tests against the shipped
PowerShell. It did not start from documentation, and it did not treat a comment
or a test name as evidence.

**Authority.** Work was local only. Nothing was committed, pushed, merged,
deployed, migrated, or connected to a customer Tally installation. All existing
uncommitted work in the tree was preserved.

**Constraint that shapes every conclusion.** The bridge holds a bearer token
and talks to a service (`Tally`'s XML gateway) that has its own authentication
surface. It is a local integration component, not a public service. Controls
are judged against that boundary.

---

## 2. Repository state and preserved work

**Executed.** `git status --short` and `git diff --check` were run at the start
and end of the audit.

- Branch `feat/tally-bridge-command`, HEAD `85b6732f`, itself a merge of
  `origin/main`. The tree already held substantial uncommitted connector work
  when the audit began; none of it was discarded, stashed or reverted.
- `git diff --check` exits `0`: no whitespace errors were introduced.
- No `reset`, `clean`, `checkout --`, `stash` or history rewrite was run.
- Untracked files belonging to the branch's own work (for example
  `apps/.mcp.json`, `apps/tally-bridge/.mcp.json`, new docs) were left exactly
  as found.

Files changed **by this audit** are listed in §18.3. Everything else in the
tree is pre-existing work.

---

## 3. Trust model and attacker positions

The connector is judged against four attackers:

| Attacker | Capability assumed |
|---|---|
| A web page the operator visits | Can make requests from a browser on that computer; can set `Origin` only to its own origin. Cannot read the token. |
| Another local process running as the same user | Can read `%LOCALAPPDATA%` if the ACL allows it, can call loopback services. |
| A network attacker on the pharmacy LAN | Can reach any port Tally itself exposes to the LAN; cannot reach the bridge, which binds loopback only. |
| A hostile mirror or proxy during installation | Can alter any download the installer makes, unless a signature anchors it. |

The bridge is **not** designed to defend against an attacker who already runs
code as the installing user. That attacker can read `config.json` (its own
user's file), start their own bridge, or call Tally directly. This limitation
is stated, not removed.

---

## 4. Installer download and supply chain

**Static.** `scripts/synapse-tally-connector.ps1` fetches three things:
`https://nodejs.org/dist/index.json`, the version's `SHASUMS256.txt`, and the
`win-x64-msi` or `win-arm64-msi` package.

Hardening applied by this audit:

- `Assert-OfficialUrl` now requires **scheme `https`, host exactly `nodejs.org`,
  the default port, and no user-info**. Before, a URL such as
  `https://nodejs.org.evil.example/...` or `https://nodejs.org:8443/...` would
  have passed a looser check. The guard runs before each fetch.
- All three downloads now use `-MaximumRedirection 0`. A redirect is refused
  rather than followed, because the checksum list and the MSI come from the
  **same** origin: allowing a redirect would let one proxy move either file and
  leave only Authenticode between it and the installer.

**Automated test.** `installer.test.mjs` asserts the three guarded URLs, the
exact `nodejs.org` root, and `-MaximumRedirection 0` on every download line.

**Residual risk — R2 (Medium, accepted).** The SHA-256 list is fetched from the
same origin as the file it verifies, so it is not an independent checksum
source. Authenticode is the only independent anchor. This is why the signer
check in §5 had to be exact.

**Residual risk — R1 (Medium, not fixed).** The `.ps1` itself is not signed.
`-ExecutionPolicy Bypass` is still the documented invocation. Distribution to
customers should ship a signed script (or a signed wrapper) and a published
checksum. Fixing that is an organisation certificate and release-pipeline task,
not a local code change.

---

## 5. Installer signature, signer identity and redirects

**Static.** The MSI is checked with `Get-AuthenticodeSignature`, required to be
`Valid`, and its signer subject is parsed by `Test-NodeSignerSubject`, which
splits the subject on commas and requires the `O=` field to be exactly
`OpenJS Foundation` or `Node.js Foundation`.

**Why this changed.** The earlier check used
`$subject -notmatch "OpenJS Foundation"`. A substring match would accept a
certificate whose subject merely contains that text anywhere, including in
another field. The field-exact compare closes that.

**Static + automated test.** `Install-NodePackage` — the **elevated** half,
which the public `-InstallNodeOnly` switch can reach directly — now re-runs the
hash check **and** `Assert-NodeInstallerSignature` before `msiexec`. Tests
assert the ordering (`Install-NodePackage` → `Get-FileHash` →
`Assert-NodeInstallerSignature` → `msiexec`) and that a failed check deletes the
MSI and installs nothing.

**Inferred.** Authenticode verification depends on the Windows certificate
chain and revocation settings of the customer computer. An offline machine may
report a different status. This is not verifiable here and is a Windows-test
item.

---

## 6. Installer argument handling and PowerShell injection

**Static.** The installer takes `-PortalOrigin`, `-Company`, `-TallyHost`,
`-TallyPort`, `-TallyExecutable`, `-InstallRoot` as **values**. None is
concatenated into a command line: they are written into `config.json` with
`ConvertTo-Json` and, for the verification step, into `Environment` variables
passed to a Node process with `& $NodeExe $check`. `Start-Process` is called
with a fixed `msiexec.exe` and an argument array.

**Portal side — the real injection path.** The setup assistant builds two
PowerShell commands containing a company name that came from **Tally**, not from
the page. Before this audit both were double-quoted interpolations, where `$`,
`` ` `` and `'` are active.

Fixed in `apps/pharmacy/lib/tally/bridge-command.ts`:

- both commands are built by exported functions rather than by string
  interpolation in the component;
- the company is emitted as a PowerShell **single-quoted literal**, with every
  apostrophe doubled (`'` → `''`). Nothing expands inside single quotes;
- a name containing a control character, or longer than 200 characters, is
  dropped rather than repaired — a repaired name would pin a different company
  from the one Tally displayed;
- the origin is narrowed to `https://host[:port]` or `http://localhost|127.0.0.1[:port]`;
  anything else falls back to the literal placeholder
  `-PortalOrigin <this page's origin>`.

**Automated test.** `bridge-command.test.ts` (19 tests) asserts exact output,
apostrophe doubling, that `$(…)`, backticks, `;`, `&` and `"` remain inert
inside the literal, that control characters and over-long names remove
`-Company`, and that a hostile origin never reaches the command.

**Not verified.** That PowerShell 5.1/7 parses the emitted strings as intended
on Windows. The quoting rule is a documented language guarantee (**Inferred**);
the strings themselves are tested (**Automated test**).

---

## 7. Elevation, temporary files and partial installs

**Static.** Elevation happens in one place: when Node.js must be installed and
the current shell is not elevated, the script relaunches **itself** with
`Start-Process -Verb RunAs` and the internal `-InstallNodeOnly` switch. The
elevated process performs only: hash re-check, signature re-check, `msiexec`.
Copying files, writing config and creating shortcuts stay in the unelevated
process.

**Fixed — the elevated trust gap.** Before this audit, `-InstallNodeOnly`
verified only the SHA-256 that the caller supplied. Any user able to approve a
UAC prompt could name an arbitrary MSI and the hash of it. The elevated half
now independently verifies the signature and signer as well; a checksum proves
"the file the caller named", not "a Node.js installer".

**Static.** The MSI is downloaded into a per-run GUID folder under `%TEMP%`,
and the whole folder is removed in a `finally` block. A failed verification
deletes the file before throwing.

**Executed.** Nothing here ran. `msiexec`, UAC and rollback are **Not
verified** and remain the first Windows-test item.

---

## 8. Configuration, token at rest and ACLs

**Static + automated test.** `Write-Config` now writes `config.json.new`,
restricts it, and only then renames it into place in the same directory. If the
restriction or the move fails, the temporary file is deleted and the installer
stops. The previous order wrote the live file first and restricted it after,
which could leave a readable token for the interval (or for good, if the script
was interrupted).

`Protect-ConfigFile` now checks `$LASTEXITCODE` from `icacls` and throws when
the restriction was not applied. It grants only the installing account
`(R,W)` and `SYSTEM:(F)` and removes inheritance.

The token is 64 hexadecimal characters generated by
`[System.Security.Cryptography.RandomNumberGenerator]` — 256 bits, matching what
the bridge requires. It is printed once to the console and never passed to
`Add-Log`.

**Automated test.** `installer.test.mjs` asserts the ACL line, the fail-closed
`$LASTEXITCODE` check, and that the temporary file is restricted **before**
`Move-Item`. It also scans every non-trivial log call for the token.

**Not verified.** `icacls` behaviour with a domain account name containing
spaces, and whether the generated account string is well formed on a
workgroup machine. Windows-test item.

---

## 9. Uninstall, rollback and failed-install recovery

**Static + automated test.** `Uninstall-Connector` previously removed
`-InstallRoot` recursively with no check on what that path was. `-InstallRoot`
is a parameter, so a mistyped or hostile value could delete a drive root or a
profile folder.

`Test-ConnectorInstallRoot` now refuses:

- a drive root (`^[A-Za-z]:$`);
- `%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`, `%TEMP%`, `%PUBLIC%`,
  `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%SystemRoot%` (compared as full,
  normalised paths);
- any folder that does not contain both `src\cli.mjs` and `package.json`.

When refused, the script warns and leaves the folder alone. Uninstall still
leaves Node.js installed and says so.

**Recovery.** A partial install is recoverable by re-running the installer:
`config.json` is kept unless `-Force` is given, so a repair does not invalidate
the token the portal already holds. **Static.**

**Not verified.** Any of the above on Windows.

---

## 10. Bridge binding and network exposure

**Static.** `TALLY_BRIDGE_BIND_HOST` is a module constant `"127.0.0.1"`
(`src/bridge.mjs:18`). `readBridgeConfig` returns it as `bridgeBindHost`
without consulting the environment, and `src/cli.mjs` calls
`server.listen(config.bridgePort, config.bridgeBindHost, …)`.

**Automated test.** `bridge.test.mjs` passes `SYNAPSE_TALLY_BRIDGE_HOST` and
`SYNAPSE_TALLY_BIND_HOST` set to `0.0.0.0` and asserts the resolved host is
still `127.0.0.1`; it asserts the CLI listens with `config.bridgeBindHost`; it
asserts the CLI contains no `0.0.0.0`; and it asserts the started test server's
URL is a `127.0.0.1` URL.

**Executed.** The test server binds an ephemeral loopback port for every test
in `bridge.test.mjs` — the binding behaviour is exercised, though on Linux.

**Residual risk — R7 (Medium, operational).** The bridge may be pointed at a
Tally gateway on a private LAN address (`SYNAPSE_TALLY_TARGET_HOST` accepts
RFC1918 addresses by design). If Tally's HTTP/XML gateway is itself exposed to
the LAN, any LAN host can read and modify Tally **without touching the
connector**. The connector cannot fix Tally's own binding. The Windows test must
record what `netstat`/`Get-NetTCPConnection` shows for port 9000.

---

## 11. Origin, CORS and private-network access

**Static.** The gate in `createTallyBridgeServer` (`src/bridge.mjs:646-687`)
runs in this order:

1. `Origin` missing, or not exactly in the allowlist → `403`, **without** any
   CORS headers.
2. CORS headers are added, always with `vary: Origin`.
3. `access-control-allow-private-network: true` is echoed **only** when the
   preflight asked for it.
4. `OPTIONS` → `204`.
5. Path routing → `404`.
6. Token check → `401`.
7. Handler.

**Automated test (10 rejected origins × 3 endpoints, plus preflight).** The
following are refused with `403` and no `access-control-allow-origin`, even
when a valid token is sent:

`Origin` absent, `null`, right host on another port, right host with an
attacker suffix (`pharm.synapseos.tech.evil.example`), the right host as a path
on another domain, `http:` instead of `https:`, trailing slash, different
casing, a malformed value, and `file:`.

Tests also assert:

- `Referer`, a query parameter, and a spoofed `Host` do not substitute for
  `Origin`;
- `OPTIONS` from an untrusted origin gets `403` and no CORS or private-network
  grants;
- private-network access is granted only when
  `access-control-request-private-network: true` is present (not `false`, not
  absent);
- an allowed response carries `vary: Origin` and `cache-control: no-store`;
- the origin gate runs **before** the token, so a valid token cannot rescue a
  bad origin, and a rejected request never reaches Tally.

**Inferred.** DNS rebinding is defeated by the same gate: a rebinding page sends
its own domain as `Origin`, which is not in the allowlist. The absolute
requirement for an exact `Origin` (rather than a `Host` check) is what makes
this hold.

**Not verified.** Browser behaviour with a real Chromium private-network
preflight. The header contract is tested at the HTTP level only.

---

## 12. Bearer token design and lifecycle

**Static.** `readBridgeConfig` requires `^[\da-f]{64}$` (case-insensitive) and
throws otherwise, so the bridge cannot start with a weak or missing token.
`tokenMatches` compares with `timingSafeEqual` after a length check. The token
is read only from `x-synapse-tally-bridge-token`; there is no query-string or
cookie fallback.

**Automated test.** Every endpoint returns `401` for: no token, one character
short, one character long, an empty token, a different 64-hex token, a token in
the query string, and two conflicting duplicate header lines. None of those
requests reaches Tally.

**Assessment against the stated limitation.** The token is a **capability for a
loopback service**, not an identity. Any process that can read it can use it;
the ACL in §8 is the only thing that stops a different user's process on the
same machine. It is not a substitute for the portal login, and the design does
not pretend otherwise.

The design is already the simplest secure one for its shape:

- 256-bit random, generated on the machine, never transmitted off the machine
  except to the loopback port;
- carried in a custom header, so it is not logged in URLs or proxies;
- constant-time comparison;
- per-install uniqueness by construction, no cross-install reuse unless the
  operator copies a config by hand;
- rotation is `-Force`, which replaces the token and requires pasting the new
  one.

**Recommendation — R3 (Low, no change now).** Do not add mTLS or certificate
infrastructure: a browser cannot present a client certificate to a loopback
service without user friction, and it would add a PKI burden with no gain over a
random bearer token. Do not weaken the origin or token gate for convenience. If
rotation becomes a support problem, add an explicit "rotate token" action in the
launcher that writes the same file atomically and prints the new token once —
not a weaker token. Any change to the header name or length would be a **breaking
protocol change** and must ship with a connector version bump and portal
compatibility check (see §13).

---

## 13. Bridge request surface and protocol contract

**Static.** Four routes exist, each with one method:

| Route | Method | Purpose |
|---|---|---|
| `/api/tally/export` | `POST` | read the master collections and/or the `Voucher Register` |
| `/api/tally/status` | `GET` | reachability and configured target only |
| `/api/tally/companies` | `GET` | list open Tally companies |
| `/api/tally/preflight` | `GET` | run the prerequisite checks |

**Automated test.** Any other path returns `404`; the right path with the wrong
method returns `404`; `POST /api/tally/export` with a JSON body returns `400`
and the body is never forwarded, so the bridge is not a general-purpose local
proxy. Query parameters other than the documented ones (`from`, `to`,
`company`, `scope`, `mode`) have no effect: a request carrying
`report=Import Data&id=Import Data&action=create` still produces
`<ID>Synapse Ledger</ID>` (the first master collection), never an import
document.

**Static.** The connector identifies itself with
`TALLY_CONNECTOR_VERSION` and `TALLY_BRIDGE_CONTRACT_VERSION`; the portal
requires contract version 2 (`MIN_BRIDGE_CONTRACT`) and reports an older
connector instead of falling back. A protocol change is therefore visible and
fails closed. **Automated test** (portal-side contract tests).

---

## 14. Tally read-only guarantees

**Static — the actual requests.** The connector can issue exactly three kinds of
Tally document: the voucher report, a named set of master collections, and the
company list.

| Document | Envelope |
|---|---|
| `Voucher Register` | `<TALLYREQUEST>Export</TALLYREQUEST><TYPE>DATA</TYPE>` |
| `Synapse Ledger`, `Synapse Group`, `Synapse StockItem`, `Synapse StockGroup`, `Synapse Unit`, `Synapse Godown` | `<TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>` |
| `List of Companies` | `<TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>` |

There is no code path that builds an `Import`, sets `ISMODIFY` to `Yes`, sends
an `ACTION`, or posts a `TALLYMESSAGE` payload. `buildTallyExportRequest`
rejects any report name outside the allowlist with
`TALLY_BRIDGE_REPORT_UNSUPPORTED`.

**Automated test — runtime, not a source search.** `bridge.test.mjs` drives
**every interface that can reach Tally** — export (opening), closing
(balances-only), `scope=masters`, `scope=vouchers`, companies, and preflight —
through the real HTTP server, captures every request body actually sent, and
asserts for each one:

- `<TALLYREQUEST>Export</TALLYREQUEST>` is present;
- `<TYPE>` is `DATA` or `Collection` only;
- `<ID>` is one of the three reports above;
- none of `ACTION`, `IMPORTDATA`, `<IMPORT`, `ISMODIFY="Yes"`,
  `TALLYMESSAGE`, `<MASTER`, or `<SVCURRENTDATE>` appear.

All three reports were observed, so the assertions cover every builder rather
than a subset.

A second test asserts every Tally-bound request goes to the configured origin
at path `/` — the caller cannot redirect the bridge to another host or path.

**Not verified.** How a real TallyPrime / Tally.ERP 9 gateway treats these
documents. That is the purpose of the controlled Windows test.

---

## 15. Portal-to-bridge transport and secret handling

**Static.** `lib/tally/bridge-client.ts` sends the token only in
`x-synapse-tally-bridge-token`, never in a URL or a cookie. The browser holds
it in React component state (`app/portal/tally-import/page.tsx`), not in
`localStorage` or `sessionStorage`, so it is not persisted across reloads and
not readable by a later script on the same origin. No server route accepts or
forwards the bridge token.

The bridge answers with `x-synapse-tally-from`, `-to`, `-company`, `-mode` and
`-scope` echo headers, and the portal compares them with what it asked for
before accepting the payload, so a response cannot be attributed to a different
request.

**Static.** Transport is plain HTTP on `127.0.0.1`. HTTPS would require a
trusted local certificate for a loopback name; browsers already treat
`127.0.0.1` as a potentially-trustworthy origin and the payload never leaves
the machine. **Inferred:** introducing certificates here adds operational
failure modes with no security gain. **Not changed.**

**Static.** The preflight runs on the pharmacy computer and returns a report,
not company data. Its token evidence is a boolean `{ tokenConfigured }`, and
its read-only check lists the four endpoints and `acceptsWritesToTally: false`.
**Automated test:** the preflight response does not contain the token or any
`<ENVELOPE`, `<TALLYMESSAGE` or `<COLLECTION` text, and it asks Tally only for
its company list.

---

## 16. Backend authorization, tenant isolation and server-side trust

**Static.** Every server route calls an authorization helper before doing work:

| Route | Calls |
|---|---|
| `[id]/route.ts` (GET) | `requireTallyAdmin(request, "inventory.read")` |
| `[id]/route.ts` (PATCH/POST) | `requireTallyAdmin(request, "inventory.write")` |
| `[id]/preview` | `requireTallyAdmin(request, "inventory.write")` |
| `[id]/extract` | `requireTallyAdmin(request, "inventory.write")` |
| `[id]/mapping` | `requireTallyAdmin(request, "inventory.write")` |
| `[id]/apply` | `requireTallyAdmin(request, "inventory.adjust")` **plus** `tallyHasCapability(auth, "reports.financial")` |
| `upload-url` | `requireTallyAdmin(request, "inventory.write")` |
| `status` | `requireTallyPermission(request, "inventory.read")` (reports only) |
| `template` | `requirePharmacyPermission("inventory.write")` |

A disabled button is therefore not a control: the same checks run on direct API
access. **Automated test:** the route suites call handlers directly with
mocked auth, including unauthorized cases (38 apply tests, 17 extract, 15
preview, 12 upload-url, 11 route, 10 mapping).

`tallyCutoverEnabled` (`lib/tally/auth.ts:71`) fails **closed** in production:
without an explicit `SYNAPSE_TALLY_CUTOVER_ENABLED=true` the cut-over routes
return the disabled response. **Automated test** (`auth.test.ts`), including
`" FALSE "` being treated as false.

**Tenant isolation — static.** Every session lookup, update and lock call is
filtered by `.eq("tenant_id", tenantId)`; the upload key is built from the
authenticated tenant; the cut-over lock is keyed by `tenant_id` as primary key.
**Automated test:** route tests assert a cross-tenant session id returns `404`.

**Database — static (read-only inspection).** Migration
`20261030120000_pharmacy_tally_cutover_lock.sql` enables row-level security,
revokes all access from `PUBLIC`, `anon` and `authenticated`, grants only
`service_role`, and defines both lease functions as `SECURITY DEFINER` with
`SET search_path = ''`. The claim function re-checks that the session belongs
to the tenant and is a `Tally` session before granting a lease.

**Not verified.** The live database's policies for
`pharmacy_import_sessions` and the storage bucket. The migration above is in the
repository and was read; it was **not applied**, and no database was contacted.
This must be confirmed against the deployed schema by whoever owns it.

**Company pinning — static + automated test.** An export without a pinned
company is refused (`TALLY_BRIDGE_COMPANY_UNPINNED`); a response naming a
different company is refused (`TALLY_BRIDGE_COMPANY_MISMATCH` or
`..._UNVERIFIED`); both are covered by tests.

---

## 17. Apply authorization, completeness, and log hygiene

**Static.** `apply/route.ts` refuses to write unless all of the following hold
(tenant-scoped throughout):

1. The session exists **for this tenant**; otherwise `404`.
2. No completed cut-over exists for another session; otherwise `409`.
3. The session is in a resumable state and has a reviewed plan.
4. The source was not truncated (`SOURCE_TRUNCATED` blocking exception → `409`).
5. The Tally manifest exists, is readable, names this session, and
   `canApplyManifest` reports every chunk complete with every voucher in range;
   otherwise `409` with problems.
6. A resume must match the manifest's `sessionId`, a saved execution record,
   and the tenant's one-shot reservation; otherwise `409`.
7. Unverified coverage requires an explicit acknowledgement bound to
   `manifest.updatedAt`, either in the request body or already saved; otherwise
   `409`.
8. `flagged_rows` must be zero; otherwise `409`.
9. A tenant-scoped lease must be acquired; a busy lease returns `409`.

**Automated test.** The apply suite (38 tests) covers these branches, including
the resume-evidence mismatch and the unverified acknowledgement.

**Log hygiene — static.** Across `app/api/admin/tally` and `lib/tally` there is
exactly one log statement: `console.error("[pharmacy][tally]", error)` in
`lib/tally/http.ts:50`, reached only for an unrecognised error; the client gets
a fixed sentence. Recognised errors return a mapped code and message. No route
logs the uploaded document, the manifest body, or Tally XML. The bridge maps
every failure to a `TALLY_BRIDGE_*` code before responding.

**Residual risk — R6 (Low).** Per-chunk error text stored on the manifest is
capped at 300 characters (`lib/tally/extraction.ts:106`). In this codebase the
sources are bridge error codes, but the cap does not itself distinguish a
parser message that embeds a data fragment. **Static**; no runtime case was
found.

---

## 18. Findings, test evidence and decision

### 18.1 Fixed in this audit

| # | Severity | Finding | Fix |
|---|---|---|---|
| F1 | High | Elevated `-InstallNodeOnly` trusted a caller-supplied SHA-256 and never verified the signature, so a UAC-approved run could install an arbitrary MSI | Signature and signer re-verified inside `Install-NodePackage` before `msiexec` |
| F2 | High | Signer matched with a substring, accepting a certificate whose subject merely contained `OpenJS Foundation` | `Test-NodeSignerSubject` parses the `O=` field exactly |
| F3 | High | Portal interpolated a Tally-supplied company name into double-quoted PowerShell, so `$`, backticks or a quote could execute | Both commands built by tested functions with single-quote literals and `''` doubling; unsafe names dropped |
| F4 | Medium | Downloads followed redirects, letting a proxy move the checksum list or the MSI to another origin | `-MaximumRedirection 0` on all three downloads |
| F5 | Medium | `Assert-OfficialUrl` accepted a non-default port and user-info in a `nodejs.org` URL | Scheme, exact host, `IsDefaultPort`, no `UserInfo` |
| F6 | Medium | A failed `icacls` was ignored, leaving the token readable by inherited accounts | `Protect-ConfigFile` throws on a non-zero exit code |
| F7 | Medium | `config.json` was written at the live path before being restricted, so an interruption could leave a readable or partial token | Write `config.json.new`, restrict it, then rename over the destination |
| F8 | Medium | Uninstall recursively deleted a caller-supplied `-InstallRoot`, up to a drive root | `Test-ConnectorInstallRoot` refuses roots and system folders, and requires the connector's own files |

### 18.2 Open and accepted

| # | Severity | Finding | Status |
|---|---|---|---|
| R1 | Medium | The installer script is unsigned and distributed with `-ExecutionPolicy Bypass` | Not fixed — needs an organisation certificate and release pipeline. Blocks **customer distribution**, not the controlled Windows test. |
| R2 | Medium | Checksum list and MSI share one origin; Authenticode is the only independent anchor | Accepted; mitigated by §5 |
| R3 | Low | Bearer token is replayable by any process that can read it; rotation only via `-Force` | Accepted design limitation; recommendation in §12 |
| R4 | Low | Node.js download needs outbound HTTPS during installation | Documented; the installer fails honestly offline |
| R5 | Low | `-InstallRoot` remains a parameter for installation (guarded only in uninstall) | Accepted: it writes within the user's own privileges |
| R6 | Low | Per-chunk error text cap does not exclude a parser message that embeds data | Reported; no runtime case found |
| R7 | Medium | If Tally's own gateway is exposed to the LAN, Tally can be read/written directly | Operational; must be measured on the Windows test |
| R8 | Info | The connector cannot distinguish a compromised browser session from the operator | Inherent to a loopback bearer model |

### 18.3 Files changed by this audit

- `apps/tally-bridge/scripts/synapse-tally-connector.ps1`
- `apps/tally-bridge/src/installer.test.mjs`
- `apps/tally-bridge/src/bridge.test.mjs`
- `apps/pharmacy/lib/tally/bridge-command.ts`
- `apps/pharmacy/lib/tally/bridge-command.test.ts`
- `apps/pharmacy/components/tally/tally-setup-assistant.tsx`
- this document

No protocol, authentication contract or deployment configuration was changed.
The connector version and contract version were left at `0.2.0` / `2`.

### 18.4 Executed evidence

Run in this working tree on Linux, Node v24, 2026-11-01:

| Suite | Command | Result |
|---|---|---|
| Bridge | `node --test src/*.test.mjs` | 127 tests: 126 passed, 1 skipped (Windows-only), 0 failed |
| — `bridge.test.mjs` | | 76 tests: 75 passed, 1 skipped |
| — `installer.test.mjs` | | 31 passed |
| — `preflight.test.mjs` | | 20 passed |
| Portal | `npx vitest run lib/tally app/api/admin/tally` | 24 files, 335 passed, 0 failed |
| Database parser | `node --import tsx --test packages/db/src/tally-*.test.ts` | 78 passed, 0 failed |
| Types | `npx tsc --noEmit` (in `apps/pharmacy`) | exit 0 |
| Lint | `npx eslint` on the changed TS files | exit 0 |
| Whitespace | `git diff --check` | exit 0 |

The bridge tests in §11, §12, §13 and §14 talk to a real listening socket and
capture real request bodies. The installer and PowerShell assertions are
**static tests of the shipped text**; they prove what the script may not
contain, never what Windows does.

### 18.5 What is still unverified

- The installer on Windows: download, checksum, Authenticode, UAC, `msiexec`,
  3010 handling, shortcuts, config ACLs, uninstall.
- Real TallyPrime and Tally.ERP 9: the three requests, company naming, period
  echo, and whether the XSD shape matches the fixtures.
- The deployed database schema and storage policies.
- The six portal screens in a browser (no authenticated database was available;
  no `.env.local` in `apps/pharmacy`).
- Private-network preflight behaviour in a real Chromium build.

### 18.6 Decision

**Suitable for a controlled Windows installation test — yes, with conditions.
Suitable for customer distribution — not yet.**

The trust chain that matters before touching a customer's Tally installation
has been tightened where it was actually broken: the elevated path no longer
installs an unverified MSI, the signer is checked exactly, downloads cannot be
redirected, the token is written atomically and fails closed when its ACL
cannot be applied, uninstall cannot delete an arbitrary folder, and the portal
can no longer be induced to hand an operator a command that executes Tally-
supplied text.

The conditions for the controlled test:

1. Record every item in §18.5 and in
   [TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md),
   including the `Get-NetTCPConnection -LocalPort 9000` result (R7).
2. Use a test company that contains **no real patient or financial data**, and
   do not apply the result.
3. Sign the `.ps1` (or wrap it) before any distribution beyond the test
   machine — R1 is the remaining gate on customer use.
4. Treat the token as a secret in the test report: do not paste it into
   tickets, chat or screenshots.

Passing automation is not the basis for this decision. The automation proves
the gate order, the origin matrix, the token comparisons and the read-only
request shapes. It cannot prove Windows behaviour, Tally's answers, or the
deployed database — those are the items listed above, and until they are
recorded the connector is not production-ready.
