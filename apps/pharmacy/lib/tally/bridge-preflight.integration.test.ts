/**
 * The connector and the portal are separate packages, so the report they share
 * is checked end to end here: the bridge really runs its checks, and the page
 * really reads what came back. A shape change on either side fails this.
 */

import { describe, expect, it } from "vitest"
import {
  TALLY_BRIDGE_CONTRACT_VERSION,
  TALLY_CONNECTOR_VERSION,
  runPreflight,
} from "../../../tally-bridge/src/preflight.mjs"
import {
  MIN_BRIDGE_CONTRACT,
  blockingChecks,
  installableChecks,
  parsePrerequisiteReport,
  summariseChecks,
  withCompatibility,
} from "./bridge-preflight"

const TOKEN = "0123456789abcdef".repeat(4)
const ORIGIN = "https://pharm.synapseos.tech"
const CHECKED_AT = "2026-11-01T12:00:00.000Z"

function report(overrides: {
  nodeVersion?: string
  companies?: string[] | null
  company?: string
  tallyReachable?: boolean
} = {}) {
  return runPreflight({
    config: {
      token: TOKEN,
      allowedOrigins: new Set([ORIGIN]),
      tallyUrl: new URL("http://127.0.0.1:9000"),
      bridgePort: 17890,
      bridgeBindHost: "127.0.0.1",
      company: overrides.company ?? "Test Pharmacy",
      tallyExecutable: "",
    },
    connector: {
      version: TALLY_CONNECTOR_VERSION,
      contractVersion: TALLY_BRIDGE_CONTRACT_VERSION,
      bindHost: "127.0.0.1",
      port: 17890,
    },
    runtime: {
      nodeVersion: overrides.nodeVersion ?? "22.11.0",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cwd: "C:\\Synapse\\TallyConnector",
      installations: [{ edition: "prime", executable: "C:\\Program Files\\TallyPrime\\tally.exe" }],
      edition: "prime",
      companies: "companies" in overrides ? overrides.companies : ["Test Pharmacy"],
      companyError: null,
      tallyReachable: overrides.tallyReachable ?? true,
      connectorFiles: [
        { name: "cli.mjs", path: "/connector/src/cli.mjs", present: true },
        { name: "bridge.mjs", path: "/connector/src/bridge.mjs", present: true },
        { name: "preflight.mjs", path: "/connector/src/preflight.mjs", present: true },
        { name: "package.json", path: "/connector/package.json", present: true },
      ],
      packageJson: { version: "0.2.0", dependencies: {} },
    },
    probes: {
      platform: () => ({ platform: "win32", release: "10.0.22631", arch: "x64", type: "Windows_NT" }),
      statfs: () => ({ bavail: 1024 * 1024, bsize: 4096 }),
      fetchImpl: async () => ({ status: 200 }),
    },
    now: () => new Date(CHECKED_AT),
  })
}

describe("the bridge report and the portal reader", () => {
  it("reads a real connector report without losing a check", async () => {
    const live = await report()
    const parsed = parsePrerequisiteReport(JSON.parse(JSON.stringify(live)))

    expect(parsed).not.toBeNull()
    expect(parsed!.checks).toHaveLength(live.checks.length)
    expect(parsed!.checks.map((check) => check.id)).toEqual(live.checks.map((check) => check.id))
    expect(parsed!.checkedAt).toBe(CHECKED_AT)
    expect(parsed!.connector.contractVersion).toBe(MIN_BRIDGE_CONTRACT)
    expect(parsed!.summary.ready).toBe(true)
    expect(blockingChecks(parsed!)).toEqual([])
  })

  it("adds the portal's compatibility check and still calls a prepared computer ready", async () => {
    const parsed = withCompatibility(parsePrerequisiteReport(await report())!)

    expect(parsed.checks.at(-1)?.id).toBe("portal_compatibility")
    expect(parsed.checks.at(-1)?.status).toBe("passed")
    expect(parsed.checks).toHaveLength(18)
    expect(parsed.summary.ready).toBe(true)
  })

  it("keeps a real failure blocking on both sides", async () => {
    const live = await report({ tallyReachable: false, companies: null })
    const parsed = withCompatibility(parsePrerequisiteReport(JSON.parse(JSON.stringify(live)))!)

    expect(live.summary.blocking.sort()).toEqual(parsed.summary.blocking.sort())
    expect(parsed.summary.ready).toBe(false)
    expect(parsed.summary.blocking).toContain("tally_port")
  })

  it("offers the installer for an old runtime and nothing else", async () => {
    const parsed = withCompatibility(parsePrerequisiteReport(await report({ nodeVersion: "18.20.0" }))!)

    expect(installableChecks(parsed).map((check) => check.id)).toEqual(["node_version"])
    expect(summariseChecks(parsed.checks).ready).toBe(false)
  })

  it("still carries no token or Tally XML once the portal has read it", async () => {
    const parsed = withCompatibility(parsePrerequisiteReport(await report())!)
    const serialised = JSON.stringify(parsed)

    expect(serialised.includes(TOKEN)).toBe(false)
    expect(/<ENVELOPE|<TALLYMESSAGE|<COMPANY\b/i.test(serialised)).toBe(false)
  })
})
