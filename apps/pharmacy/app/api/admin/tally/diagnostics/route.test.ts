import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  rateLimited: false,
  retryAfter: 0,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return {}
  },
}))
vi.mock("@/lib/distributed-rate-limit", () => ({
  consumeRateLimits: vi.fn(async () =>
    m.rateLimited
      ? { allowed: false, retryAfter: m.retryAfter }
      : { allowed: true, retryAfter: 0 },
  ),
}))

import { POST } from "./route"

const AUTHORISED = {
  ok: true,
  tenantId: "tenant-1",
  session: {
    user: { id: "user-1" },
    role: "pharmacy_admin",
    pharmacyRole: "pharmacy_admin",
    permissions: [],
    isAdmin: false,
  },
}

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/tally/diagnostics", {
      method: "POST",
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  )

function failureLogs(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("tally.client.failed"))
    .map((line) => JSON.parse(line.replace("[pharmacy][tally] ", "")) as Record<string, unknown>)
}

describe("POST /api/admin/tally/diagnostics", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    m.rateLimited = false
    m.retryAfter = 0
  })

  it("refuses a session without inventory.read before logging anything", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await post({ step: "bridge-check", outcome: "failed" })

    expect(response.status).toBe(403)
    expect(failureLogs(logged)).toHaveLength(0)
    logged.mockRestore()
  })

  it("rejects a field the schema does not declare", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await post({ step: "bridge-check", company: "Test Pharmacy" })

    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe("TALLY_DIAGNOSTIC_INVALID")
    expect(failureLogs(logged)).toHaveLength(0)
    logged.mockRestore()
  })

  it("rejects free text dressed as a refusal code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await post({
      step: "extraction",
      code: "TALLY_BRIDGE_COMPANY_UNVERIFIED: could not read <COMPANY NAME=\"Acme\">",
    })

    expect(response.status).toBe(400)
    expect(failureLogs(logged)).toHaveLength(0)
    logged.mockRestore()
  })

  it("rejects a step outside the closed set", async () => {
    expect((await post({ step: "anything-else" })).status).toBe(400)
    expect((await post({ step: "apply", outcome: "almost" })).status).toBe(400)
    expect((await post({ step: "apply", status: 99 })).status).toBe(400)
  })

  it("rejects a body larger than the cap", async () => {
    const response = await post({ step: "apply", sessionId: "a".repeat(5000) })
    expect(response.status).toBe(400)
  })

  it("logs one line carrying the refusal code and no free text", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await post({
      step: "extraction",
      outcome: "failed",
      code: "TALLY_BRIDGE_COMPANY_UNVERIFIED",
      status: 422,
      sessionId: "session-1",
    })

    expect(response.status).toBe(202)
    const lines = failureLogs(logged)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      event: "tally.client.failed",
      step: "extraction",
      outcome: "failed",
      code: "TALLY_BRIDGE_COMPANY_UNVERIFIED",
      status: 422,
      sessionId: "session-1",
      tenantId: "tenant-1",
      actorId: "user-1",
    })
    // The thrown value carries only the code, so no message can ride along.
    expect(lines[0].errorMessage).toBe("TALLY_BRIDGE_COMPANY_UNVERIFIED")
    logged.mockRestore()
  })

  it("accepts the minimal report the bridge-check catch produces", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    expect((await post({ step: "bridge-check", outcome: "network" })).status).toBe(202)
    expect(failureLogs(logged)[0]).toMatchObject({ step: "bridge-check", outcome: "network" })
    logged.mockRestore()
  })

  it("refuses a burst with a Retry-After instead of logging it", async () => {
    m.rateLimited = true
    m.retryAfter = 30
    const logged = vi.spyOn(console, "error").mockImplementation(() => {})

    const response = await post({ step: "apply", outcome: "network" })

    expect(response.status).toBe(429)
    expect(response.headers.get("Retry-After")).toBe("30")
    expect(failureLogs(logged)).toHaveLength(0)
    logged.mockRestore()
  })
})
