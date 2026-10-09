import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const { requireHospitalStaffContext, requireHospitalCapability, dbFrom, insertSpy, checkRateLimit } = vi.hoisted(() => ({
  requireHospitalStaffContext: vi.fn(),
  requireHospitalCapability: vi.fn(),
  dbFrom: vi.fn(),
  insertSpy: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock("@/lib/hospital-dept", () => ({
  requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
}))

vi.mock("@/lib/hospital-shared", async () => {
  const { NextResponse } = await import("next/server")
  return {
    isContextError: (value: unknown): value is InstanceType<typeof NextResponse> => value instanceof NextResponse,
    requireHospitalCapability: (...args: unknown[]) => requireHospitalCapability(...args),
  }
})

vi.mock("../../../../../lib/rate-limit", () => ({
  rateLimiters: { ai: {} },
  checkRateLimit: (...args: unknown[]) => checkRateLimit(...args),
}))

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

import { POST } from "./route"

const TENANT = "11111111-1111-4111-8111-111111111111"
const OTHER_TENANT = "99999999-9999-4999-8999-999999999999"
const ENCOUNTER = "44444444-4444-4444-8444-444444444444"
const PATIENT = "66666666-6666-4666-8666-666666666666"

function staffCtx(role = "doctor") {
  return {
    userId: "55555555-5555-4555-8555-555555555555",
    email: "doc@example.test",
    role,
    tenantId: TENANT,
    hospitalId: "22222222-2222-4222-8222-222222222222",
    facilityType: "hospital",
    fullName: "Dr Test",
  }
}

function req(body: unknown) {
  return new NextRequest("http://localhost/api/clinical/intelligence/advise", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  })
}

type EncounterRow = { id: string; patient_id: string; tenant_id: string }

function wireDb(opts: { encounters?: EncounterRow[]; adviceInsertError?: { code: string; message: string } | null }) {
  dbFrom.mockImplementation((table: string) => {
    if (table === "encounters") {
      const filters: Record<string, string> = {}
      const chain = {
        select: () => chain,
        eq: (col: string, val: string) => {
          filters[col] = val
          return chain
        },
        maybeSingle: async () => ({
          data:
            (opts.encounters ?? []).find((e) => e.id === filters.id && e.tenant_id === filters.tenant_id) ?? null,
          error: null,
        }),
      }
      return chain
    }
    if (table === "clinical_ai_advice_events") {
      return {
        insert: async (row: unknown) => {
          insertSpy(row)
          return { error: opts.adviceInsertError ?? null }
        },
      }
    }
    throw new Error(`unexpected table ${table}`)
  })
}

beforeEach(() => {
  vi.stubEnv("CLINICAL_INTELLIGENCE_WAVE1", "true")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.stubEnv("DEEPSEEK_API_KEY", "")
  vi.stubEnv("CLINICAL_INTELLIGENCE_FORCE_MOCK", "")
  vi.stubEnv("CLINICAL_INTELLIGENCE_ALLOW_FORCE_MOCK", "")
  requireHospitalStaffContext.mockResolvedValue(staffCtx())
  requireHospitalCapability.mockResolvedValue(null)
  checkRateLimit.mockResolvedValue({ success: true })
  wireDb({ encounters: [{ id: ENCOUNTER, patient_id: PATIENT, tenant_id: TENANT }] })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("POST /api/clinical/intelligence/advise", () => {
  it("flag OFF → 503 and touches nothing (no auth, DB or provider)", async () => {
    vi.stubEnv("CLINICAL_INTELLIGENCE_WAVE1", "")
    const res = await POST(req({ presentingComplaint: "fever" }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("CLINICAL_INTELLIGENCE_DISABLED")
    expect(requireHospitalStaffContext).not.toHaveBeenCalled()
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("unauthenticated → 401 from the staff context gate", async () => {
    requireHospitalStaffContext.mockResolvedValue(NextResponse.json({ error: "Unauthorized" }, { status: 401 }))
    const res = await POST(req({ presentingComplaint: "fever" }))
    expect(res.status).toBe(401)
  })

  it("role without encounter authoring capability (e.g. cashier) → 403", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx("billing_officer"))
    requireHospitalCapability.mockResolvedValue(NextResponse.json({ error: "Forbidden" }, { status: 403 }))
    const res = await POST(req({ presentingComplaint: "fever" }))
    expect(res.status).toBe(403)
    expect(requireHospitalCapability).toHaveBeenCalledWith(expect.anything(), "encounter", "create", "opd")
  })

  it("caller-supplied foreign tenantId → 403", async () => {
    const res = await POST(req({ presentingComplaint: "fever", tenantId: OTHER_TENANT }))
    expect(res.status).toBe(403)
  })

  it("encounter from another tenant → 404 (no cross-tenant context)", async () => {
    wireDb({ encounters: [{ id: ENCOUNTER, patient_id: PATIENT, tenant_id: OTHER_TENANT }] })
    const res = await POST(req({ presentingComplaint: "fever", encounterId: ENCOUNTER }))
    expect(res.status).toBe(404)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("malformed body → 400", async () => {
    const res = await POST(req({ presentingComplaint: "fever", vitals: "not-an-object" }))
    expect(res.status).toBe(400)
  })

  it("invalid clinician decision is rejected (no arbitrary actions such as SIGN)", async () => {
    const res = await POST(req({ override: { recommendationId: "r1", decision: "SIGN" } }))
    expect(res.status).toBe(400)
    expect(insertSpy).not.toHaveBeenCalled()
  })

  it("clinician override is persisted with tenant + encounter scope", async () => {
    const res = await POST(
      req({ encounterId: ENCOUNTER, override: { recommendationId: "r1", decision: "REJECT", reason: "does not fit" } }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.override.decision).toBe("REJECT")
    expect(body.provenancePersisted).toBe(true)
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT,
        event_type: "override",
        encounter_id: ENCOUNTER,
        patient_id: PATIENT,
        decision: "REJECT",
      }),
    )
  })

  it("AI unavailable → 200 degraded advisory; provenance table absent → still 200", async () => {
    wireDb({
      encounters: [{ id: ENCOUNTER, patient_id: PATIENT, tenant_id: TENANT }],
      adviceInsertError: { code: "42P01", message: 'relation "clinical_ai_advice_events" does not exist' },
    })
    const res = await POST(req({ presentingComplaint: "fever hypotension", encounterId: ENCOUNTER }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.advisory).toBe(true)
    expect(body.origin).toBe("ai_suggestion")
    expect(body.degraded).toBe(true)
    expect(body.provenancePersisted).toBe(false)
    expect(body.safety).toMatchObject({ canActivatePathway: false, canPlaceOrder: false, canSignDiagnosis: false })
  })

  it("forceMock from the request is ignored unless explicitly allowed off-production", async () => {
    const res = await POST(req({ presentingComplaint: "fever", forceMock: true }))
    const body = await res.json()
    expect(body.availability).toBe("unavailable")
    expect(body.recommendation).toBeNull()
    expect(body.model).toBeNull()

    vi.stubEnv("CLINICAL_INTELLIGENCE_ALLOW_FORCE_MOCK", "1")
    vi.stubEnv("VERCEL_ENV", "production")
    const prod = await (await POST(req({ presentingComplaint: "fever", forceMock: true }))).json()
    expect(prod.availability).toBe("unavailable")
    expect(prod.recommendation).toBeNull()

    vi.stubEnv("VERCEL_ENV", "preview")
    const preview = await (await POST(req({ presentingComplaint: "fever", forceMock: true }))).json()
    expect(preview.model).toBe("mock-clinical-v1")
  })

  it("rate limit is keyed per clinician, not per IP", async () => {
    checkRateLimit.mockResolvedValue({ success: false })
    const res = await POST(req({ presentingComplaint: "fever" }))
    expect(res.status).toBe(429)
    expect(checkRateLimit).toHaveBeenCalledWith(expect.anything(), "clinical-intelligence:55555555-5555-4555-8555-555555555555")
  })
})
