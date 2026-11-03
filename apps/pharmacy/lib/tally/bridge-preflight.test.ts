import { describe, expect, it } from "vitest"
import { TallyBridgeError } from "./bridge-client"
import {
  MIN_BRIDGE_CONTRACT,
  blockingChecks,
  compatibilityCheck,
  installableChecks,
  manualChecks,
  parsePrerequisiteReport,
  requestBridgePreflight,
  summariseChecks,
  withCompatibility,
  type PrerequisiteCheck,
} from "./bridge-preflight"

const TOKEN = "0123456789abcdef".repeat(4)
const CHECKED_AT = "2026-11-01T12:00:00.000Z"

function check(overrides: Partial<PrerequisiteCheck> = {}): PrerequisiteCheck {
  return {
    id: "windows",
    name: "Windows version",
    status: "passed",
    required: true,
    detectedVersion: "win32 10.0.22631",
    requiredVersion: "Windows 10 or later",
    message: "Windows 10.0.22631 (x64) detected.",
    remediation: null,
    canAutoFix: false,
    requiresAdministrator: false,
    evidence: null,
    lastCheckedAt: CHECKED_AT,
    ...overrides,
  }
}

function reportBody(overrides: Record<string, unknown> = {}) {
  return {
    checkedAt: CHECKED_AT,
    connector: { version: "0.2.0", contractVersion: 2, bindHost: "127.0.0.1", port: 17890 },
    target: "http://127.0.0.1:9000",
    company: "Test Pharmacy",
    checks: [check()],
    summary: { total: 1, passed: 1, warning: 0, missing: 0, failed: 0, blocked: 0, not_applicable: 0, blocking: [], autoFixable: [], ready: true },
    ...overrides,
  }
}

function bridgeFetch(input: { status?: number; body?: unknown; text?: string }) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const payload = input.text ?? JSON.stringify(input.body ?? reportBody())
    return new Response(payload, {
      status: input.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe("requestBridgePreflight", () => {
  it("asks the local bridge for its report with the token in a header, never the URL", async () => {
    const { fetchImpl, calls } = bridgeFetch({})

    const report = await requestBridgePreflight({ token: TOKEN, fetchImpl })

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:17890/api/tally/preflight")
    expect(calls[0].url).not.toContain(TOKEN)
    expect((calls[0].init?.headers as Record<string, string>)["x-synapse-tally-bridge-token"]).toBe(TOKEN)
    expect(report.connector.contractVersion).toBe(2)
    // The portal's own check is appended to the bridge's report.
    expect(report.checks.map((entry) => entry.id)).toEqual(["windows", "portal_compatibility"])
  })

  it("refuses to call the bridge without a token", async () => {
    const { fetchImpl, calls } = bridgeFetch({})

    await expect(requestBridgePreflight({ token: "   ", fetchImpl })).rejects.toMatchObject({
      code: "TALLY_BRIDGE_TOKEN_REQUIRED",
    })
    expect(calls).toHaveLength(0)
  })

  it("explains that a 404 means the connector is older than this page", async () => {
    const { fetchImpl } = bridgeFetch({ status: 404, body: { error: "Not found." } })

    const error = await requestBridgePreflight({ token: TOKEN, fetchImpl }).catch((thrown) => thrown)

    expect(error).toBeInstanceOf(TallyBridgeError)
    expect(error.status).toBe(404)
    expect(error.message).toMatch(/older than this page/)
  })

  it("names the token and origin failures the same way the export client does", async () => {
    const unauthorised = await requestBridgePreflight({
      token: TOKEN,
      fetchImpl: bridgeFetch({ status: 401, body: { error: "Invalid bridge token." } }).fetchImpl,
    }).catch((thrown) => thrown)
    expect(unauthorised.message).toMatch(/did not accept this token/)

    const forbidden = await requestBridgePreflight({
      token: TOKEN,
      fetchImpl: bridgeFetch({ status: 403, body: { error: "Origin is not allowed." } }).fetchImpl,
    }).catch((thrown) => thrown)
    expect(forbidden.message).toMatch(/does not allow this page's origin/)
  })

  it("refuses an answer that is not a report instead of half-rendering it", async () => {
    const malformed = await requestBridgePreflight({
      token: TOKEN,
      fetchImpl: bridgeFetch({ text: "not json" }).fetchImpl,
    }).catch((thrown) => thrown)
    expect(malformed.code).toBe("TALLY_BRIDGE_PREFLIGHT_INVALID")

    const incomplete = await requestBridgePreflight({
      token: TOKEN,
      fetchImpl: bridgeFetch({ body: reportBody({ checks: [{ id: "x" }] }) }).fetchImpl,
    }).catch((thrown) => thrown)
    expect(incomplete.code).toBe("TALLY_BRIDGE_PREFLIGHT_INVALID")
  })

  it("rejects a check with a status the page does not understand", () => {
    expect(parsePrerequisiteReport(reportBody({ checks: [check({ status: "maybe" as never })] }))).toBeNull()
  })

  it("recomputes the summary rather than trusting the bridge's own", () => {
    const report = parsePrerequisiteReport(
      reportBody({
        checks: [check({ id: "tally_port", status: "missing" })],
        summary: { ...reportBody().summary, ready: true, blocking: [] },
      }),
    )

    expect(report?.summary.ready).toBe(false)
    expect(report?.summary.blocking).toEqual(["tally_port"])
  })
})

describe("connector compatibility", () => {
  it("passes a connector that implements this page's contract", () => {
    const entry = compatibilityCheck({ version: "0.2.0", contractVersion: MIN_BRIDGE_CONTRACT, bindHost: "127.0.0.1", port: 17890 })

    expect(entry.status).toBe("passed")
    expect(entry.required).toBe(true)
    expect(entry.remediation).toBeNull()
  })

  it("blocks an older contract and offers the installer", () => {
    const entry = compatibilityCheck({ version: "0.1.0", contractVersion: 1, bindHost: "127.0.0.1", port: 17890 })

    expect(entry.status).toBe("failed")
    expect(entry.canAutoFix).toBe(true)
    expect(entry.message).toContain("needs 2")
  })

  it("blocks a connector that does not state its contract", () => {
    const entry = compatibilityCheck({ version: "0.2.0", contractVersion: null, bindHost: null, port: null })

    expect(entry.status).toBe("failed")
    expect(entry.message).toMatch(/did not report/)
  })

  it("turns a bridge report into a blocking report when the contract is too old", () => {
    const base = parsePrerequisiteReport(reportBody())!
    const report = withCompatibility({ ...base, connector: { ...base.connector, contractVersion: 1 } })

    expect(report.summary.ready).toBe(false)
    expect(report.summary.blocking).toEqual(["portal_compatibility"])
  })
})

describe("check grouping", () => {
  it("separates what the installer can fix from what the operator must do", () => {
    const checks = [
      check({ id: "node_version", status: "failed", canAutoFix: true }),
      check({ id: "tally_port", status: "missing", canAutoFix: false }),
      check({ id: "disk_space", status: "warning", canAutoFix: false }),
      check({ id: "connector_dependencies", status: "warning", required: false, canAutoFix: true }),
    ]
    const report = parsePrerequisiteReport(reportBody({ checks }))!

    expect(installableChecks(report).map((entry) => entry.id)).toEqual(["node_version"])
    expect(manualChecks(report).map((entry) => entry.id)).toEqual(["tally_port"])
    expect(blockingChecks(report).map((entry) => entry.id)).toEqual(["node_version", "tally_port"])
    expect(summariseChecks(checks).ready).toBe(false)
    expect(summariseChecks(checks).autoFixable).toEqual(["node_version"])
  })

  it("treats an optional failure as non-blocking", () => {
    const summary = summariseChecks([
      check({ id: "portal_https", status: "warning", required: false }),
      check({ id: "tally_installation", status: "warning", required: false }),
    ])

    expect(summary.ready).toBe(true)
    expect(summary.blocking).toEqual([])
  })
})
