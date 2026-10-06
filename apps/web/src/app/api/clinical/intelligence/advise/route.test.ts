import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/auth/getCurrentUser", () => ({
  getCurrentUser: vi.fn(async () => ({ id: "u1", tenantId: "t1" })),
}))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ success: true })),
  rateLimiters: { ai: {} },
}))
vi.mock("@synapse/interop", async () => {
  const actual = await vi.importActual<typeof import("@synapse/interop")>("@synapse/interop")
  return actual
})

import { POST } from "./route"

describe("POST /api/clinical/intelligence/advise", () => {
  beforeEach(() => {
    delete process.env.CLINICAL_INTELLIGENCE_WAVE1
  })

  it("returns 503 when Wave 1 flag is OFF", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/clinical/intelligence/advise", {
        method: "POST",
        body: JSON.stringify({ presentingComplaint: "fever" }),
      }),
    )
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("CLINICAL_INTELLIGENCE_DISABLED")
    expect(body.advisory).toBe(true)
  })
})
