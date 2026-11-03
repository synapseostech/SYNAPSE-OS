import { describe, expect, it } from "vitest"
import { buildBridgeCommand, buildCompanyPinCommand, buildConnectorInstallCommand } from "./bridge-command"

const base = {
  origin: "https://pharm.synapseos.tech",
  host: "127.0.0.1",
  port: "9000",
  executable: "",
  fromDate: "",
}

describe("buildBridgeCommand", () => {
  it("generates a token locally and prints it for the portal", () => {
    const command = buildBridgeCommand(base)
    expect(command).toContain("RandomNumberGenerator]::Create()")
    expect(command).toContain('$env:SYNAPSE_TALLY_BRIDGE_TOKEN = -join')
    expect(command).toContain("Copy this token into the portal")
  })

  it("always carries the origin, host and port", () => {
    const command = buildBridgeCommand(base)
    expect(command).toContain('$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "https://pharm.synapseos.tech"')
    expect(command).toContain('$env:SYNAPSE_TALLY_TARGET_HOST = "127.0.0.1"')
    expect(command).toContain('$env:SYNAPSE_TALLY_TARGET_PORT = "9000"')
  })

  it("omits the optional lines when they are blank", () => {
    const command = buildBridgeCommand(base)
    expect(command).not.toContain("SYNAPSE_TALLY_EXECUTABLE")
    expect(command).not.toContain("SYNAPSE_TALLY_FROM_DATE")
    expect(command).not.toContain("SYNAPSE_TALLY_TO_DATE")
  })

  it("pins the closing date when one is given", () => {
    const command = buildBridgeCommand({ ...base, toDate: "20260331" })
    expect(command).toContain('$env:SYNAPSE_TALLY_TO_DATE = "20260331"')

    const rejected = buildBridgeCommand({ ...base, toDate: "31/03/2026" })
    expect(rejected).not.toContain("SYNAPSE_TALLY_TO_DATE")
  })

  it("keeps a quoted Windows path and an eight-digit start date", () => {
    const command = buildBridgeCommand({
      ...base,
      host: "192.168.1.20",
      port: "9001",
      executable: "C:\\Program Files\\TallyPrime\\tally.exe",
      fromDate: "20200401",
    })
    expect(command).toContain('$env:SYNAPSE_TALLY_EXECUTABLE = "C:\\Program Files\\TallyPrime\\tally.exe"')
    expect(command).toContain('$env:SYNAPSE_TALLY_FROM_DATE = "20200401"')
    expect(command).toContain('$env:SYNAPSE_TALLY_TARGET_HOST = "192.168.1.20"')
    expect(command).toContain('$env:SYNAPSE_TALLY_TARGET_PORT = "9001"')
  })

  it("falls back on values the bridge would reject", () => {
    const command = buildBridgeCommand({
      ...base,
      origin: "",
      host: "127.0.0.1; Remove-Item C:\\",
      port: "ninety",
      fromDate: "2020-04-01",
    })
    expect(command).toContain('$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "https://pharm.synapseos.tech"')
    expect(command).toContain('$env:SYNAPSE_TALLY_TARGET_HOST = "127.0.0.1"')
    expect(command).toContain('$env:SYNAPSE_TALLY_TARGET_PORT = "9000"')
    expect(command).not.toContain("SYNAPSE_TALLY_FROM_DATE")
    expect(command).not.toContain("Remove-Item")
  })

  it("pins the company the operator picked", () => {
    const command = buildBridgeCommand({ ...base, company: "Nakawa Pharmacy & Sons" })
    expect(command).toContain('$env:SYNAPSE_TALLY_COMPANY = "Nakawa Pharmacy & Sons"')
  })

  it("omits the company when it is blank or carries a quoting character", () => {
    expect(buildBridgeCommand(base)).not.toContain("SYNAPSE_TALLY_COMPANY")
    for (const company of ['Bad " Co', "Bad $Co", "Bad `Co", "Bad\nCo"]) {
      expect(buildBridgeCommand({ ...base, company })).not.toContain("SYNAPSE_TALLY_COMPANY")
    }
  })

  it("drops a path that carries a quote rather than repairing it", () => {
    const command = buildBridgeCommand({
      ...base,
      executable: 'C:\\Tally\\tally.exe"; Remove-Item C:\\ #',
    })
    expect(command).not.toContain("SYNAPSE_TALLY_EXECUTABLE")
    expect(command).not.toContain("Remove-Item")
  })
})

// These two commands are pasted into PowerShell by an operator, and the
// company name in them comes from Tally rather than from this page.

describe("buildConnectorInstallCommand", () => {
  it("names the installer, the page's origin and the company", () => {
    const command = buildConnectorInstallCommand({
      origin: "https://pharm.synapseos.tech",
      company: "Nakawa Pharmacy",
    })

    expect(command).toBe(
      "powershell -ExecutionPolicy Bypass -File .\\synapse-tally-connector.ps1 -PortalOrigin https://pharm.synapseos.tech -Company 'Nakawa Pharmacy'",
    )
  })

  it("omits -Company when Tally has not named one", () => {
    const command = buildConnectorInstallCommand({ origin: "https://pharm.synapseos.tech" })
    expect(command).not.toContain("-Company")
  })

  it("doubles an apostrophe so the literal cannot end early", () => {
    const command = buildConnectorInstallCommand({
      origin: "https://pharm.synapseos.tech",
      company: "Nakawa O'Brien & Sons",
    })

    expect(command).toContain("-Company 'Nakawa O''Brien & Sons'")
    // Four apostrophes: the opening, the doubled one, and the closing.
    expect(command.split("'").length - 1).toBe(4)
  })

  it("keeps PowerShell metacharacters literal inside the quoted name", () => {
    const hostile = 'Nakawa $(Remove-Item C:\\) `Stop-Process` ; & "x" \\'
    const command = buildConnectorInstallCommand({
      origin: "https://pharm.synapseos.tech",
      company: hostile,
    })

    expect(command).toContain(`-Company '${hostile}'`)
    // Exactly the two apostrophes of the literal: nothing in the name closed
    // the quoting, so every metacharacter above is inert text.
    expect(command.split("'").length - 1).toBe(2)
    expect(command).not.toContain('-Company "')
  })

  it("drops a name it cannot quote safely instead of repairing it", () => {
    for (const company of ["Nakawa\u0007Pharmacy", "Nakawa\nPharmacy", "a".repeat(201)]) {
      const command = buildConnectorInstallCommand({
        origin: "https://pharm.synapseos.tech",
        company,
      })
      expect(command).not.toContain("-Company")
    }
  })

  it("keeps an http localhost origin but refuses anything else it cannot vouch for", () => {
    expect(buildConnectorInstallCommand({ origin: "http://localhost:3002" })).toContain(
      "-PortalOrigin http://localhost:3002",
    )
    expect(buildConnectorInstallCommand({ origin: "http://127.0.0.1:3002" })).toContain(
      "-PortalOrigin http://127.0.0.1:3002",
    )

    for (const origin of [
      "https://pharm.synapseos.tech/",
      "https://pharm.synapseos.tech; Remove-Item C:\\",
      "javascript:alert(1)",
      "http://pharm.synapseos.tech",
      "file:///C:/Windows",
      "",
    ]) {
      const command = buildConnectorInstallCommand({ origin })
      expect(command).toContain("-PortalOrigin <this page's origin>")
      expect(command).not.toContain("Remove-Item")
      expect(command).not.toContain("javascript:")
    }
  })
})

describe("buildCompanyPinCommand", () => {
  it("runs the installed start script and names the company once", () => {
    const command = buildCompanyPinCommand("Nakawa Pharmacy")

    expect(command).toBe(
      '& "$env:LOCALAPPDATA\\Synapse\\TallyConnector\\scripts\\Start-SynapseTallyConnector.ps1" -Company \'Nakawa Pharmacy\'',
    )
  })

  it("doubles an apostrophe in the pinned name", () => {
    const command = buildCompanyPinCommand("Nakawa O'Brien")
    expect(command).toContain("-Company 'Nakawa O''Brien'")
    // Opening, the doubled pair and closing: four apostrophes, five parts.
    expect(command?.split("'").length ?? 0).toBe(5)
  })

  it("keeps an expansion-looking name literal", () => {
    const command = buildCompanyPinCommand("Nakawa $env:PATH `whoami`")
    expect(command).toContain("-Company 'Nakawa $env:PATH `whoami`'")
    // Outside the quoted literal there is no "$" for PowerShell to expand.
    const quoted = command === null ? "" : command.slice(command.indexOf(" -Company '"))
    expect(quoted).toBe(" -Company 'Nakawa $env:PATH `whoami`'")
  })

  it("returns null when there is no name it can quote safely", () => {
    for (const company of ["", "   ", "Nakawa\u0000Pharmacy", "Nakawa\rPharmacy", "a".repeat(201)]) {
      expect(buildCompanyPinCommand(company)).toBeNull()
    }
  })
})
