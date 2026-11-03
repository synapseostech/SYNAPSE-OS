# Evidence — SYNAPSE Tally Connector, controlled Windows test

Fill this in during the run described in
[TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md](./TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md).
A value written from memory afterwards is not evidence: record each result at
the phase where it was observed.

**Never paste:** the bridge token, any Tally XML, Day Book rows, ledger or
voucher values, or a customer company's name. Record counts, codes, headers,
timestamps and file hashes only.

---

## 0. Run identity

| Field | Value |
|---|---|
| Run ID | |
| Date started (local) | |
| Date finished (local) | |
| Tester (name, role) | |
| Tester's Windows account (`DOMAIN\user`) | |
| Route taken (§0.2 of the runbook) | A / B |
| Portal used for Route B | none / local / deployed (name) |
| Approval reference for any shared database write | |

Declarations — tick only what is true:

- [ ] The Tally company used is a test company with invented or de-identified data.
- [ ] Apply was never pressed and unverified coverage was never acknowledged.
- [ ] No Tally setting was changed except enabling its HTTP/XML gateway.
- [ ] No security control was disabled to make the run work.
- [ ] The token was redacted from every artefact before sharing.

---

## 1. Build identity (from the Linux build machine)

| Field | Value |
|---|---|
| Repository | `/home/ebrine/Desktop/SYNAPSE-OS` |
| Branch | |
| `HEAD` | |
| Working-tree changes at freeze (`git status --short \| wc -l`) | |
| Connector version (`package.json`) | 0.2.0 |
| Bridge contract version | 2 |

| File | Linux SHA-256 | Windows SHA-256 | Match |
|---|---|---|---|
| `synapse-tally-connector.ps1` | | | Y / N |
| `Start-SynapseTallyConnector.ps1` | | | Y / N |
| `tally-probe.ps1` | | | Y / N |
| `src/cli.mjs` | | | Y / N |
| `src/bridge.mjs` | | | Y / N |
| `src/preflight.mjs` | | | Y / N |
| `src/check.mjs` | | | Y / N |
| `package.json` | | | Y / N |
| `PACKAGE_LABEL.txt` (archive root) | | | Y / N |
| Transfer archive | | | Y / N |

These nine files are the whole allowlist. An archive containing anything else
(`.mcp.json`, `.claude/`, `src/*.test.mjs`) is stop condition S3.

Any `N` is stop condition S3.

---

## 2. Machine

| Field | Value |
|---|---|
| Manufacturer / model | |
| Windows product name | |
| Windows version / build (`Get-ComputerInfo`) | |
| `[Environment]::OSVersion.Version` | |
| Architecture (`PROCESSOR_ARCHITECTURE`, `Is64BitOperatingSystem`) | |
| PowerShell version / edition | |
| Execution policy, per scope | |
| Locale / time zone | |
| System clock at start | |
| Free bytes on the connector's drive | |
| Running elevated? (for the install command) | No |
| Antivirus enabled / real-time protection | |
| Firewall profile states | |

Anything that blocks: record the exact message and stop (§1 of the runbook).

---

## 3. Node.js before installation

| Field | Value |
|---|---|
| `node.exe` found on `PATH` | yes / no — path: |
| `node --version` | |
| Uninstall entries (`Node.js …`) | |
| Case from runbook §4.4 | none / 22.x / older / newer |
| Expected installer behaviour | download / use / replace / warn-and-keep |

---

## 4. Installer integrity

| Field | Value |
|---|---|
| `Get-FileHash` of the installer | |
| `Get-AuthenticodeSignature` status | NotSigned / Valid / other: |
| Signer subject, if any | |
| `Zone.Identifier` present | yes / no — length: |
| `Unblock-File` used | no / yes (hash verified first: Y) |
| Confirmation that no machine-wide policy was changed | yes |

---

## 5. Installation

| Field | Value |
|---|---|
| Command run (redact nothing in it — it holds no secret) | |
| Elevated separately before starting | no |
| UAC prompt observed | none / prompt shown / accepted / declined |
| UAC prompt text | |
| Elevated window outcome | n/a / success / exit code: |
| Installer exit code (`$LASTEXITCODE`) | |
| Interpretation (runbook §7.4) | success / installed-but-not-ready / failed |
| `%LOCALAPPDATA%\Synapse\TallyConnector\config.json` exists | yes / no |
| `src\cli.mjs` exists | yes / no |

Installer console, copied verbatim from `install.log` (no token):

```
Node.js download verified: …
Node.js installer signature valid: …
Restricted config.json to … and SYSTEM.
Shortcut created: …
Synapse Tally Connector installer started.
Installer finished with verification exit code …
```

| Check | Result |
|---|---|
| `$log.Contains($config.token)` | False / **True (stop)** |
| Files installed (list) | |
| `logs\` folder present | yes / no |
| Three Start Menu shortcuts under Synapse | yes / no |

---

## 6. Configuration

| Field | Value |
|---|---|
| `version` | |
| `allowedOrigins` | |
| `tallyTarget.host` / `.port` | |
| `bridgePort` | |
| `company` | |
| `connectorVersion` | |
| `installedAt` | |
| Token length | 64 |
| Token matches `^[0-9a-f]{64}$` | True / False |

`icacls` output for `config.json`:

```
(paste verbatim)
```

| Check | Result |
|---|---|
| Inheritance removed | yes / no |
| `SYSTEM` has `(F)` | yes / no |
| Only the installing account otherwise | yes / no |
| Any `Users` / `Everyone` / `Authenticated Users` / inherited ACE | no / **yes (finding)** |

---

## 7. Tally

| Field | Value |
|---|---|
| Edition | TallyPrime / Tally.ERP 9 |
| Version (Help → About) | |
| Executable path | |
| Gateway enabled at (menu path) | |
| Test company name | |
| Companies open at the time of the test | |
| Connector-reported `edition` | prime / erp9 / unknown |

Run this block once per edition; do not merge the two records.

---

## 8. Port binding record

Complete a row each time the port checks are run (before Tally starts, after
the gateway is enabled, during extraction).

| Time | Port | `LocalAddress` | PID | Process | Process path | Verdict |
|---|---|---|---|---|---|---|
| | 9000 | | | | | PASS / STOP |
| | 9000 | | | | | PASS / STOP |
| | 17890 | 127.0.0.1 | | node | | PASS / STOP |

LAN reachability (`Test-NetConnection <lan-ip> -Port 9000`):

| Time | LAN IP used | `TcpTestSucceeded` | Verdict |
|---|---|---|---|
| | | False / **True (S1)** | |

If Tally was exposed and isolated, record the method (gateway bind / firewall
rule / network segment), who approved it, and when it was removed:

```
```

---

## 9. Bridge health

| Field | Value |
|---|---|
| Bridge started (time, how) | shortcut / direct script |
| Transcript path | |
| Token line redacted from transcript | yes / no |

Four startup lines, verbatim:

```
Synapse Tally Bridge listening at http://127.0.0.1:17890
Tally XML target: http://…
Allowed portal origins: http://…
Exports are read-only and remain staged until a pharmacy administrator applies them.
```

`GET /api/tally/status` (paste, token never appears in it):

```json
```

`GET /api/tally/companies`:

```json
```

Preflight summary:

| `ready` | `passed` | `warning` | `missing` | `failed` | `blocked` | `not_applicable` | `blocking` |
|---|---|---|---|---|---|---|---|
| | | | | | | | |

Per-check results:

| Check | Status | Message |
|---|---|---|
| windows | | |
| architecture | | |
| node_version | | |
| system_clock | | |
| disk_space | | |
| connector_files | | |
| connector_dependencies | | |
| bridge_binding | | |
| bridge_token | | |
| allowed_origin | | |
| tally_installation | | |
| tally_port | | |
| tally_service | | |
| tally_company_open | | |
| tally_company_pinned | | |
| portal_https | | |
| connector_read_only | | |

Leak and gate checks:

| Check | Expected | Observed |
|---|---|---|
| Report contains the token | False | |
| Report matches `<ENVELOPE\|<TALLYMESSAGE\|<VOUCHER\|<LEDGER` | False | |
| Status without token | 401 | |
| Status with wrong origin | 403 | |
| POST body to `/api/tally/export` | 400 | |

`-Status` output after pinning:

```
Connector: …
Tally:     …
Edition:   …
Company:   …
Period:    …
```

Exit code of `-Status`:

---

## 10. Guarded read-only export

| Field | Value |
|---|---|
| Request | `POST /api/tally/export?mode=opening&scope=vouchers&from=…&to=…` |
| HTTP status | |
| `x-synapse-tally-from` | |
| `x-synapse-tally-to` | |
| `x-synapse-tally-company` | |
| `x-synapse-tally-mode` | |
| `x-synapse-tally-scope` | |
| Response bytes (`RawContentLength`) | |
| Tally's company element found in the payload | yes / no — value: |
| Tally's period elements found in the payload | yes / no — values: |
| Error code, if not 200 | |

The echo headers state what the bridge sent. Tally's own elements are the
independent check that the request reached the right company and period.

---

## 11. Extraction and review (Route B only)

| Field | Value |
|---|---|
| Portal origin | |
| Session ID | |
| Period requested | |
| Ranges read / total | / (2 for this 31-day period — one masters range, one voucher range) |
| Ranges failed | |
| Records reported | |
| `consolidation.vouchers.unique` | |
| `consolidation.totals` | |
| `consolidation.dates` (first / last) | |
| `manifest.evidence` present | yes / no |
| Coverage panel state | unverified |
| Apply pressed | **no** |
| Unverified coverage acknowledged | **no** |
| `GET /api/admin/tally/<sessionId>` saved to | |

---

## 12. Reconciliation against Tally's Day Book

| Check | SYNAPSE | Tally | Match |
|---|---|---|---|
| Voucher count | | | Y / N |
| Total per voucher type 1 | | | Y / N |
| Total per voucher type 2 | | | Y / N |
| Total per voucher type 3 | | | Y / N |
| First voucher date | | | Y / N |
| Last voucher date | | | Y / N |

Unexplained differences (each is a finding):

```
```

---

## 13. Shutdown and uninstall

| Field | Value |
|---|---|
| Bridge stopped by | Ctrl+C / transcript stop / `-Stop` |
| Stop message | |
| Port 17890 has no listener afterwards | yes / no |
| Uninstall run | yes / no |
| Uninstall prompt text | |
| Uninstall output | |
| Connector folder gone | yes / no |
| Start Menu folder gone | yes / no (or: kept because …) |
| Node.js still installed (`node --version`) | yes / no |
| Tally still opens the test company | yes / no |
| Tally Day Book still matches §12 after uninstall | yes / no |

---

## 14. Failures and stops

Every stop condition, warning and unexpected message:

| Time | Phase | Stop condition / error code | Exact message | Action taken | Screenshot |
|---|---|---|---|---|---|
| | | | | | |
| | | | | | |
| | | | | | |

If nothing failed, write "none observed" — do not leave the table empty and
imply it was not checked.

---

## 15. Artefacts

| File | Phase | What it shows | Redacted |
|---|---|---|---|
| | | console / port / config / review | Y / N |
| | | | |

---

## 16. Category summary

| Category | Result | Evidence |
|---|---|---|
| Already executed on Linux (repository suites) | passed / failed | [TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md) §11 |
| Requires Windows (install, UAC, ACL, shortcuts, launcher, uninstall) | passed / failed / not run | |
| Requires real TallyPrime | passed / failed / not run | |
| Requires real Tally.ERP 9 | passed / failed / not run | |

A result in one row must not be promoted into another.

---

## 17. Decision

| Question | Answer |
|---|---|
| Windows installation path works as documented | yes / no |
| Bridge binds loopback only and the gates behave (401/403/400) | yes / no |
| Tally answers read-only, for the right company and period | yes / no |
| Route B: extraction reached review with an unverified panel | yes / no / n/a |
| Route B: reconciliation matches Tally's own figures | yes / no / n/a |
| Any stop condition triggered | yes (see §14) / no |
| Blocking defects | |

**Suitable to proceed to a persistence/apply test?** yes / no — because:

```
```

Record explicitly that this run does **not** evidence the Tally-independence
acceptance criterion: no imported record was persisted, no operational record
was created, and no disconnect test was performed.

---

## 18. Sign-off

| Field | Value |
|---|---|
| Tester | |
| Reviewer | |
| Date | |
| Run classification | engineering test — not customer distribution, not production approval |

---

## 19. Appendix — document-chain probe (optional)

Run this **only** when the client needs Tally's non-posting documents — orders,
delivery and receipt notes, rejections, stock journals, physical stock — and
only against a **copy** of their company. It is not part of the controlled test:
it does not change §16 or §17, and nothing recorded here is evidence that the
archive works, because the archive does not exist yet.

The questions it answers are
[TALLY_DOCUMENT_CHAIN_DESIGN.md](./TALLY_DOCUMENT_CHAIN_DESIGN.md) §3 (Q1, Q2,
Q3). Record counts, codes and field names only. Never paste XML, a document
number, a party name, a quantity or a value.

### 19.1 Run identity

| Field | Value |
|---|---|
| Design version reviewed | |
| Tally edition and release | TallyPrime / ERP 9 — |
| Company is a copy, not the live company | yes / no |
| Period probed (from / to) | |
| Period contains every type below | yes / no (name what is missing) |
| Export route | bridge / hand-exported XML |

### 19.2 Does each document type appear?

Count from Tally's own report for the period, and from what the export
contained. "Absent" is a result, not a failure to look.

| Tally document | In the Day Book export? | Count per Tally | Count in export | First / last date seen |
|---|---|---|---|---|
| Sales Order | yes / no | | | |
| Purchase Order | yes / no | | | |
| Delivery Note | yes / no | | | |
| Receipt Note | yes / no | | | |
| Rejection In | yes / no | | | |
| Rejection Out | yes / no | | | |
| Stock Journal | yes / no | | | |
| Physical Stock | yes / no | | | |
| Cancelled voucher (any type) | yes / no | | | |
| Custom voucher type (name it) | yes / no | | | |

If an order type is absent, record whether a hand-exported per-type register
(for example the Sales Order register saved as XML) parses through the same
upload path — that is the cheap alternative to a connector change.

| Hand-exported register | Types tried | Parsed? | Documents read |
|---|---|---|---|
| | | yes / no | |

### 19.3 Which fields survive?

Mark a field **present** when it appeared on at least one document and was
readable, and name that type in the last column. Mark it **absent** only when no
document of any type carried it. A field present on notes but missing on orders
is the interesting case: write "present on X, absent on Y" in the last column
rather than ticking one box and losing the distinction. A field Tally displays
but the export omits is absent — that is the finding.

| Field | Present | Absent | Type it appeared on |
|---|---|---|---|
| Voucher number | | | |
| Voucher date | | | |
| Party name | | | |
| Narration | | | |
| Order / reference number | | | |
| Due date or delivery date | | | |
| Dispatch details (carrier, destination, shipped by) | | | |
| Order → invoice reference | | | |
| Stock item name per line | | | |
| Quantity per line | | | |
| Rate and amount per line | | | |
| Godown | | | |
| Batch name | | | |
| Batch expiry | | | |
| Batch quantity | | | |

### 19.4 Are documents linked?

| Question | Answer | Field that carried it |
|---|---|---|
| A delivery note names the order it fulfils | yes / no | |
| A sales invoice names the order or delivery note it bills | yes / no | |
| A receipt note names the purchase order it receives | yes / no | |
| A rejection names the note it reverses | yes / no | |
| Any link is usable without guessing | yes / no | |

A "no" in the last row means the archive would be a dated list of documents,
not a chain. Say so in §19.6 rather than implying otherwise.

### 19.5 Counts that would reconcile the archive

| Type | Tally count | Export count | Difference explained |
|---|---|---|---|
| | | | |

An unexplained difference is a finding, not a rounding.

### 19.6 What this probe concluded

| Question | Answer |
|---|---|
| Q1 — are orders in the Day Book export? | yes / no / only via hand export |
| Q2 — are linkage and dispatch fields present? | yes / no / partly (name them) |
| Q3 — is there an independent per-type count to reconcile against? | yes / no |
| Is a connector change required before the archive can be built? | yes / no |
| Does the client accept a dated list if no links exist? | yes / no / not asked |

Notes, in prose, without values or identifiers:

```
```

### 19.7 Declarations

- [ ] The company probed was a copy; the live company was not opened for this.
- [ ] Nothing was created, altered or deleted in Tally.
- [ ] No XML, document number, party name, quantity or value is recorded above.
- [ ] The results are recorded as observed, including types that did not appear.
