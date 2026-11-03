import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

const INSTALLER = readFileSync(new URL("../scripts/synapse-tally-connector.ps1", import.meta.url), "utf8")
const LAUNCHER = readFileSync(
  new URL("../scripts/Start-SynapseTallyConnector.ps1", import.meta.url),
  "utf8",
)
const CLI = readFileSync(new URL("./cli.mjs", import.meta.url), "utf8")

const lines = (text) => text.split("\n")

/**
 * These are static checks on the shipped PowerShell. PowerShell does not run on
 * the machines this suite runs on, so they prove what the scripts are not
 * allowed to contain, never what they do on Windows. The Windows-only
 * assertions are listed in docs/pharmacy/TALLY_CONNECTOR_INSTALLATION.md.
 */

describe("installer download sources", () => {
  it("downloads only from nodejs.org over https", () => {
    const fetches = lines(INSTALLER).filter((line) => /Invoke-(WebRequest|RestMethod)/.test(line))
    assert.ok(fetches.length >= 3, "expected the index, checksum list and MSI downloads")

    for (const line of fetches) {
      const uri = /-Uri\s+(\S+)/.exec(line)?.[1]
      assert.ok(uri, `no -Uri on: ${line.trim()}`)
      assert.match(uri, /^\$(indexUrl|shasumsUrl|msiUrl)$/, `unexpected download target: ${uri}`)
    }

    const assignments = INSTALLER.match(/^\s*\$(indexUrl|shasumsUrl|msiUrl|versionBase)\s*=\s*.*$/gm) ?? []
    assert.equal(assignments.length, 4)
    // $versionBase is the only absolute root; the other URLs must hang off it.
    for (const assignment of assignments) {
      assert.ok(
        /https:\/\/nodejs\.org\//.test(assignment) || /"\$versionBase\//.test(assignment),
        assignment,
      )
    }
    assert.match(
      INSTALLER,
      /^\s*\$versionBase = "https:\/\/nodejs\.org\/dist\/\$\(\$release\.version\)"$/m,
    )
  })

  it("refuses a download URL that is not nodejs.org before it is fetched", () => {
    assert.match(INSTALLER, /function Assert-OfficialUrl/)
    assert.match(INSTALLER, /\$parsed\.Host -ne "nodejs\.org"/)
    const guarded = INSTALLER.match(/Assert-OfficialUrl \$\w+/g) ?? []
    assert.deepEqual(guarded.sort(), [
      "Assert-OfficialUrl $indexUrl",
      "Assert-OfficialUrl $msiUrl",
      "Assert-OfficialUrl $shasumsUrl",
    ])
  })

  it("never installs without verifying the checksum and the signature first", () => {
    const checksum = INSTALLER.indexOf("Get-FileHash")
    const signature = INSTALLER.indexOf("Get-AuthenticodeSignature")
    const install = INSTALLER.indexOf('Start-Process -FilePath "msiexec.exe"')
    assert.ok(checksum > 0 && signature > 0 && install > 0)
    assert.ok(checksum < install, "the checksum must be verified before msiexec runs")
    assert.ok(signature < install, "the signature must be verified before msiexec runs")
    assert.match(INSTALLER, /SHASUMS256\.txt/)
    assert.match(INSTALLER, /OpenJS Foundation/)
    assert.match(INSTALLER, /"\/qn", "\/norestart"/)
  })

  it("deletes a download that fails verification and installs nothing", () => {
    const rejections = INSTALLER.split("\n").filter((line) => /did not match|signature is not valid|is not the Node\.js Foundation/.test(line))
    assert.equal(rejections.length, 3)
    const removals = INSTALLER.match(/Remove-Item -Path \$msiPath -Force/gi) ?? []
    assert.equal(removals.length, 3, "each rejection must delete the MSI")
  })

  it("re-verifies the checksum inside the elevated process", () => {
    assert.match(INSTALLER, /function Install-NodePackage[\s\S]*Get-FileHash[\s\S]*msiexec/)
  })

  it("re-verifies the signature after elevation, before msiexec runs", () => {
    // The elevated half is reachable from a command line with -InstallNodeOnly,
    // so a checksum named by that caller cannot be the only thing checked.
    assert.match(
      INSTALLER,
      /function Install-NodePackage[\s\S]*Assert-NodeInstallerSignature -MsiPath \$MsiPath[\s\S]*msiexec/,
    )
    const afterElevation = INSTALLER.slice(INSTALLER.indexOf("function Install-NodePackage"))
    assert.match(afterElevation, /Get-FileHash/)
    // The signer check lives in its own helper, defined before this function.
    assert.match(INSTALLER, /Get-AuthenticodeSignature/)
  })

  it("refuses a redirect instead of following it to another origin", () => {
    const downloads = INSTALLER.split("\n").filter((line) => /Invoke-(WebRequest|RestMethod) -Uri/.test(line))
    assert.equal(downloads.length, 3)
    for (const line of downloads) {
      assert.match(line, /-MaximumRedirection 0/, `a download follows redirects: ${line.trim()}`)
    }
  })

  it("only accepts the official URL on its default port with no user info", () => {
    assert.match(INSTALLER, /\$parsed\.IsDefaultPort/)
    assert.match(INSTALLER, /\$parsed\.UserInfo/)
  })

  it("matches the signer by its organisation field, not by a substring", () => {
    assert.match(INSTALLER, /function Test-NodeSignerSubject/)
    assert.match(INSTALLER, /\$pair\.StartsWith\("O="\)/)
    assert.equal(INSTALLER.includes('$subject -notmatch "OpenJS Foundation"'), false)
  })
})

describe("installer leaves Windows alone", () => {
  const forbidden = [
    ["Defender exclusions", /Add-MpPreference|Set-MpPreference|Remove-MpPreference/],
    ["firewall rules", /New-NetFirewallRule|Set-NetFirewallRule|Enable-NetFirewallRule|Remove-NetFirewallRule/],
    ["netsh", /\bnetsh\b/],
    ["Defender disabling", /Set-MpPreference.*DisableRealtimeMonitoring/],
    ["a scheduled task", /Register-ScheduledTask|schtasks/],
    ["arbitrary code", /Invoke-Expression|\biex\b|\[scriptblock\]::Create|Invoke-Command/],
    ["a background job", /Start-Job|Register-ObjectEvent/],
  ]

  for (const [name, pattern] of forbidden) {
    it(`never issues a command for ${name}`, () => {
      assert.equal(pattern.test(INSTALLER), false, `installer contains ${pattern}`)
      assert.equal(pattern.test(LAUNCHER), false, `launcher contains ${pattern}`)
    })
  }

  it("only ever listens on loopback", () => {
    assert.match(INSTALLER, /^\$BridgePort = 17890$/m)
    assert.equal(INSTALLER.includes("0.0.0.0"), false)
    assert.match(LAUNCHER, /^\s*\$url = "http:\/\/127\.0\.0\.1:\$bridgePort\/api\/tally\/status"$/m)
    assert.match(LAUNCHER, /127\.0\.0\.1:\$bridgePort \(this computer only\)/)
  })
})

describe("installer handles secrets and existing work", () => {
  it("never writes the bridge token to the install log", () => {
    const logWrites = lines(INSTALLER).filter((line) => /Add-Log|Add-Content/.test(line) && !/function Add-Log/.test(line))
    assert.ok(logWrites.length >= 8, `only ${logWrites.length} log lines were scanned`)
    for (const line of logWrites) {
      assert.equal(/\btoken\b/i.test(line), false, `log line mentions the token: ${line.trim()}`)
      assert.equal(line.includes("$values.token"), false, line.trim())
    }
    assert.match(INSTALLER, /ShowToken/)
  })

  it("prints the token to the console and says it is not logged", () => {
    assert.match(INSTALLER, /Write-Host "Copy this token into the portal: \$\(\$values\.token\)"/)
    assert.match(INSTALLER, /nothing writes it to install\.log/)
  })

  it("keeps an existing configuration unless -Force is given", () => {
    assert.match(INSTALLER, /if \(-not \(Test-Path \$configPath\) -or \$Force\)/)
    assert.match(INSTALLER, /The existing token was kept/)
    assert.match(INSTALLER, /if \(\(Test-Path \$configPath\) -and \$Force\)/)
  })

  it("writes config.json without a byte-order mark so JSON.parse reads it", () => {
    assert.match(INSTALLER, /UTF8Encoding\(\$false\)/)
    assert.match(INSTALLER, /WriteAllText/)
  })

  it("restricts config.json to the installing account and SYSTEM", () => {
    assert.match(INSTALLER, /icacls \$Path \/inheritance:r/)
    assert.match(INSTALLER, /"SYSTEM:\(F\)"/)
  })

  it("stops when the restriction could not be applied", () => {
    const protect = INSTALLER.slice(
      INSTALLER.indexOf("function Protect-ConfigFile"),
      INSTALLER.indexOf("function Read-Config"),
    )
    assert.match(protect, /if \(\$LASTEXITCODE -ne 0\)/)
    assert.match(protect, /throw /)
  })

  it("restricts the token before it reaches the live path, and swaps it in whole", () => {
    const write = INSTALLER.slice(INSTALLER.indexOf("function Write-Config"), INSTALLER.indexOf("function New-Shortcut"))
    assert.ok(
      write.indexOf("Protect-ConfigFile -Path $temp") < write.indexOf("Move-Item -Path $temp -To $Path -Force"),
      "the temporary file must be restricted before it is moved into place",
    )
    assert.match(write, /Remove-Item -Path \$temp -Force -ErrorAction SilentlyContinue/)
  })

  it("only stops a process it can prove is this connector", () => {
    assert.match(INSTALLER, /function Stop-ConnectorProcess/)
    assert.match(INSTALLER, /Get-CimInstance Win32_Process/)
    assert.match(INSTALLER, /-notlike "\*\$expected\*"/)
    assert.match(LAUNCHER, /function Get-ConnectorProcessId/)
    assert.match(LAUNCHER, /-notlike "\*\$CliPath\*"/)
  })
})

describe("launcher", () => {
  it("reads the token from config.json and never from an argument", () => {
    assert.match(LAUNCHER, /Get-Content -Path \$path -Raw \| ConvertFrom-Json/)
    assert.equal(/\[string\]\$Token\b/.test(LAUNCHER.split("param(")[1].split(")")[0]), false)
  })

  it("logs only the connector's own output, never the token line", () => {
    const tee = lines(LAUNCHER).find((line) => line.includes("Tee-Object -FilePath $logPath"))
    assert.ok(tee)
    assert.match(tee, /& \$nodeExe \$cliPath/)
    const writes = lines(LAUNCHER).filter((line) => /Add-Content|Out-File|Set-Content/.test(line))
    assert.deepEqual(writes, [])
  })

  it("starts the connector only when the port is free", () => {
    assert.match(LAUNCHER, /The connector is already running/)
    assert.match(LAUNCHER, /is held by another programme/)
  })

  it("checks reachability with the token in a header, not the URL", () => {
    const url = LAUNCHER.match(/^\$url = .+$/m)?.[0] ?? ""
    assert.equal(url.includes("token"), false)
    assert.match(LAUNCHER, /"x-synapse-tally-bridge-token" = \$token/)
  })

  it("the connector itself never prints the token", () => {
    assert.equal(/token/i.test(CLI), false)
  })
})

describe("uninstall", () => {
  it("removes its own files and shortcuts and leaves Node.js installed", () => {
    const uninstall = INSTALLER.slice(INSTALLER.indexOf("function Uninstall-Connector"))
    assert.match(uninstall, /Remove-Item -Path \$InstallRoot -Recurse -Force/)
    assert.match(uninstall, /Node\.js was not removed/)
    assert.match(uninstall, /Nothing in Tally was changed/)
    assert.equal(/nodejs/i.test(uninstall), false, "uninstall must not touch the Node.js folder")
    assert.match(uninstall, /type YES/)
  })
})
