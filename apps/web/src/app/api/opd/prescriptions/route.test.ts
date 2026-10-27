import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const {
  requireHospitalStaffContext,
  requireHospitalCapability,
  gateHospitalModule,
  logHospitalAudit,
  persistClinicalPrescriptionBestEffort,
  persistWorkQueueArtifactsBestEffort,
  persistDomainEventsBestEffort,
  appendClinicalChargeBestEffort,
  publishClinicalTimelineBestEffort,
  publishTimelineEvent,
  runClinicalSafetyCheck,
  dbFrom,
} = vi.hoisted(() => ({
  requireHospitalStaffContext: vi.fn(),
  requireHospitalCapability: vi.fn(),
  gateHospitalModule: vi.fn(),
  logHospitalAudit: vi.fn(),
  persistClinicalPrescriptionBestEffort: vi.fn(),
  persistWorkQueueArtifactsBestEffort: vi.fn(),
  persistDomainEventsBestEffort: vi.fn(),
  appendClinicalChargeBestEffort: vi.fn(),
  publishClinicalTimelineBestEffort: vi.fn(),
  publishTimelineEvent: vi.fn(),
  runClinicalSafetyCheck: vi.fn(),
  dbFrom: vi.fn(),
}))

vi.mock("@/lib/hospital-dept", async () => {
  const { z } = await import("zod")
  return {
    requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
    prescriptionCreateSchema: z.object({
      encounter_id: z.string().uuid(),
      patient_id: z.string().uuid(),
      medication_display: z.string().min(1).max(500),
      dose: z.string().min(1).max(2000),
      quantity: z.coerce.number().positive(),
      unit: z.string().min(1).max(40).default("unit"),
      care_plan_id: z.string().uuid().optional(),
      person_id: z.string().uuid().optional(),
      pharmacy_tenant_id: z.string().uuid().optional(),
      safety_override_reason: z.string().trim().min(8).max(500).optional(),
    }),
  }
})

vi.mock("@/lib/hospital-shared", async () => {
  const { NextResponse } = await import("next/server")
  return {
    isContextError: (value: unknown): value is InstanceType<typeof NextResponse> => value instanceof NextResponse,
    requireHospitalCapability: (...args: unknown[]) => requireHospitalCapability(...args),
    gateHospitalModule: (...args: unknown[]) => gateHospitalModule(...args),
    logHospitalAudit: (...args: unknown[]) => logHospitalAudit(...args),
  }
})

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

vi.mock("@synapse/db/prescription-persist", () => ({
  persistClinicalPrescriptionBestEffort: (...args: unknown[]) => persistClinicalPrescriptionBestEffort(...args),
}))

vi.mock("@synapse/db/work-queue-persist", () => ({
  persistWorkQueueArtifactsBestEffort: (...args: unknown[]) => persistWorkQueueArtifactsBestEffort(...args),
  persistDomainEventsBestEffort: (...args: unknown[]) => persistDomainEventsBestEffort(...args),
}))

vi.mock("@synapse/db/clinical-timeline", () => ({
  prescriptionTimelineEvent: (input: unknown) => input,
  publishClinicalTimelineBestEffort: (...args: unknown[]) => publishClinicalTimelineBestEffort(...args),
}))

vi.mock("@synapse/db/identity-persist", () => ({
  publishTimelineEvent: (...args: unknown[]) => publishTimelineEvent(...args),
}))

vi.mock("@synapse/db/clinical-charge", () => ({
  appendClinicalChargeBestEffort: (...args: unknown[]) => appendClinicalChargeBestEffort(...args),
  recordInvoiceCreatedEvent: () => ({ list: () => [] }),
}))

vi.mock("@/lib/clinical-safety", () => ({
  runClinicalSafetyCheck: (...args: unknown[]) => runClinicalSafetyCheck(...args),
}))

const TENANT = "11111111-1111-4111-8111-111111111111"
const HOSPITAL = "22222222-2222-4222-8222-222222222222"
const PATIENT = "33333333-3333-4333-8333-333333333333"
const ENCOUNTER = "44444444-4444-4444-8444-444444444444"
const DOCTOR = "55555555-5555-4555-8555-555555555555"
const PHARM_TENANT = TENANT
const FOREIGN_PHARM_TENANT = "66666666-6666-4666-8666-666666666666"

function staffCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: DOCTOR,
    email: "doctor@example.test",
    role: "doctor",
    tenantId: TENANT,
    hospitalId: HOSPITAL,
    facilityType: "hospital",
    fullName: "Dr Test",
    ...overrides,
  }
}

function chain(result: { data: unknown; error: unknown }) {
  const api: Record<string, unknown> = {}
  const self = () => api
  for (const method of ["select", "eq", "order", "limit", "update"]) {
    api[method] = vi.fn(self)
  }
  api.maybeSingle = vi.fn(async () => result)
  api.upsert = vi.fn(async () => ({ error: null }))
  return api
}

function allowSafety() {
  const coverage = {
    allergies: { state: "loaded", rows: 0 },
    interactions: { state: "loaded", rows: 0 },
    contraindications: { state: "loaded", rows: 0 },
    doseAdjustments: { state: "loaded", rows: 0 },
    renalFunction: { state: "loaded", rows: 0 },
  }
  return {
    evaluation: { alerts: [], coverage, highest: "none", indeterminate: false, indeterminateDomains: [] },
    decision: { decision: "allow", blocking: [], suppressed: [], reasons: [], policyWarnings: [] },
    payload: { decision: "allow", highest: "none", indeterminate: false, indeterminateDomains: [], coverage, alerts: [], blockingAlerts: [], reasons: [], policyWarnings: [] },
    auditRecordId: "audit-1",
  }
}

function blockingSafety() {
  const allowed = allowSafety()
  return {
    ...allowed,
    decision: { decision: "block", blocking: [{ key: "allergy_match:a1:x", severity: "critical" }], suppressed: [], reasons: ["Allergy blocks"], policyWarnings: [] },
    payload: {
      ...allowed.payload,
      decision: "block",
      highest: "critical",
      blockingAlerts: ["allergy_match:a1:x"],
      reasons: ["Allergy blocks"],
    },
  }
}

function postBody(body: Record<string, unknown>) {
  return new NextRequest("https://synapseos.tech/api/opd/prescriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    encounter_id: ENCOUNTER,
    patient_id: PATIENT,
    medication_display: "Paracetamol 500mg",
    dose: "1 tablet TID",
    quantity: 9,
    unit: "tablet",
    pharmacy_tenant_id: PHARM_TENANT,
    ...overrides,
  }
}

describe("POST /api/opd/prescriptions", () => {
  beforeEach(() => {
    requireHospitalCapability.mockResolvedValue(null)
    gateHospitalModule.mockResolvedValue(null)
    logHospitalAudit.mockResolvedValue(undefined)
    persistClinicalPrescriptionBestEffort.mockResolvedValue({ ok: true })
    persistWorkQueueArtifactsBestEffort.mockResolvedValue({ errors: [] })
    persistDomainEventsBestEffort.mockResolvedValue({ errors: [] })
    appendClinicalChargeBestEffort.mockResolvedValue({
      ok: true,
      result: { created: false, invoiceId: "inv-1", totalAmount: 0 },
    })
    publishClinicalTimelineBestEffort.mockResolvedValue(undefined)
    runClinicalSafetyCheck.mockResolvedValue(allowSafety())
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("gates prescribing on the OS Basic clinical module (opd), not hospital dispensing", async () => {
    const ctx = staffCtx()
    requireHospitalStaffContext.mockResolvedValue(ctx)
    const blocked = NextResponse.json({ error: "feature_not_available" }, { status: 402 })
    gateHospitalModule.mockImplementation(async (_t: string, _h: string, key: string) => (key === "opd" ? null : blocked))
    dbFrom.mockImplementation(() => { throw new Error("stop after gate") })
    const { POST } = await import("./route")
    await POST(postBody(validBody())).catch(() => null)
    expect(gateHospitalModule).toHaveBeenCalledWith(ctx.tenantId, ctx.hospitalId, "opd")
    expect(gateHospitalModule).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "dispensing")
  })

  it("GET prescription list is gated on opd, not dispensing", async () => {
    const ctx = staffCtx()
    requireHospitalStaffContext.mockResolvedValue(ctx)
    gateHospitalModule.mockResolvedValue(NextResponse.json({ error: "x" }, { status: 402 }))
    const { GET } = await import("./route")
    const res = await GET(new NextRequest("http://localhost/api/opd/prescriptions?encounter_id=11111111-1111-4111-8111-111111111111"))
    expect(res.status).toBe(402)
    expect(gateHospitalModule).toHaveBeenCalledWith(ctx.tenantId, ctx.hospitalId, "opd")
  })

  it("returns the auth denial response before creating a prescription", async () => {
    const denied = NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    requireHospitalStaffContext.mockResolvedValue(denied)

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(401)
    expect(requireHospitalCapability).not.toHaveBeenCalled()
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("blocks callers missing prescription.create", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 })
    requireHospitalCapability.mockResolvedValue(forbidden)

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res).toBe(forbidden)
    expect(requireHospitalCapability).toHaveBeenCalledWith(
      expect.objectContaining({ userId: DOCTOR }),
      "prescription",
      "create",
      "opd",
    )
  })

  it("rejects invalid bodies with 400", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())

    const { POST } = await import("./route")
    const res = await POST(postBody({ encounter_id: "not-a-uuid" }))
    expect(res.status).toBe(400)
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("refuses to route a prescription to another tenant's pharmacy", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody({ pharmacy_tenant_id: FOREIGN_PHARM_TENANT })))
    expect(res.status).toBe(403)
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("returns 404 when the encounter is missing for this tenant", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockReturnValue(chain({ data: null, error: null }))

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(404)
    const json = await res.json()
    expect(json.error).toMatch(/Encounter not found/i)
  })

  it("returns 400 when patient_id does not match the encounter", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockReturnValue(
      chain({
        data: { id: ENCOUNTER, patient_id: "99999999-9999-4999-8999-999999999999", tenant_id: TENANT },
        error: null,
      }),
    )

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toMatch(/Patient does not match/i)
  })

  it("creates a prescription and returns 201 with correlation id", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockReturnValue(
      chain({
        data: { id: ENCOUNTER, patient_id: PATIENT, tenant_id: TENANT },
        error: null,
      }),
    )

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.prescriptionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(json.correlationId).toBe(ENCOUNTER)
    expect(json.pharmacyTaskId).toBeTruthy()
    expect(persistClinicalPrescriptionBestEffort).toHaveBeenCalled()
    expect(logHospitalAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "INSERT",
        tableName: "clinical_prescriptions",
      }),
    )
    expect(json.safety.decision).toBe("allow")
  })

  it("returns 409 and writes nothing when the safety check blocks", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockReturnValue(
      chain({ data: { id: ENCOUNTER, patient_id: PATIENT, tenant_id: TENANT }, error: null }),
    )
    runClinicalSafetyCheck.mockResolvedValue(blockingSafety())

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))

    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe("clinical_safety_block")
    expect(json.safety.blockingAlerts).toContain("allergy_match:a1:x")
    expect(persistClinicalPrescriptionBestEffort).not.toHaveBeenCalled()
    expect(logHospitalAudit).not.toHaveBeenCalled()
  })

  it("proceeds past a block only when an override reason is supplied, and passes it to the audit", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockReturnValue(
      chain({ data: { id: ENCOUNTER, patient_id: PATIENT, tenant_id: TENANT }, error: null }),
    )
    runClinicalSafetyCheck.mockResolvedValue(blockingSafety())

    const { POST } = await import("./route")
    const res = await POST(
      postBody(validBody({ safety_override_reason: "Benefit outweighs risk; haematology aware" })),
    )

    expect(res.status).toBe(201)
    expect(runClinicalSafetyCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "prescribe",
        overrideReason: "Benefit outweighs risk; haematology aware",
      }),
    )
    const json = await res.json()
    expect(json.safety.decision).toBe("block")
  })

  it("rejects an override reason too short to be a record of a decision", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody({ safety_override_reason: "ok" })))

    expect(res.status).toBe(400)
    expect(runClinicalSafetyCheck).not.toHaveBeenCalled()
  })

  it("runs the safety check against the drug being ordered before anything is written", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockReturnValue(
      chain({ data: { id: ENCOUNTER, patient_id: PATIENT, tenant_id: TENANT }, error: null }),
    )

    const { POST } = await import("./route")
    await POST(postBody(validBody()))

    expect(runClinicalSafetyCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        hospitalId: HOSPITAL,
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        actorId: DOCTOR,
        newDrugs: [{ label: "Paracetamol 500mg", aliases: [], role: "new" }],
      }),
    )
  })
})
