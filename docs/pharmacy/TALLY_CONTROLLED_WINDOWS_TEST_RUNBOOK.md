# Tally Connector — controlled Windows test runbook

Companion to [TALLY_CONNECTOR_SECURITY_AUDIT.md](./TALLY_CONNECTOR_SECURITY_AUDIT.md),
[TALLY_CONNECTOR_INSTALLATION.md](./TALLY_CONNECTOR_INSTALLATION.md),
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md) and
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md).

Evidence is recorded in
[TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md](./TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md).

> **Status.** This runbook is written from the code in this repository. Nothing
> in it has been executed on Windows, against a real Tally installation, or
> against any database. Every command is reproducible from the shipped scripts;
> every expected output is quoted from those scripts unless it is marked
> *assumed*.

---

## 0. What this run is, and what it is not

This is the **first controlled engineering test** of the connector on Windows.
It answers one question:

> Can the packaged connector be installed on a real Windows machine, started,
> pointed at a real TallyPrime or Tally.ERP 9 company, and made to read one month
> of books, without writing to Tally and without exposing anything to the
> network?

It stops at the **review** screen. It does not apply, does not persist
operational records, and does not test the Tally-independence acceptance
criterion in §0.4.

### 0.1 Rules in force for the whole run

1. Use a **test company** containing invented or de-identified data. No real
   patient, customer or financial data.
2. Never press **Apply**, never acknowledge the unverified-coverage panel, never
   create a ledger entry. If Apply becomes clickable, that is a defect to record,
   not a step to take.
3. Never change Tally settings beyond enabling its HTTP/XML gateway. Never type
   a Tally password into anything but Tally itself.
4. Never disable Windows Defender, the firewall, UAC, SmartScreen or script
   blocking to "make it work". If a control blocks the run, the run stops (§1).
5. The bridge token is a secret for the duration of the test. It appears in the
   console and in any transcript; redact it before sharing.
6. Record evidence as you go, in the template. A result remembered afterwards
   is not evidence.

### 0.2 Two routes through the run

| Route | What it needs | What it proves |
|---|---|---|
| **A — no shared database** | Windows, Tally, the connector. No portal session. | Installer, bridge, origin/token gates, company discovery, a real dated export, Tally's XML shape. Stops after §9. |
| **B — review in the portal** | Everything in A plus a portal you are authorised to write one staging session to. | All of A, plus chunking, server-side parsing, consolidation and the review screen. Stops at review. |

Route A is the default for the first pass because it writes nothing anywhere.
Route B is required to exercise review and reconciliation. If Route B uses the
deployed portal, **one `pharmacy_import_sessions` row is written to that
database** — get the owner's explicit approval for that environment before
starting, or use a local portal.

### 0.3 Which Tally editions are in scope

Two separate tests, recorded separately, even if run on the same machine:

- **TallyPrime** — expected to answer the same three read-only requests.
- **Tally.ERP 9** — a different codebase and a different gateway menu; expect
  differences in company naming and period echo. A pass on one is not a pass on
  the other.

### 0.4 Relationship to the Tally-independence acceptance criterion

SYNAPSE Pharmacy is required to operate independently of Tally after a completed
migration: imported records persisted in SYNAPSE's database, converted to
operational records, reconciled, provenance preserved, and every normal
pharmacy function working with the Tally Bridge, Tally and the original Tally
computer all switched off.

**This run does not demonstrate any of that.** It reads Tally and stops at
review. The independence criterion is satisfied only by a later run that
applies an approved migration to a non-production environment and then performs
the disconnect test (POS, inventory, purchasing, supplier, customer, payment,
reporting and accounting operations with Tally uninstalled or powered off).
Do not record this run as evidence for that criterion.

---

## 1. Stop conditions

Stop the run immediately, record the phase and the exact message, and do not
proceed if any of these is true:

| # | Condition | Why |
|---|---|---|
| S1 | Port 9000 listens on `0.0.0.0`, `::`, or a LAN interface address | Tally is exposed to the network; the connector cannot make that safe (§5) |
| S2 | Port 17890 listens on anything other than `127.0.0.1` | The bridge binding guarantee has failed; a security defect |
| S3 | The installer hash does not match the value recorded on the build machine | The transfer is untrustworthy |
| S4 | `Get-AuthenticodeSignature` on the Node.js MSI is not `Valid`, or the signer is not `OpenJS Foundation` / `Node.js Foundation` | Supply-chain tampering; the installer should already have refused |
| S5 | The preflight report contains the bridge token, Tally XML (`<ENVELOPE`, `<TALLYMESSAGE`, `<VOUCHER`, `<LEDGER`) or any ledger/voucher value | A leak the report must never have |
| S6 | The installer asks you to disable Defender, the firewall, UAC or execution policy beyond the per-process `-ExecutionPolicy Bypass` already in the command | Not a supported installation path |
| S7 | Any Tally action is required that writes, posts, imports or alters data | Out of scope; the connector must not need it |
| S8 | The company open in Tally is not the test company | Risk of reading real books |
| S9 | Apply or "acknowledge unverified coverage" becomes the only way forward | The run stops at review by definition |
| S10 | A migration, SQL statement or database mutation is proposed as part of the test | Out of scope for this runbook |

A stopped run is a valid result. Record where it stopped and why.

---

## 2. Test categories

So that a green section is not mistaken for more than it is:

| Category | Meaning | Where recorded |
|---|---|---|
| **Already executed on Linux** | Assertions that ran in this repository and passed: bridge gates, origin matrix, token comparisons, read-only request shapes, installer static checks, portal route tests, parser tests. | §13 |
| **Requires Windows** | Installer, UAC, `msiexec`, shortcuts, ACLs, config write, launcher, service startup, uninstall. | §4–§7, §11–§12 |
| **Requires real TallyPrime** | Gateway behaviour, company discovery, XML shape, period echo, Day Book totals. | §8–§10 |
| **Requires real Tally.ERP 9** | The same, on the other edition; a separate record. | §8–§10 |

Never merge a Windows result into a TallyPrime result, or a TallyPrime result
into an ERP 9 result.

### 2.1 Already executed on Linux (2026-11-01, this working tree)

| Suite | Command | Result |
|---|---|---|
| Prerequisite engine | `node --test src/preflight.test.mjs` | 20 passed |
| Installer invariants (static) | `node --test src/installer.test.mjs` | 31 passed |
| Bridge, preflight endpoint and security suites | `node --test src/*.test.mjs` | 126 passed, 1 skipped (Windows-only), 0 failed |
| Portal reader | `npx vitest run lib/tally/bridge-preflight.test.ts` | 13 passed |
| Connector↔portal contract | `npx vitest run lib/tally/bridge-preflight.integration.test.ts` | 5 passed |
| Types | `npx tsc --noEmit` | clean |

These prove the text and logic of what ships. They do **not** prove Windows
behaviour, UAC, `msiexec`, shortcuts, ACLs or anything Tally does. Every item in
§4–§15 is unexecuted until recorded in the evidence template.

---

## 3. Before Windows: freeze the build

Run on the Linux build machine, in the repository root. Nothing here is
committed or deployed; it produces the values the Windows run is checked
against.

```bash
cd /home/ebrine/Desktop/SYNAPSE-OS
git rev-parse --abbrev-ref HEAD
git rev-parse HEAD
git status --short | wc -l
sha256sum \
  apps/tally-bridge/scripts/synapse-tally-connector.ps1 \
  apps/tally-bridge/scripts/Start-SynapseTallyConnector.ps1 \
  apps/tally-bridge/scripts/tally-probe.ps1 \
  apps/tally-bridge/src/cli.mjs \
  apps/tally-bridge/src/bridge.mjs \
  apps/tally-bridge/src/preflight.mjs \
  apps/tally-bridge/src/check.mjs \
  apps/tally-bridge/package.json
```

Baseline for the tree as audited on 2026-11-01 (recompute after any edit; the
scripts directory is untracked in this branch, so these hashes are the only
integrity anchor for the transfer):

```
a8ac3b408dfba34e93b09361e74a04fd41591742521b5fce215d81eb78a194ed  synapse-tally-connector.ps1
7acffce40932464c4ab5bf4ae108d9c873f257db74e0ea643a823efabc48a157  Start-SynapseTallyConnector.ps1
1286d110b3f9431898045c51b5dd21d3bbc5f2c7d8dfe4d4803a1df7f237962c  tally-probe.ps1
```

Also record, from the tree:

```bash
cat apps/tally-bridge/package.json | grep '"version"'
grep -n 'TALLY_CONNECTOR_VERSION\|TALLY_BRIDGE_CONTRACT_VERSION' apps/tally-bridge/src/preflight.mjs
```

Expected: connector `0.2.0`, contract `2`.

### 3.1 Transfer package and directory layout

The installer copies its payload from `Split-Path -Parent $PSScriptRoot`
(`synapse-tally-connector.ps1:557`). The script therefore **must** sit at
`…\apps\tally-bridge\scripts\`, with `package.json` and `src\` beside it. A flat
copy of the script into an empty folder fails with
`The connector package is incomplete: package.json is missing.`

Required layout on the Windows machine:

```
C:\SynapseTest\
├── PACKAGE_LABEL.txt
└── apps\
    └── tally-bridge\
        ├── package.json
        ├── src\
        │   ├── cli.mjs
        │   ├── bridge.mjs
        │   ├── preflight.mjs
        │   └── check.mjs
        └── scripts\
            ├── synapse-tally-connector.ps1
            ├── Start-SynapseTallyConnector.ps1
            └── tally-probe.ps1
```

`tally-probe.ps1` is self-contained: it imports nothing from `src\` and runs on
its own. The installer copies only the four `.mjs` files above
(`Copy-ConnectorFiles`), and the tests are not needed on Windows.

Build the archive on the Linux machine. First write the package label that
travels with the files — it is the written record that these scripts are
unsigned and engineering-only:

```bash
STAGE="${TMPDIR:-/tmp}/synapse-tally-test"
mkdir -p "$STAGE"
cat > "$STAGE/PACKAGE_LABEL.txt" <<'LABEL'
CONTROLLED ENGINEERING TEST ONLY — NOT FOR CUSTOMER DISTRIBUTION

Package: SYNAPSE Tally Connector 0.2.0 (bridge contract 2)

The PowerShell scripts in this package are NOT Authenticode-signed. They may be
run only on a disposable test machine, only with the per-process
-ExecutionPolicy Bypass shown in this runbook, and only after the archive hash
and every file hash have been checked against the build machine's values.

This package is not evidence of Windows, TallyPrime or Tally.ERP 9
compatibility, and must not be given to a customer. Customer distribution
requires an Authenticode-signed script (or signed wrapper) and a published
signer subject and thumbprint.

The installer may download Node.js 22.x from https://nodejs.org and verifies its
SHA-256 checksum and Authenticode signature before running it. Nothing here
changes Defender, the firewall, a machine-wide execution policy or any Tally
setting.
LABEL
```

Then archive the nine allowlisted files — the eight connector files and that
label:

```bash
cd /home/ebrine/Desktop/SYNAPSE-OS
tar -czf "$HOME/synapse-tally-test.tgz" \
  apps/tally-bridge/package.json \
  apps/tally-bridge/src/cli.mjs \
  apps/tally-bridge/src/bridge.mjs \
  apps/tally-bridge/src/preflight.mjs \
  apps/tally-bridge/src/check.mjs \
  apps/tally-bridge/scripts/synapse-tally-connector.ps1 \
  apps/tally-bridge/scripts/Start-SynapseTallyConnector.ps1 \
  apps/tally-bridge/scripts/tally-probe.ps1 \
  -C "$STAGE" PACKAGE_LABEL.txt
sha256sum "$HOME/synapse-tally-test.tgz"
```

`-C` applies only to the files named after it, so the label lands at the archive
root and the connector files keep their `apps/tally-bridge/` paths.

Those nine entries are the whole package. Name them explicitly; never archive
the directory. Everything else under `apps/tally-bridge` is excluded on
purpose:

| Excluded | Why |
|---|---|
| `apps/tally-bridge/.mcp.json` | a character device, not a regular file; local tooling state |
| `apps/tally-bridge/.claude/` | git-ignored local settings, hooks and task files |
| `apps/tally-bridge/src/*.test.mjs` | tests use invented fixtures and never run on Windows |
| `apps/tally-bridge/src/bridge.d.mts` | type declaration only |
| `node_modules/`, logs, a runtime `config.json`, any `.env` | runtime or build state, never shipped |

The archive verified for this branch was built under `$TMPDIR`
(`$TMPDIR/synapse-tally-test.tgz`) because `$HOME` was read-only in the build
environment. Its SHA-256 is:

```
fe5379b90bb11c87cc05f3b8951fdf0ee5d9b3be4f33fbc531f90ac1bdba2df9
```

`tar` stores timestamps, so a rebuild elsewhere gets a different archive hash
even with identical contents. What must be identical is every per-file hash
below; the Windows archive hash must match the value you recorded on your own
build machine.

On Windows, verify the archive hash before extracting:

```powershell
Get-FileHash .\synapse-tally-test.tgz -Algorithm SHA256 | Select-Object -ExpandProperty Hash
```

Compare with the Linux value, character for character. They must be identical.
If they are not, stop (S3) and re-transfer.

Extract to `C:\SynapseTest` so the layout above is reproduced, then compare
**every** file in the package — all nine:

```powershell
cd C:\SynapseTest\apps\tally-bridge
Get-FileHash .\scripts\synapse-tally-connector.ps1, .\scripts\Start-SynapseTallyConnector.ps1, `
  .\scripts\tally-probe.ps1, `
  .\package.json, .\src\cli.mjs, .\src\bridge.mjs, .\src\preflight.mjs, .\src\check.mjs `
  -Algorithm SHA256 | Select-Object Hash, Path | Format-Table -AutoSize
Get-FileHash C:\SynapseTest\PACKAGE_LABEL.txt -Algorithm SHA256
```

Every hash must equal the Linux value. A mismatch stops the run (S3).

---

## 4. Phase 0 — machine baseline

Run all of this in a normal (non-elevated) PowerShell window. Do not open an
administrator shell for the run: the installer is supposed to ask for
elevation itself, once, when it needs it (§7).

### 4.1 Windows version and architecture

```powershell
[System.Environment]::OSVersion.Version.ToString()
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber, OsArchitecture
$env:PROCESSOR_ARCHITECTURE
[Environment]::Is64BitOperatingSystem
```

Expected on a supported machine:

- version `10.0.19041` or later (Windows 10 2004+ or Windows 11);
- `OsArchitecture` `64-bit`;
- `PROCESSOR_ARCHITECTURE` `AMD64` or `ARM64`;
- `Is64BitOperatingSystem` `True`.

Stop if 32-bit: the installer throws
`32-bit Windows is not supported…` and there is no supported fallback.
Record Windows 10 builds older than the connector targets as a **warning** —
the preflight marks them `warning`, not blocking, and the owner decides.

### 4.2 PowerShell version

```powershell
$PSVersionTable | Format-List PSVersion, PSEdition, OS
Get-ExecutionPolicy -List | Format-Table -AutoSize
```

Expected: `PSVersion` 5.1 or later. Record the execution policy for each scope;
do not change any of them.

Note for the record: the installer's elevated half always re-launches
`powershell.exe` (`synapse-tally-connector.ps1:311`), so the elevated step runs
under Windows PowerShell 5.1 even if you started from PowerShell 7. Test with
5.1 to match what a customer gets.

### 4.3 Clock, time zone, disk

```powershell
Get-Date
(Get-TimeZone).Id
Get-Volume -DriveLetter ($env:SystemDrive.TrimEnd(':')) | Select-Object DriveLetter, SizeRemaining, Size
```

Expected: a plausible current date; at least 250 MB free (the preflight blocks
below that). Record the time zone — Tally period boundaries follow local dates.

### 4.4 Node.js detection (before the installer touches anything)

```powershell
Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object Source
node --version
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*', `
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' `
  -ErrorAction SilentlyContinue |
  Where-Object DisplayName -like 'Node.js*' |
  Select-Object DisplayName, DisplayVersion, InstallLocation
```

Classify the machine and record which case you are in:

| Found | What the installer will do | What you are testing |
|---|---|---|
| Nothing | Downloads Node.js 22.x, verifies it, asks for UAC, installs it | The full supply-chain path (§6, §7) |
| 22.x | Uses it, no download, no UAC | The common customer case |
| 18.x or 20.x | Downloads and replaces it with 22.x | Upgrade path |
| 23.x or newer | Uses it with a warning; nothing is changed | Forward-compatibility path |

If Node.js is installed, note whether `node.exe` is on `PATH` — the launcher
finds it through `Get-Command` or the three default folders.

### 4.5 Security posture (observe, never change)

```powershell
Get-MpComputerStatus | Select-Object AntivirusEnabled, RealTimeProtectionEnabled, AntivirusSignatureVersion
Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultInboundAction
```

Record these. Do not add exclusions and do not disable anything. A Defender
prompt during installation is expected behaviour to record, not to suppress.

---

## 5. Phase 1 — port 9000 security preflight (mandatory)

Run this **before** the connector reads anything, and again during §9 and §10.
It decides whether the run continues at all.

### 5.1 Who is listening

```powershell
$listeners = Get-NetTCPConnection -State Listen -LocalPort 9000 -ErrorAction SilentlyContinue
$listeners | Select-Object LocalAddress, LocalPort, State, OwningProcess | Format-Table -AutoSize

$listeners | ForEach-Object {
  $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  [pscustomobject]@{
    Address = $_.LocalAddress
    Pid     = $_.OwningProcess
    Process = $p.ProcessName
    Path    = $p.Path
  }
} | Format-Table -AutoSize
```

For each process id, identify the command line:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = <PID>" |
  Select-Object ProcessId, Name, ExecutablePath, CommandLine | Format-List
```

If `Path` is blank, the process belongs to another account; identify it from
Task Manager (Details tab) rather than elevating. `OwningProcess 4` means the
System process — that is not Tally, and the run stops.

### 5.2 Classify every bound address

| `LocalAddress` | Meaning | Verdict |
|---|---|---|
| `127.0.0.1` | IPv4 loopback only | **PASS** — continue |
| `::1` | IPv6 loopback only | **PASS with a note**: set the connector's Tally host to `::1` (§7.2), because the portal's page-level command substitutes `127.0.0.1` for any host that is not a plain hostname or IPv4 literal — `::1` included; use the packaged route |
| `127.0.0.1` and `::1` | Both loops | **PASS** — continue |
| `0.0.0.0` | All IPv4 interfaces | **STOP (S1)** |
| `::` | All IPv6 interfaces, usually also IPv4 | **STOP (S1)** |
| `10.x.x.x`, `192.168.x.x`, `172.16–31.x.x`, `169.254.x.x` | One specific LAN/link-local interface | **STOP (S1)** |
| No rows | Nothing is listening | The gateway is off or Tally is closed — safe, but the run cannot start until §8 |

### 5.3 Prove exposure or the absence of it from the same machine

A wildcard listener is reachable through the machine's LAN address even without
a second computer:

```powershell
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notlike '127.*' -and $_.PrefixOrigin -ne 'WellKnown' } |
  Select-Object -First 1).IPAddress
$lan
Test-NetConnection -ComputerName $lan -Port 9000 -InformationLevel Detailed |
  Select-Object ComputerName, RemotePort, TcpTestSucceeded
```

Expected for an isolated Tally: `TcpTestSucceeded : False`.
`True` means the gateway is reachable from the LAN — **STOP (S1)**.

Record the address table, the process, and this result in the evidence template.

### 5.4 If Tally is exposed

Do not continue. Establish isolation first. Options, in order of preference:

1. **Bind Tally's gateway to loopback.** Some builds let the HTTP/XML server
   bind an address. Whether yours does is unknown to this repository — check
   Tally's own documentation. Changing this is a Tally settings change; record
   it and its reversal.
2. **Block inbound 9000 at Windows Firewall for the duration of the test.**
   This changes a shared security control and needs the owner's approval. Use a
   named, reversible rule and remove it at the end:

```powershell
# owner approval required before running this
New-NetFirewallRule -DisplayName "SYNAPSE-TEST block Tally 9000 inbound" `
  -Direction Inbound -Protocol TCP -LocalPort 9000 -Action Block -Profile Any
```

```powershell
# remove after the test, and confirm it is gone
Remove-NetFirewallRule -DisplayName "SYNAPSE-TEST block Tally 9000 inbound"
Get-NetFirewallRule -DisplayName "SYNAPSE-TEST block Tally 9000 inbound" -ErrorAction SilentlyContinue
```

3. **Move Tally to an isolated machine or network segment** where no other host
   can reach it.

If none is possible, the run is cancelled, not carried out on an exposed Tally.

---

## 6. Phase 2 — installer integrity on Windows

Before running anything:

```powershell
cd C:\SynapseTest\apps\tally-bridge\scripts
Get-FileHash .\synapse-tally-connector.ps1 -Algorithm SHA256 | Select-Object Hash, Path
Get-AuthenticodeSignature .\synapse-tally-connector.ps1 |
  Format-List Status, StatusMessage, SignerCertificate
Get-Item .\synapse-tally-connector.ps1 -Stream Zone.Identifier -ErrorAction SilentlyContinue |
  Select-Object FileName, Stream, Length
```

Expected:

- the hash equals the Linux value;
- `Status : NotSigned` — the script is **not code-signed** in this repository;
- `Zone.Identifier` is present only if the file came from a download or a
  browser; a USB or archive copy may not carry it.

### 6.1 The unsigned-script gate

`NotSigned` is the known, accepted condition for this **controlled engineering
test only** (audit residual risk R1). It is not acceptable for customer
distribution.

Controlled procedure:

1. Verify the archive hash and every script hash against the build machine
   (§3). This transfers trust from the repository to the copy.
2. Run the installer with the **per-process** policy override already written
   into the documented command:
   `powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 …`
   It affects that one process only; it does not change a machine policy.
3. If Windows refused to run the file because it carries a mark-of-the-web,
   record the `Zone.Identifier`, then — and only after step 1 passed — clear it
   for that file and record that action:

```powershell
Unblock-File .\synapse-tally-connector.ps1
```

4. Do **not** run `Set-ExecutionPolicy` at any scope, do not disable SmartScreen,
   and do not add Defender exclusions.

For distribution, this section does not apply. The script (and the archive or
wrapper that carries it) must be Authenticode-signed with the organisation's
code-signing certificate; the release notes must state the expected signer
subject and thumbprint; and `Get-AuthenticodeSignature` must return `Valid`
before installation. Until that exists, no customer is asked to bypass a
security control to install this connector.

---

## 7. Phase 3 — install

### 7.1 The command

```powershell
cd C:\SynapseTest\apps\tally-bridge\scripts
$origin = "https://pharm.synapseos.tech"   # or http://localhost:3002 for a local portal
powershell -NoProfile -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 `
  -PortalOrigin $origin `
  -Company "SYNAPSE TEST COMPANY" `
  -TallyHost 127.0.0.1 `
  -TallyPort 9000
$LASTEXITCODE
```

- `-Company` must match a company Tally has **open**, spelling included. The
  preflight compares case-insensitively.
- `-PortalOrigin` must be the exact origin the browser will send: scheme, host
  and port only — no path, no trailing slash. `http://` is accepted only for
  `localhost` and `127.0.0.1`; every other origin must be `https://`.
- Do **not** pass `-Force` on the first run. It replaces an existing token.

### 7.2 If Tally listens only on `::1`

Use the packaged route with the IPv6 host, because the portal's page-level
command substitutes `127.0.0.1` for any host that is not a plain hostname or
IPv4 literal — `::1` included:

```powershell
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 `
  -PortalOrigin https://pharm.synapseos.tech -Company "SYNAPSE TEST COMPANY" -TallyHost "::1"
```

The bridge brackets the host when it builds the Tally URL
(`bridge.mjs:184`), and `::1` passes its private-target check.

### 7.3 Expected console sequence

Exact strings from the script; timings and versions vary.

```
Looking up the current Node.js 22.x release on nodejs.org...        (only if Node.js is missing or old)
Downloading node-v22.x.y-x64.msi...                                  (only if a download is needed)
Verifying the download against nodejs.org's SHA-256 list...
Verifying the installer's Authenticode signature...
Windows will ask for permission to install Node.js 22.x.y.          (only when not already elevated)
Installing Node.js (Windows will not show a prompt)...               (elevated half)
Node.js 22.x.y is installed.
Installing the connector into C:\Users\<you>\AppData\Local\Synapse\TallyConnector...
Running the prerequisite checks...
Synapse Tally Connector 0.2.0 (contract 2)
Checked <ISO timestamp>
[ok]   Windows version: Windows 10.0.19045 (x64) detected.
[ok]   Processor architecture: x64 is supported.
[ok]   Node.js runtime: Node.js 22.x.y is the supported runtime.
[ok]   System clock: System clock reads <ISO>.
[ok]   Free disk space: N MB is free where the connector runs.
[ok]   Connector files: All 4 connector files are present.
[ok]   Connector dependencies: The connector has no runtime dependencies, so there is no npm install step.
[ok]   Bridge network binding: The bridge listens on 127.0.0.1:17890 and is not reachable from the network.
[ok]   Bridge token: A 64-character token is configured. It is never displayed here and never written to a log.
[ok]   Portal origin: The bridge answers the portal origin https://…
[ok]   Tally installation: Tally was found in its default folder.        (warning if not in a default folder)
[ok]   Tally HTTP port: Tally is accepting connections at http://127.0.0.1:9000.
[ok]   Tally programme: Tally answered a read-only company-list request (1 open).
[ok]   Open company: Tally has 1 company open.
[ok]   Company pinned for export: Exports are pinned to "SYNAPSE TEST COMPANY".
[ok]   Pharmacy portal reachable: The connector reached the portal at https://… (HTTP 200).
[ok]   Tally stays read-only: The connector exposes read-only endpoints only. …
17 passed, 0 warning, 0 missing, 0 failed, 0 blocked, 0 not applicable.
This computer is ready to connect to Tally.

Installed to C:\Users\<you>\AppData\Local\Synapse\TallyConnector
Start Menu: Synapse > Synapse Tally Connector

Copy this token into the portal: <64 hex characters>
It is shown here only; nothing writes it to install.log. Recover it later with -ShowToken.
The connector listens on 127.0.0.1:17890 only. Tally is never written to.
Uninstall later with: -Uninstall
```

### 7.4 Exit code: 0 is not the only successful installation

The script exits with the **verification** exit code
(`synapse-tally-connector.ps1:631`), not with an installation status.

| Exit | Meaning | Action |
|---|---|---|
| 0 | Installed, and every required check passed | Continue |
| 1 with `[miss] Tally HTTP port` in the output | Installed correctly; Tally is not running or its gateway is off | Expected if you installed before opening Tally. The token is still printed. Continue at §8. |
| 1 with `[miss] Company pinned for export` | Installed; `-Company` did not match an open company (or none was given) | Open the right company, or pin it in §10, then re-run `-VerifyOnly`. |
| 1 with `FAILED: …` at the top or a red error | Installation failed; read §12 | Do not continue |

Confirm the installation independently of the exit code:

```powershell
Test-Path "$env:LOCALAPPDATA\Synapse\TallyConnector\config.json"
Test-Path "$env:LOCALAPPDATA\Synapse\TallyConnector\src\cli.mjs"
```

### 7.5 UAC behaviour to record

- **No Node.js installed, non-elevated shell:** a UAC prompt appears after the
  download and verification, naming `Windows PowerShell`. Accept it; the
  elevated window runs `msiexec /qn` with no further prompt. Record the prompt
  text and the elevated window's exit.
- **Declining UAC:** the script reports
  `The elevated Node.js installation did not finish (exit code …). Nothing else was changed.`
  Nothing is copied and no config is written. That is the correct fail-closed
  behaviour — record it.
- **Elevated shell already:** no prompt at all; `Install-NodePackage` runs
  directly.
- **Node.js 22 already present:** no prompt, no download.

Elevation must be confined to the Node.js MSI. Evidence: the connector folder
is under **your** `%LOCALAPPDATA%`, `install.log` shows
`Restricted config.json to <DOMAIN>\<user> and SYSTEM`, and no files appear
under another user's profile.

### 7.6 What installation wrote

```powershell
Get-ChildItem "$env:LOCALAPPDATA\Synapse\TallyConnector" -Recurse -File |
  Select-Object FullName, Length | Format-Table -AutoSize
Get-Content "$env:LOCALAPPDATA\Synapse\TallyConnector\install.log"
```

Expected files: `package.json`, `src\cli.mjs`, `src\bridge.mjs`,
`src\preflight.mjs`, `src\check.mjs`, `scripts\Start-SynapseTallyConnector.ps1`,
`config.json`, `install.log`, and an empty `logs\` folder.

`install.log` must contain version, hash and signature lines — for example
`Node.js download verified: node-v22.x.y-x64.msi <hash>` and
`Node.js installer signature valid: CN=…, O=OpenJS Foundation, …` — and must
**not** contain the token. The log legitimately holds the MSI's 64-hex SHA-256,
so test for the token itself, not for "any 64-hex string":

```powershell
$root = "$env:LOCALAPPDATA\Synapse\TallyConnector"
$log = Get-Content "$root\install.log" -Raw
$config = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$log.Contains($config.token)
```

Expected `False`. If `True`, stop and record — the token has reached the log.

---

## 8. Phase 4 — configuration, token and ACLs

### 8.1 Configuration content (never print the token)

```powershell
$root = "$env:LOCALAPPDATA\Synapse\TallyConnector"
$config = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$config | Select-Object version, allowedOrigins, tallyTarget, bridgePort, company, executable, connectorVersion, installedAt, updatedAt
($config.token).Length
($config.token -match '^[0-9a-f]{64}$')
```

Expected: `version 1`; `allowedOrigins` exactly the origin you passed;
`tallyTarget.host/port` as passed; `bridgePort 17890`;
`connectorVersion 0.2.0`; length `64`; regex `True`. Record the length and
boolean only.

### 8.2 ACL

```powershell
icacls "$root\config.json"
```

Expected: inheritance removed; full control for `NT AUTHORITY\SYSTEM`; read/write
for `<COMPUTER>\<you>` or `<DOMAIN>\<you>`; **no** `BUILTIN\Users`,
`Authenticated Users`, `Everyone`, or inherited entries.

Any other entry is a finding (F6/F7 in the audit): stop and record it.

### 8.3 Recover the token when needed

```powershell
& "$root\scripts\Start-SynapseTallyConnector.ps1" -ShowToken
```

Expected: the two lines beginning `Copy this token into the portal:` and
`It is shown here only and is never written to a log.`

Treat the token as a secret. Do not put it in the evidence file, a screenshot,
a ticket or a chat message.

---

## 9. Phase 5 — Tally's side

### 9.1 Confirm the edition and version

```powershell
Get-ChildItem 'C:\Program Files\TallyPrime\tally.exe', 'C:\Program Files (x86)\TallyPrime\tally.exe', `
  'C:\Tally.ERP9\tally.exe', 'C:\Program Files\Tally.ERP9\tally.exe' `
  -ErrorAction SilentlyContinue |
  Select-Object FullName, @{n='ProductVersion';e={$_.VersionInfo.ProductVersion}}, LastWriteTime
```

Also record **Help → About** from inside Tally. The bridge's
`edition` string (`prime` / `erp9` / `unknown`) is derived from the executable
path, not from Tally — the About box is the authoritative version.

### 9.2 Open the company and enable the gateway

1. Start Tally and sign in **as a user who can open the test company**.
2. Open exactly the test company. Leave it open.
3. Enable the HTTP/XML server on port 9000:
   - TallyPrime: `F1` → Settings → Connectivity (label varies by release).
   - Tally.ERP 9: `F1` → Settings → Advanced Configuration.
   If your build's menu does not match, use Tally's own documentation for that
   release. Do not guess a setting name and do not change anything else.
4. Re-run §5.1 and §5.3. Nothing in the run may proceed while the listener is
   not loopback-only.

### 9.3 Re-run the port checks

```powershell
Get-NetTCPConnection -State Listen -LocalPort 9000 |
  Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
Test-NetConnection -ComputerName $lan -Port 9000 -InformationLevel Detailed |
  Select-Object RemotePort, TcpTestSucceeded
```

Expected: loopback address(es) only; `TcpTestSucceeded : False`.

---

## 10. Phase 6 — start the bridge and prove health

### 10.1 Start it, with a transcript

Preferred for the first run, so the console is captured:

```powershell
Start-Transcript -Path "$env:USERPROFILE\Desktop\synapse-test-transcript.txt"
& "$env:LOCALAPPDATA\Synapse\TallyConnector\scripts\Start-SynapseTallyConnector.ps1"
```

(The Start Menu shortcut does the same without the transcript. **Leave this
window open**; closing it ends the bridge.)

Expected: the five launcher lines, the token line, then the four bridge lines
quoted in [TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md)
§4. A stack trace instead means configuration was rejected; the message names
the rule, and §12 lists them.

The transcript now contains the token. Redact the line beginning
`Copy this token into the portal:` before storing or sharing it.

### 10.2 The bridge must listen on loopback only

In a second window:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 17890 |
  Select-Object LocalAddress, LocalPort, OwningProcess | Format-Table -AutoSize
```

Expected: exactly `127.0.0.1`, port `17890`. Any `0.0.0.0` or `::` row is
**STOP (S2)** — that is a security defect, not a configuration choice.

### 10.3 Status, companies and the prerequisite report

```powershell
$root = "$env:LOCALAPPDATA\Synapse\TallyConnector"
$config = Get-Content "$root\config.json" -Raw | ConvertFrom-Json
$headers = @{
  Origin = @($config.allowedOrigins)[0]
  "x-synapse-tally-bridge-token" = $config.token
}

Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/status" -Headers $headers |
  ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/companies" -Headers $headers |
  ConvertTo-Json -Depth 5

$report = Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/preflight" -Headers $headers
$report.summary | ConvertTo-Json -Depth 5
$report.checks | Select-Object id, status, required, message | Format-Table -AutoSize
```

Expected: `bridge: "ok"`, `tally: "reachable"`, `target` matching config,
`company` the pinned name; `companies` containing the open company;
`summary.ready true`, `summary.blocking []`, `connector.contractVersion 2`.

Also run the leak checks required by S5:

```powershell
$raw = $report | ConvertTo-Json -Depth 10
$raw.Contains($config.token)                 # must be False
$raw -match '<ENVELOPE|<TALLYMESSAGE|<VOUCHER|<LEDGER'   # must be False
```

The report is the same one the portal's **Check My Computer** reads; running it
here separates a connector fault from a page fault.

### 10.4 Negative controls (two minutes, worth doing once)

Prove the gates are real on this machine:

```powershell
# no token
try { Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/status" -Headers @{ Origin = $headers.Origin } }
catch { $_.Exception.Response.StatusCode.value__ }        # expect 401

# wrong origin, correct token
try { Invoke-RestMethod -Uri "http://127.0.0.1:17890/api/tally/status" -Headers @{ Origin = "https://evil.example"; "x-synapse-tally-bridge-token" = $config.token } }
catch { $_.Exception.Response.StatusCode.value__ }        # expect 403

# body on the export endpoint
try { Invoke-WebRequest -Method Post -Uri "http://127.0.0.1:17890/api/tally/export" -Headers $headers -Body '{"x":1}' -ContentType "application/json" }
catch { $_.Exception.Response.StatusCode.value__ }        # expect 400
```

Record the three numbers. If any is not 401/403/400, stop and record a
security finding.

---

## 11. Phase 7 — company discovery and pinning

Discovery is already in §10.3. Pinning matters because **the bridge reads the
pin at start-up only**.

Pin through the portal's Connect Tally screen (it produces a command like the
one below), or directly:

```powershell
# stop first: the running process keeps the old pin
& "$env:LOCALAPPDATA\Synapse\TallyConnector\scripts\Start-SynapseTallyConnector.ps1" -Stop
& "$env:LOCALAPPDATA\Synapse\TallyConnector\scripts\Start-SynapseTallyConnector.ps1" -Company "SYNAPSE TEST COMPANY"
```

A company name containing `'`, `$` or a backtick is quoted safely by the page
(apostrophes doubled) or dropped if it carries a control character. If the pin
command does not appear, record why instead of hand-writing a command.

Two behaviours to know before you rely on this:

- The launcher's `-Company` applies to the process it starts. It does **not**
  rewrite `config.json`, so a later Start Menu start returns to the company
  written at install time. A pin that must survive a restart is set by
  re-running the installer with `-Company` (the token is kept).
- Run the pin command **while the connector is stopped**. If the bridge is
  already running, the launcher prints
  `The connector is already running (process N).` and changes nothing — the old
  company stays pinned and the export will keep using it.

Confirm:

```powershell
& "$env:LOCALAPPDATA\Synapse\TallyConnector\scripts\Start-SynapseTallyConnector.ps1" -Status
```

Expected `Company:` the pinned name, exit 0.

---

## 12. Phase 8 — one guarded, dated, read-only export

This is the most informative step. It asks Tally for one month of vouchers and
writes nothing anywhere.

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

Expected: `200`, `20261001`, `20261031`, the pinned company, `opening`,
`vouchers`, and a non-zero byte count.

These echoes state what the bridge **sent**, not what Tally returned. Then
inspect what Tally actually put in the answer:

```powershell
$r.Content | Select-String -Pattern '<COMPANYNAME>|<COMPANY |SVFROMDATE|SVTODATE' -AllMatches |
  ForEach-Object { $_.Matches.Value } | Select-Object -Unique
```

Record the result verbatim. No company element means the bridge will refuse the
payload (`TALLY_BRIDGE_COMPANY_UNVERIFIED`) — by design. No period element is a
question for [TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md), not a
reason to edit anything.

Do not save the XML to disk. It carries the test company's books; the evidence
is the headers, the company/period match and the byte count.

If the export fails, use the code table in
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md) §5
rather than guessing, and record the code verbatim.

---

## 13. Phase 9 — portal extraction, one company, one month

Route B only (§0.2). Decide the portal before starting; the bridge's allowed
origin must be that portal's exact origin.

1. Open the Tally cut-over page in the portal.
2. Enter the token, the Tally host and port, the company and the period
   `2026-10-01` – `2026-10-31`.
3. **Check bridge** must report ready and list the company.
4. Choose **Opening balances and history**.
5. **Connect and review**.

Expected: `Extraction — 2 of 2 ranges read`, ranges failed `0`, a non-zero
record count, then the review with an **unverified** coverage panel.

"2 of 2" is the count for this one-month period: one masters range plus one
voucher range. A longer period splits into more voucher ranges
(`defaultParts` is `ceil(days / 31)`), so the totals grow with the period;
what matters is that the two numbers are equal and ranges failed is `0`.

**Stop here.** Do not acknowledge the panel. Do not press Apply. Record:

- `GET /api/admin/tally/<sessionId>` → `extraction`, `consolidation`,
  `manifest` (save the JSON; it contains no Tally XML and no token);
- the voucher count, per-type totals, and first/last voucher date.

The session JSON is the authoritative record of what the server read; the screen
is a rendering of it.

### 13.1 Reconciliation against Tally

Open Tally's own Day Book for the same month and compare, by hand:

| Check | SYNAPSE value | Tally value | Match |
|---|---|---|---|
| Voucher count (`consolidation.vouchers.unique`) | | | |
| Totals per voucher type (`consolidation.totals`) | | | |
| First and last voucher date (`consolidation.dates`) | | | |

Differences are findings. "Close enough" is not a result. If a voucher falls
outside the requested month, a chunk should have failed
(`TALLY_CHUNK_DATES_OUTSIDE`) — record the code.

---

## 14. Phase 10 — shutdown

```powershell
# in the bridge window, if you started it directly
Ctrl+C
Stop-Transcript
```

Or:

```powershell
& "$env:LOCALAPPDATA\Synapse\TallyConnector\scripts\Start-SynapseTallyConnector.ps1" -Stop
Get-NetTCPConnection -State Listen -LocalPort 17890 -ErrorAction SilentlyContinue
```

Expected: `Stopped the connector (process N).`; the final command prints
nothing. Closing Tally afterwards must change nothing in SYNAPSE — no part of
the portal depends on Tally being up (this run does not prove that; §0.4).

If the window is unresponsive, prefer `-Stop`; only then identify and end
`node` by pid from `Get-Process node`.

---

## 15. Phase 11 — repair, rotation and uninstall

### 15.1 Repair (token kept)

```powershell
cd C:\SynapseTest\apps\tally-bridge\scripts
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -VerifyOnly
```

Expected: the same check report, exit 0 when ready. `-VerifyOnly` changes
nothing; it requires an existing install.

### 15.2 Rotation (token replaced)

Only with the owner's approval, because every portal session holding the old
token must be updated:

```powershell
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -Force -PortalOrigin https://pharm.synapseos.tech -Company "SYNAPSE TEST COMPANY"
```

Expected: `Replacing the existing configuration because -Force was given.` and a
**new** token. Paste it into the portal before using it.

### 15.3 Uninstall

```powershell
cd C:\SynapseTest\apps\tally-bridge\scripts
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -Uninstall
# type YES at the prompt
```

Expected console:

```
Stopped the connector (process N).
Removed shortcut Synapse Tally Connector.lnk.
Removed shortcut Synapse Tally Connector Status.lnk.
Removed shortcut Stop Synapse Tally Connector.lnk.
Removed C:\Users\<you>\AppData\Local\Synapse\TallyConnector.
Node.js was not removed. Remove it from Apps & features if no other programme needs it.
Nothing in Tally was changed.
```

If no connector was running, the first line is instead
`Nothing is listening on 127.0.0.1:17890, so there is nothing to stop.`

Verify:

```powershell
Test-Path "$env:LOCALAPPDATA\Synapse\TallyConnector"        # False
Test-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Synapse"  # False, unless another product keeps shortcuts there
node --version                                               # still 22.x
Get-NetTCPConnection -State Listen -LocalPort 17890 -ErrorAction SilentlyContinue  # nothing
```

Expected: the folder and shortcuts are gone; Node.js remains; the bridge port
is free. Tally is still running and untouched — verify the test company still
opens and its Day Book still matches the numbers recorded in §13.1.

If the uninstall refuses with `Refusing to remove … it is not a folder this
installer filled`, the folder is not the connector's; remove it by hand only
after checking what it is. Never delete a folder the guard refused.

---

## 16. Failure catalogue

### 16.1 Installer

| Message (exact prefix) | Cause | Action |
|---|---|---|
| `This installer prepares a Windows computer.` | Not Windows | Stop |
| `LOCALAPPDATA is not set…` | Unusual profile | Stop |
| `Refusing to download from … only downloads from https://nodejs.org on port 443.` | Redirected or altered URL | Stop; network tampering |
| `nodejs.org did not list a Node.js 22.x release.` | Offline or blocked | Install Node 22 by hand, re-run |
| `32-bit Windows is not supported.` | 32-bit OS | Stop |
| `Node.js … has no … package.` | Unusual build (no `win-<arch>-msi`) | Install by hand |
| `The Node.js download did not match its published SHA-256 checksum…` | Proxy/mirror | Nothing installed; retry on a clean network |
| `The Node.js installer's signature is not valid (…)` | Unsigned/tampered MSI | **Stop (S4)** |
| `The Node.js installer's signer '…' is not the Node.js Foundation…` | Wrong signer | **Stop (S4)** |
| `The Node.js installer changed after it was verified.` | File altered between checks | Stop |
| `The elevated Node.js installation did not finish (exit code N).` | UAC declined or msiexec failed | Nothing else changed; retry or install Node by hand |
| `Node.js was installed but could not be found.` | PATH not refreshed | Open a new window, re-run |
| `The connector package is incomplete: X is missing.` | Wrong directory layout (§3.1) | Repack correctly |
| `config.json could not be restricted to … (icacls exit code N).` | ACL failure | Nothing installed; record and stop |
| `The existing configuration at … could not be read.` | Corrupt config | `-Force` only with approval |
| `State the pharmacy portal origin…` / `The portal origin must be an exact HTTPS origin…` | Bad origin | Fix the argument |
| `No connector configuration exists at … yet.` | `-ShowToken` before install | Install first |
| `The connector is not installed yet, so there is nothing to verify.` | `-VerifyOnly` before install | Install first |

### 16.2 Launcher

| Message | Meaning | Action |
|---|---|---|
| `The connector is not installed here.` | Wrong folder or uninstalled | Reinstall |
| `Connector: running, but it rejected this token.` (401) | Token changed or mistyped | `-ShowToken`; paste again |
| `Connector: running, but it does not allow <origin>.` (403) | Origin mismatch | Re-run the installer with the page's exact origin |
| `Connector: not running on 127.0.0.1:17890.` | Bridge stopped | Start it |
| `Tally: not reachable at …` | Gateway off / Tally closed | §9 |
| `The connector is already running (process N).` | Second start | Use `-Status` / `-Restart` |
| `Port 17890 is held by another programme…` | Conflict | Identify the process; do not kill it blindly |
| `Node.js was not found. Run synapse-tally-connector.ps1 again.` | Node removed | Reinstall |

### 16.3 Bridge start-up

| Message | Rule broken |
|---|---|
| `SYNAPSE_TALLY_BRIDGE_TOKEN must be 64 hexadecimal characters.` | Token malformed in config |
| `SYNAPSE_TALLY_ALLOWED_ORIGINS must contain the pharmacy portal origin.` | Empty origin |
| `Allowed portal origin must be an exact HTTPS origin: …` | Path, trailing slash, or plain `http:` on a non-loopback host |
| `SYNAPSE_TALLY_TARGET_HOST must be localhost or a private LAN IP address.` | Public or malformed host |
| `Synapse Tally Bridge failed to start: …` (EADDRINUSE) | 17890 already held |

### 16.4 Export codes

`TALLY_BRIDGE_COMPANY_UNPINNED`, `_COMPANY_MISMATCH`, `_COMPANY_UNVERIFIED`,
`_PERIOD_INCOMPLETE`, `_PERIOD_INVALID`, `_FROM_DATE_INVALID`, `_TO_DATE_INVALID`,
`_SCOPE_INVALID`, `_SCOPE_CONFLICT`, `_NO_IMPORTABLE_RECORDS`,
`_EXPORT_TOO_LARGE`, `_TALLY_UNAVAILABLE`, `_TALLY_TIMEOUT`,
`_TALLY_HTTP_<status>`, and `A Tally export is already running.` (409).
Their meaning and HTTP status are tabulated in
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md) §5.
Record the code verbatim; do not paraphrase it in the evidence file.

---

## 17. Evidence handling

- Fill [TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md](./TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md)
  as you go.
- Store the transcript, screenshots and session JSON together, named
  `<yyyy-mm-dd>-<machine>-<phase>`.
- Redact before sharing: the token line in the transcript, the token in any
  screenshot, and any customer-specific company name if the test company is not
  the invented one.
- Do not attach Tally XML, Day Book exports or ledger values. The evidence is
  counts, codes, headers and timestamps.
- Keep the machine's collector copy only as long as the review needs it.

---

## 18. Exit criteria

The run is **complete** when all of the following are recorded:

1. Windows, PowerShell, architecture, clock and disk baseline (§4).
2. Port 9000 bound to loopback only, with the owning process identified, and
   `TcpTestSucceeded : False` through the LAN address (§5).
3. Installer and payload hashes matching the build machine; signature status
   recorded (§6).
4. Successful install (or a failure with the exact message), with UAC behaviour
   recorded and `install.log` free of the token (§7).
5. `config.json` values, ACL and token length recorded (§8).
6. Tally edition/version, gateway enabled, company open, company discovered and
   pinned (§9–§11).
7. A dated read-only export returning `200` with matching echo headers, and
   Tally's actual company/period elements recorded (§12).
8. Route B only: one-month extraction completed and reviewed, unacknowledged and
   unapplied, with the reconciliation numbers recorded (§13).
9. Clean shutdown and, if this was a disposable machine, a successful uninstall
   that leaves Node.js and Tally untouched (§14–§15).
10. Every stop condition encountered is named, with the phase and the message.

The run is **passed** when 1–7 and 9 hold, and — if Route B was taken — 8 holds
with no unexplained difference in the reconciliation.

A passed run authorises nothing beyond a second, scoped test. It is not
production approval, and it is not evidence for the independence criterion in
§0.4.

---

## 19. The exact commands to start the test

On the build machine — run the label-file block in §3.1 first, so `$STAGE` and
`PACKAGE_LABEL.txt` exist:

```bash
cd /home/ebrine/Desktop/SYNAPSE-OS
sha256sum apps/tally-bridge/scripts/synapse-tally-connector.ps1 \
  apps/tally-bridge/scripts/Start-SynapseTallyConnector.ps1 \
  apps/tally-bridge/scripts/tally-probe.ps1 \
  apps/tally-bridge/package.json \
  apps/tally-bridge/src/cli.mjs apps/tally-bridge/src/bridge.mjs \
  apps/tally-bridge/src/preflight.mjs apps/tally-bridge/src/check.mjs
tar -czf "$HOME/synapse-tally-test.tgz" \
  apps/tally-bridge/package.json \
  apps/tally-bridge/src/cli.mjs \
  apps/tally-bridge/src/bridge.mjs \
  apps/tally-bridge/src/preflight.mjs \
  apps/tally-bridge/src/check.mjs \
  apps/tally-bridge/scripts/synapse-tally-connector.ps1 \
  apps/tally-bridge/scripts/Start-SynapseTallyConnector.ps1 \
  apps/tally-bridge/scripts/tally-probe.ps1 \
  -C "$STAGE" PACKAGE_LABEL.txt
sha256sum "$HOME/synapse-tally-test.tgz"
```

The nine named files are the allowlist — no `.mcp.json`, no `.claude/`, no
tests. If `$HOME` is read-only, write the archive to `$TMPDIR` instead; the
verified archive for this branch was built that way
(`$TMPDIR/synapse-tally-test.tgz`, SHA-256
`fe5379b90bb11c87cc05f3b8951fdf0ee5d9b3be4f33fbc531f90ac1bdba2df9`) because
`$HOME` was not writable in the build environment.

On Windows, after transferring the archive:

```powershell
Get-FileHash .\synapse-tally-test.tgz -Algorithm SHA256
New-Item -ItemType Directory -Force -Path C:\SynapseTest | Out-Null
tar -xzf .\synapse-tally-test.tgz -C C:\SynapseTest
cd C:\SynapseTest\apps\tally-bridge\scripts
Get-FileHash .\synapse-tally-connector.ps1, .\Start-SynapseTallyConnector.ps1 -Algorithm SHA256
Get-AuthenticodeSignature .\synapse-tally-connector.ps1 | Select-Object Status
Get-NetTCPConnection -State Listen -LocalPort 9000 | Select-Object LocalAddress, LocalPort, OwningProcess
```

Only after the port check is loopback-only and the hashes match:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 `
  -PortalOrigin https://pharm.synapseos.tech `
  -Company "SYNAPSE TEST COMPANY"
```

Then start the connector:

```powershell
Start-Transcript -Path "$env:USERPROFILE\Desktop\synapse-test-transcript.txt"
& "$env:LOCALAPPDATA\Synapse\TallyConnector\scripts\Start-SynapseTallyConnector.ps1"
```

Stop immediately if any of S1–S10 in §1 is true, if the installer reports a
signature or hash failure, if the bridge binds anything but `127.0.0.1`, or if
Tally is reachable through its LAN address.
