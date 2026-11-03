import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  checkResult,
  runPreflight,
  summariseChecks,
  TALLY_BRIDGE_CONTRACT_VERSION,
  TALLY_CONNECTOR_VERSION,
} from "./preflight.mjs"

const TOKEN = "0123456789abcdef".repeat(4)
const ORIGIN = "https://pharm.synapseos.tech"

const CONNECTOR_FILES = [
  { name: "cli.mjs", path: "/connector/src/cli.mjs", present: true },
  { name: "bridge.mjs", path: "/connector/src/bridge.mjs", present: true },
  { name: "preflight.mjs", path: "/connector/src/preflight.mjs", present: true },
  { name: "package.json", path: "/connector/package.json", present: true },
]

function baseInput(overrides = {}) {
  return {
    config: {
      token: TOKEN,
      allowedOrigins: new Set([ORIGIN]),
      tallyUrl: new URL("http://127.0.0.1:9000"),
      bridgePort: 17890,
      bridgeBindHost: "127.0.0.1",
      company: "Test Pharmacy",
      tallyExecutable: "",
      ...(overrides.config ?? {}),
    },
    connector: {
      version: TALLY_CONNECTOR_VERSION,
      contractVersion: TALLY_BRIDGE_CONTRACT_VERSION,
      bindHost: "127.0.0.1",
      port: 17890,
      ...(overrides.connector ?? {}),
    },
    runtime: {
      nodeVersion: "22.11.0",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      cwd: "C:\\Synapse\\TallyConnector",
      installations: [{ edition: "prime", executable: "C:\\Program Files\\TallyPrime\\tally.exe" }],
      edition: "prime",
      companies: ["Test Pharmacy"],
      companyError: null,
      tallyReachable: true,
      connectorFiles: CONNECTOR_FILES,
      packageJson: { version: "0.2.0", dependencies: {} },
      ...(overrides.runtime ?? {}),
    },
    probes: {
      platform: () => ({ platform: "win32", release: "10.0.22631", arch: "x64", type: "Windows_NT" }),
      statfs: () => ({ bavail: 1024 * 1024, bsize: 4096 }),
      fetchImpl: async () => ({ status: 200 }),
      ...(overrides.probes ?? {}),
    },
    now: overrides.now ?? (() => new Date("2026-11-01T12:00:00.000Z")),
  }
}

function byId(report, id) {
  const found = report.checks.find((check) => check.id === id)
  assert.ok(found, `expected a check named ${id}`)
  return found
}

describe("prerequisite report shape", () => {
  it("returns the documented fields for every check", async () => {
    const report = await runPreflight(baseInput())

    assert.equal(report.checkedAt, "2026-11-01T12:00:00.000Z")
    assert.equal(report.connector.version, TALLY_CONNECTOR_VERSION)
    assert.equal(report.connector.contractVersion, TALLY_BRIDGE_CONTRACT_VERSION)
    for (const check of report.checks) {
      assert.deepEqual(Object.keys(check).sort(), [
        "canAutoFix",
        "detectedVersion",
        "evidence",
        "id",
        "lastCheckedAt",
        "message",
        "name",
        "remediation",
        "required",
        "requiredVersion",
        "requiresAdministrator",
        "status",
      ])
      assert.equal(typeof check.id, "string")
      assert.equal(typeof check.required, "boolean")
      assert.equal(typeof check.canAutoFix, "boolean")
      assert.equal(typeof check.requiresAdministrator, "boolean")
      assert.equal(check.lastCheckedAt, report.checkedAt)
    }
  })

  it("rejects a status outside the documented set", () => {
    assert.throws(() => checkResult("x", "X", "maybe"), /Unknown prerequisite status/)
  })

  it("counts each status and lists only required failures as blocking", () => {
    const checkedAt = new Date().toISOString()
    const summary = summariseChecks([
      checkResult("a", "A", "passed", {}, checkedAt),
      checkResult("b", "B", "warning", {}, checkedAt),
      checkResult("c", "C", "missing", { canAutoFix: true }, checkedAt),
      checkResult("d", "D", "failed", { required: false }, checkedAt),
      checkResult("e", "E", "blocked", {}, checkedAt),
      checkResult("f", "F", "not_applicable", {}, checkedAt),
    ])

    assert.equal(summary.total, 6)
    assert.equal(summary.passed, 1)
    assert.equal(summary.warning, 1)
    assert.equal(summary.missing, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.blocked, 1)
    assert.equal(summary.not_applicable, 1)
    assert.deepEqual(summary.blocking, ["c", "e"])
    assert.deepEqual(summary.autoFixable, ["c"])
    assert.equal(summary.ready, false)
  })
})

describe("machine checks", () => {
  it("reports a prepared Windows computer as ready", async () => {
    const report = await runPreflight(baseInput())

    assert.equal(report.summary.ready, true)
    assert.deepEqual(report.summary.blocking, [])
    assert.equal(byId(report, "windows").status, "passed")
    assert.equal(byId(report, "node_version").status, "passed")
    assert.equal(byId(report, "tally_service").status, "passed")
    assert.equal(byId(report, "tally_company_pinned").status, "passed")
    assert.equal(byId(report, "bridge_binding").status, "passed")
  })

  it("does not block on another platform, and says the packaged connector is Windows-only", async () => {
    const report = await runPreflight(
      baseInput({
        probes: {
          platform: () => ({ platform: "linux", release: "6.8.0", arch: "x64", type: "Linux" }),
        },
      }),
    )

    const windows = byId(report, "windows")
    assert.equal(windows.status, "not_applicable")
    assert.match(windows.message, /Windows 10 and 11/)
    assert.equal(report.summary.ready, true)
  })

  it("blocks an old Node.js runtime and marks the installer able to fix it", async () => {
    const report = await runPreflight(baseInput({ runtime: { nodeVersion: "18.20.0" } }))
    const node = byId(report, "node_version")

    assert.equal(node.status, "failed")
    assert.equal(node.canAutoFix, true)
    assert.equal(node.requiresAdministrator, true)
    assert.match(node.remediation, /nodejs\.org/)
    assert.ok(report.summary.blocking.includes("node_version"))
  })

  it("warns, without blocking, on a Node.js newer than the packaged runtime", async () => {
    const report = await runPreflight(baseInput({ runtime: { nodeVersion: "24.1.0" } }))
    const node = byId(report, "node_version")

    assert.equal(node.status, "warning")
    assert.equal(report.summary.ready, true)
  })

  it("fails on an implausible system clock", async () => {
    const report = await runPreflight(baseInput({ now: () => new Date("2150-01-01T00:00:00.000Z") }))

    assert.equal(byId(report, "system_clock").status, "failed")
  })

  it("fails when the connector's drive is nearly full", async () => {
    const report = await runPreflight(
      baseInput({ probes: { statfs: () => ({ bavail: 100, bsize: 4096 }) } }),
    )

    assert.equal(byId(report, "disk_space").status, "failed")
    assert.match(byId(report, "disk_space").message, /free/)
  })

  it("fails a missing connector file and offers to reinstall", async () => {
    const report = await runPreflight(
      baseInput({
        runtime: {
          connectorFiles: CONNECTOR_FILES.map((file) =>
            file.name === "cli.mjs" ? { ...file, present: false } : file,
          ),
        },
      }),
    )
    const files = byId(report, "connector_files")

    assert.equal(files.status, "failed")
    assert.equal(files.canAutoFix, true)
    assert.match(files.remediation, /installer/)
  })
})

describe("Tally reachability", () => {
  it("blocks the port, service and company checks when nothing answers", async () => {
    const report = await runPreflight(
      baseInput({
        runtime: { tallyReachable: false, companies: null, companyError: null },
      }),
    )

    assert.equal(byId(report, "tally_port").status, "missing")
    assert.equal(byId(report, "tally_service").status, "blocked")
    assert.equal(byId(report, "tally_company_open").status, "blocked")
    // A configured pin that cannot be confirmed is a warning, not a failure.
    assert.equal(byId(report, "tally_company_pinned").status, "warning")
    assert.equal(report.summary.ready, false)
    assert.deepEqual(
      report.summary.blocking.sort(),
      ["tally_company_open", "tally_port", "tally_service"],
    )
  })

  it("fails the service check when the port answers but the reply is not a company list", async () => {
    const report = await runPreflight(
      baseInput({
        runtime: {
          tallyReachable: true,
          companies: null,
          companyError: "TALLY_BRIDGE_COMPANIES_STATUS_MISSING",
        },
      }),
    )
    const service = byId(report, "tally_service")

    assert.equal(service.status, "failed")
    assert.match(service.message, /TALLY_BRIDGE_COMPANIES_STATUS_MISSING/)
  })

  it("blocks when Tally is running with no company open", async () => {
    const report = await runPreflight(
      baseInput({ runtime: { companies: [], companyError: null } }),
    )

    assert.equal(byId(report, "tally_company_open").status, "missing")
    assert.match(byId(report, "tally_company_open").remediation, /Open the company/)
  })

  it("fails a pin that names a company Tally does not have open", async () => {
    const report = await runPreflight(baseInput({ runtime: { companies: ["Another Pharmacy"] } }))
    const pinnedCheck = byId(report, "tally_company_pinned")

    assert.equal(pinnedCheck.status, "failed")
    assert.equal(pinnedCheck.canAutoFix, true)
    assert.match(pinnedCheck.message, /Another Pharmacy|not among/)
  })

  it("marks a blank pin as missing and names the restart", async () => {
    const report = await runPreflight(baseInput({ config: { company: "" } }))
    const pinnedCheck = byId(report, "tally_company_pinned")

    assert.equal(pinnedCheck.status, "missing")
    assert.match(pinnedCheck.remediation, /restart/)
  })
})

describe("connector security checks", () => {
  it("never returns the bridge token or raw Tally XML", async () => {
    const report = await runPreflight(
      baseInput({
        runtime: {
          companyError: null,
          companies: ["Test Pharmacy"],
        },
      }),
    )
    const serialised = JSON.stringify(report)

    assert.equal(serialised.includes(TOKEN), false)
    assert.equal(serialised.includes("{\"token\""), false)
    assert.equal(/<ENVELOPE|<TALLYMESSAGE|<COMPANY\b/i.test(serialised), false)
    assert.deepEqual(byId(report, "bridge_token").evidence, { tokenConfigured: true })
  })

  it("fails a bind address that is not loopback", async () => {
    const report = await runPreflight(
      baseInput({ connector: { bindHost: "0.0.0.0" }, config: { bridgeBindHost: "0.0.0.0" } }),
    )

    assert.equal(byId(report, "bridge_binding").status, "failed")
    assert.ok(report.summary.blocking.includes("bridge_binding"))
  })

  it("fails a portal origin that is not an exact HTTPS origin", async () => {
    const report = await runPreflight(
      baseInput({ config: { allowedOrigins: new Set(["http://example.com"]) } }),
    )

    assert.equal(byId(report, "allowed_origin").status, "failed")
    assert.ok(report.summary.blocking.includes("allowed_origin"))
  })

  it("warns, without blocking, when the connector cannot reach the portal", async () => {
    const report = await runPreflight(
      baseInput({
        probes: {
          fetchImpl: async () => {
            throw new Error("connect ECONNREFUSED")
          },
        },
      }),
    )
    const portal = byId(report, "portal_https")

    assert.equal(portal.status, "warning")
    assert.equal(portal.required, false)
    assert.equal(report.summary.ready, true)
  })

  it("records the endpoints the connector exposes and that none writes to Tally", async () => {
    const report = await runPreflight(baseInput())
    const readOnly = byId(report, "connector_read_only")

    assert.equal(readOnly.status, "passed")
    assert.deepEqual(readOnly.evidence.endpoints, [
      "/api/tally/status",
      "/api/tally/companies",
      "/api/tally/preflight",
      "/api/tally/export",
    ])
    assert.equal(readOnly.evidence.writesToTally, false)
  })
})
