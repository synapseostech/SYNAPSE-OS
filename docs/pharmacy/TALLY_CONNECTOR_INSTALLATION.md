# Tally Connector — installation and setup assistant

Companion to [TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md),
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md) and
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md).

This describes the one-installer setup path for a pharmacy computer, the six
screens the portal shows while it runs, and what each step actually verifies.

> **Status.** Everything here is implemented in this repository and the
> non-Windows parts were executed (see §11). **The PowerShell has not been run on
> Windows.** No real Tally installation has been inspected, and no customer data
> has been read. Where Windows or Tally behaviour is assumed, the text says so.

---

## 1. What the connector is

One Node.js process on the pharmacy computer. It:

- listens on `127.0.0.1:17890` only — never on a LAN address, never on `0.0.0.0`;
- accepts requests only from one exact portal origin and only with its own
  256-bit token;
- asks Tally's local XML/HTTP server (default `127.0.0.1:9000`) for
  **All Masters** and the **Day Book**, over date ranges, and streams the XML to
  the portal;
- writes nothing to Tally, its data files or its configuration, and cannot type
  a Tally password or change the open company.

It is the same bridge the portal already used; the setup assistant is a new
read-only endpoint (`GET /api/tally/preflight`) plus the installer. There is no
second connector.

The connector does **not**:

- upload anything during setup — the checks run on the pharmacy computer and
  return a report, not company data;
- log or return the bridge token, raw Tally XML, or voucher values;
- change Windows Defender, the firewall, DNS, or any network setting;
- open port 9000, 17890, or anything else to the network;
- install Git, Python, Docker, VS Code, the Supabase CLI or Claude Code.

---

## 2. Supported computers

| | Requirement |
|---|---|
| Windows | 10 or 11, 64-bit (x64 or ARM64) |
| Node.js | **22.x**, installed by the installer when missing |
| PowerShell | 5.1 or later (built into Windows) |
| Tally | TallyPrime or Tally.ERP 9, with its HTTP/XML server enabled |
| Disk | 250 MB free where the connector is installed |
| Network | Outbound HTTPS to `nodejs.org` during installation only; the bridge itself only talks to Tally and to the portal |

32-bit Windows is refused by the installer rather than half-supported. A
Windows build older than 10 is reported as a warning, not a block — the
connector is not tested there, and the operator decides.

---

## 3. Getting the installer

The installer is `apps/tally-bridge/scripts/synapse-tally-connector.ps1`. It is a
single script with no external modules. Copy it to the pharmacy computer
together with the connector folder it installs (`apps/tally-bridge`), or run it
from a checkout. It never fetches code from anywhere except `nodejs.org`.

> **Not yet published.** This repository does not yet ship a signed `.exe` or a
> code-signed `.ps1`. If your Windows policy blocks unsigned scripts, sign it
> with your organisation's certificate before distribution, or run it with
> `-ExecutionPolicy Bypass -File`.

---

## 4. Installing

From PowerShell **in the folder that holds the script and `apps/tally-bridge`**:

```powershell
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -PortalOrigin https://pharm.synapseos.tech -Company "Nakawa Pharmacy"
```

- `-PortalOrigin` is the exact origin of the portal that will read Tally. HTTPS,
  no path, no trailing slash. `http://localhost:3002` is accepted for local
  development.
- `-Company` is optional but recommended: it pins the company so every export
  names it. The portal's setup assistant can pin it later as well.
- `-TallyHost` / `-TallyPort` default to `127.0.0.1` / `9000`.
- `-TallyExecutable` is optional. The bridge launches Tally only when nothing
  answers on the port.

What it does, in order:

1. Refuses to run on anything but Windows, and creates
   `%LOCALAPPDATA%\Synapse\TallyConnector`.
2. Looks for Node.js. If it finds **22.x** it uses it. If it finds a newer major
   it warns and keeps it rather than downgrading. If it finds an older major or
   nothing, it installs 22.x:
   - reads `https://nodejs.org/dist/index.json` and picks the current 22.x;
   - downloads the `win-x64-msi` (or `win-arm64-msi`) package;
   - verifies its **SHA-256** against `SHASUMS256.txt` from the same version;
   - verifies the **Authenticode** signature (`OpenJS Foundation` /
     `Node.js Foundation`) and that it is `Valid`;
   - deletes the download and stops if either check fails;
   - runs `msiexec /i … /qn /norestart`, asking Windows for elevation once if
     needed. Exit code `3010` (reboot required) is accepted.
3. Copies the connector files into `%LOCALAPPDATA%\Synapse\TallyConnector`.
4. Writes `config.json` with a freshly generated 64-hex-character token, the
   portal origin, the Tally target, the company and the connector version.
   The file is restricted with `icacls` to the installing account and `SYSTEM`.
   An existing `config.json` is **kept** unless `-Force` is given, so repairing
   does not invalidate a token the portal already holds.
5. Creates three Start Menu shortcuts under **Synapse**:
   **Synapse Tally Connector**, **… Status** and **Stop Synapse Tally Connector**.
6. Runs the same prerequisite checks the portal runs and prints them. The exit
   code is `0` only when every required check passed.
7. Prints the token **once**, to the console. It is never written to
   `install.log`.

Everything it decides is appended to
`%LOCALAPPDATA%\Synapse\TallyConnector\install.log` — versions, hashes,
signature subject, shortcuts, and failures. The token is not in that file.

---

## 5. Day-to-day use

| Action | How |
|---|---|
| Start | Start Menu → **Synapse Tally Connector**, or `Start-SynapseTallyConnector.ps1` |
| Health | Start Menu → **Synapse Tally Connector Status**, or `… -Status` |
| Stop | Start Menu → **Stop Synapse Tally Connector**, or `… -Stop` |
| Restart | `… -Restart` |
| Prerequisite report | `… -Verify` |
| Show the token again | `start` script with `-ShowToken` |
| Pin a different company | `… -Company "Other Pharmacy"` |
| Repair / update | run the installer again (the token and origin are kept) |
| Force a new token | run the installer with `-Force`, then paste the new token into the portal |

The start window must stay open while Tally is bridged; `Ctrl+C` stops the
connector. Its output is appended to `logs\bridge-YYYYMMDD.log`, which contains
the listening address, the Tally target, the allowed origin and any errors — no
token and no XML.

`-Status` prints whether the connector is running, whether Tally answers, the
edition, the pinned company and the period, and exits non-zero if Tally is not
reachable.

`-Stop` only stops a process whose command line names this connector's
`src\cli.mjs`. If the port is held by anything else it says so and leaves it
alone.

---

## 6. Tally's side

The connector cannot turn on Tally's HTTP server for you.

1. Open Tally, sign in, and load the company.
2. Enable the HTTP/XML server on port 9000 (**F1 → Settings → Connectivity**, or
   the gateway of your edition). The menu path differs between TallyPrime
   releases — check Tally's own documentation for your version.
3. Leave Tally running with the company open while the portal reads it.

The connector never types a Tally password, chooses a company, or edits Tally's
settings.

---

## 7. The setup assistant in the portal

Open **Tally cut-over** in the portal and choose **Set up Tally connection**. The
six screens are:

| Screen | What it does |
|---|---|
| **A. Welcome** | Explains the setup and takes the token the connector printed. **Check My Computer** asks the bridge to run its checks. |
| **B. System check** | Shows every check, grouped: needs attention, warnings, passed, not needed here. Each failure carries its measured value and what to do. |
| **C. Install** | Lists what the installer can repair, what you must do yourself, and the exact installer command for this portal origin. |
| **D. Verify** | Runs the same checks again. Continue is offered only when every required check passes. |
| **E. Connect Tally** | Host and port, company discovery from Tally's open companies, and the one-line command that pins the selected company. |
| **F. Ready** | Connector version and contract, Tally target, company, and the time of the last check, then **Continue to Tally Data Extraction**. |

Finishing the assistant fills in the same fields Step 1 uses, so nothing is
retyped. It never starts an extraction, and it never presses Apply.

Every check has the same shape: `id`, `name`, `status`, `required`,
`detectedVersion`, `requiredVersion`, `message`, `remediation`, `canAutoFix`,
`requiresAdministrator`, `evidence`, `lastCheckedAt`. A check blocks only when
`required` is true **and** its status is `missing`, `failed` or `blocked`.
`warning` and `not_applicable` never block.

The checks, in order:

`windows`, `architecture`, `node_version`, `system_clock`, `disk_space`,
`connector_files`, `connector_dependencies`, `bridge_binding`, `bridge_token`,
`allowed_origin`, `tally_installation`, `tally_port`, `tally_service`,
`tally_company_open`, `tally_company_pinned`, `portal_https`,
`connector_read_only`, then `portal_compatibility` added by the page itself.

---

## 8. Security model

| Control | How it is enforced |
|---|---|
| Loopback only | `TALLY_BRIDGE_BIND_HOST` is a constant (`127.0.0.1`); `bridge_binding` fails if the running address is anything else. No environment variable can change it. |
| One origin | `SYNAPSE_TALLY_ALLOWED_ORIGINS` must be exact; requests without a matching `Origin` get `403` before the token is read. |
| Token | 64 hex characters, compared with `timingSafeEqual`. Sent in `x-synapse-tally-bridge-token`, never in a URL. |
| No token in the report | The preflight reports `{ tokenConfigured: boolean }` and nothing else. |
| No Tally XML in the report | Only company **counts** and error codes leave the bridge during a check. |
| No writes to Tally | The only Tally requests the bridge can make are `List of Companies`, `All Masters` and `Day Book`. There is no write path in the code. |
| Installer downloads | HTTPS from `nodejs.org` only, SHA-256 and Authenticode verified before `msiexec`. |
| Installer side effects | No firewall, Defender, DNS or network commands; the static test in §11 asserts their absence. |
| Config file | `config.json` is ACL-restricted to the installing account and `SYSTEM`. |

The token is a bearer credential for a loopback service: anyone who can run code
on that computer can use it. It is not a substitute for the portal's own login.

---

## 9. Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -Uninstall
```

It stops the connector (only if the process is provably its own), removes the
three shortcuts and `%LOCALAPPDATA%\Synapse\TallyConnector`, and leaves Node.js
installed. Nothing in Tally is touched. To remove Node.js as well, use **Apps &
features**.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The connector is not running on 127.0.0.1:17890` | The start shortcut is not running, or it exited | Start it from the Start Menu; read `logs\bridge-*.log` |
| `The bridge is running, but it did not accept this token` | Token from a previous install, or a `-Force` reinstall | Use `-ShowToken` on the start script, or run the installer with `-Force` and paste the new token |
| `The bridge does not allow this page's origin` | The portal origin differs from `-PortalOrigin` | Re-run the installer with the correct origin (token kept) |
| `Tally port` is `missing` | Tally is closed, or its HTTP server is off | Open Tally and enable the HTTP/XML server on 9000 |
| `Open company` is `missing` | Tally is running with no company loaded | Load the company, then check again |
| `Company pinned` is `failed` | The pin names a company Tally does not have open | Select an open company in screen E and run the pin command |
| `Node.js 18.x` fails | The packaged runtime is 22.x | Re-run the installer; it replaces older majors |
| `The Node.js installer's signature is not valid` | A proxy or mirror altered the download | Nothing was installed; retry on a network that reaches `nodejs.org` directly |
| Port 17890 held by another programme | Another connector is already running | Stop it, or change `SYNAPSE_TALLY_BRIDGE_PORT` for that instance |

---

## 11. What has been executed, and what has not

Executed on Linux, Node v24.22.2, from this working tree:

| Suite | Command | Result |
|---|---|---|
| Prerequisite engine | `node --test src/preflight.test.mjs` | 20 passed |
| Installer invariants (static) | `node --test src/installer.test.mjs` | 31 passed |
| Bridge, including the preflight endpoint and the security suites | `node --test src/*.test.mjs` | 126 passed, 1 skipped (Windows-only), 0 failed |
| Portal reader | `npx vitest run lib/tally/bridge-preflight.test.ts` | 13 passed |
| Connector↔portal contract | `npx vitest run lib/tally/bridge-preflight.integration.test.ts` | 5 passed |
| Types | `npx tsc --noEmit` | clean |
| Lint | `npx eslint …` | clean |

The installer test reads the shipped PowerShell and asserts what it may not
contain: non-`nodejs.org` downloads, missing checksum or signature verification,
Defender or firewall commands, `netsh`, scheduled tasks, `Invoke-Expression`,
non-loopback addresses, and the token in the log. That proves the text of the
script; it does not prove Windows behaviour.

**Not executed anywhere:** the installer on Windows, the Start Menu shortcuts,
UAC elevation, `msiexec`, Tally discovery, and the six screens in a browser
(a working portal session needs an authenticated database this session was not
allowed to contact). §12 lists the Windows-only evidence still owed.

---

## 12. Windows evidence still owed

Record the result of each item in
[TALLY_WINDOWS_INTEGRATION_TEST.md](./TALLY_WINDOWS_INTEGRATION_TEST.md) when the
first Windows run happens:

1. Installer run on a machine **without** Node.js — hash and signature lines in
   `install.log`, elevation prompt, installed version.
2. Installer run on a machine **with** Node.js 22 — no download, config kept.
3. Re-run after `-Force` — new token accepted by the portal.
4. All three shortcuts start, report status and stop the right process.
5. `-Uninstall` removes the folder and shortcuts and leaves Node.js.
6. A blocked download (wrong hash, unsigned copy) installs nothing.
7. The six screens against real TallyPrime and Tally.ERP 9, including company
   discovery and pinning.
8. The first full extraction after setup, reviewed but not applied.
