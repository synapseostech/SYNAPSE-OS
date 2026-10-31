import { describe, expect, it } from "vitest"
import { buildBridgeCommand } from "./bridge-command"

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

  it("drops a path that carries a quote rather than repairing it", () => {
    const command = buildBridgeCommand({
      ...base,
      executable: 'C:\\Tally\\tally.exe"; Remove-Item C:\\ #',
    })
    expect(command).not.toContain("SYNAPSE_TALLY_EXECUTABLE")
    expect(command).not.toContain("Remove-Item")
  })
})
