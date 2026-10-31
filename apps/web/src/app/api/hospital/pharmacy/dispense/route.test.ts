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
  dbRpc,
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
  dbRpc: vi.fn(),
}))

vi.mock("@/lib/hospital-dept", async () => {
  const { z } = await import("zod")
  return {
    requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
    hospitalDispenseSchema: z.object({
      prescription_id: z.string().uuid(),
      product_id: z.string().uuid(),
      pharmacy_tenant_id: z.string().uuid(),
      payment_method: z.string().min(1).max(40).default("cash"),
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
  supabaseAdmin: {
    from: (...args: unknown[]) => dbFrom(...args),
    rpc: (...args: unknown[]) => dbRpc(...args),
  },
}))

vi.mock("@synapse/db/prescription-persist", async () => {
  const actual = await vi.importActual<typeof import("@synapse/db/prescription-persist")>(
    "@synapse/db/prescription-persist",
  )
  return {
    ...actual,
    persistClinicalPrescriptionBestEffort: (...args: unknown[]) => persistClinicalPrescriptionBestEffort(...args),
  }
})

vi.mock("@synapse/db/work-queue-persist", () => ({
  persistWorkQueueArtifactsBestEffort: (...args: unknown[]) => persistWorkQueueArtifactsBestEffort(...args),
  persistDomainEventsBestEffort: (...args: unknown[]) => persistDomainEventsBestEffort(...args),
}))

vi.mock("@synapse/db/clinical-timeline", () => ({
  medicationDispensedTimelineEvent: (input: unknown) => input,
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
const PHARMACIST = "77777777-7777-4777-8777-777777777777"
const PRESCRIBER = "55555555-5555-4555-8555-555555555555"
const RX = "88888888-8888-4888-8888-888888888888"
const PRODUCT = "99999999-9999-4999-8999-999999999999"
const BATCH = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const BATCH_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PHARM_TENANT = TENANT
const FOREIGN_PHARM_TENANT = "66666666-6666-4666-8666-666666666666"

function staffCtx(overrides: Record<string, unknown> = {}) {
  return {
    userId: PHARMACIST,
    email: "pharmacist@example.test",
    role: "pharmacist",
    tenantId: TENANT,
    hospitalId: HOSPITAL,
    facilityType: "hospital",
    fullName: "Rx Test",
    ...overrides,
  }
}

function rxRow(overrides: Record<string, unknown> = {}) {
  return {
    id: RX,
    tenant_id: TENANT,
    pharmacy_tenant_id: PHARM_TENANT,
    patient_id: PATIENT,
    person_id: null,
    encounter_id: ENCOUNTER,
    care_plan_id: null,
    medication_display: "Paracetamol 500mg",
    dose: "1 tablet TID",
    quantity: 5,
    unit: "tablet",
    prescriber_id: PRESCRIBER,
    verifier_id: null,
    dispenser_id: null,
    status: "active",
    correlation_id: ENCOUNTER,
    is_synthetic: true,
    simulation_run_id: null,
    ...overrides,
  }
}

function tableMock(handlers: Record<string, { data?: unknown; error?: unknown; rows?: unknown }>) {
  return (table: string) => {
    const handler = handlers[table] ?? { data: null, error: null }
    const api: Record<string, unknown> = {}
    const self = () => api
    for (const method of ["select", "eq", "order", "limit", "update"]) {
      api[method] = vi.fn(self)
    }
    api.maybeSingle = vi.fn(async () => ({ data: handler.data ?? null, error: handler.error ?? null }))
    api.then = (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({ data: handler.rows ?? handler.data ?? null, error: handler.error ?? null }).then(
        resolve,
        reject,
      )
    return api
  }
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
    auditRecordId: "audit-2",
  }
}

function blockingSafety() {
  const allowed = allowSafety()
  return {
    ...allowed,
    decision: { decision: "block", blocking: [{ key: "allergy_match:a9:p", severity: "critical" }], suppressed: [], reasons: ["Allergy blocks"], policyWarnings: [] },
    payload: {
      ...allowed.payload,
      decision: "block",
      highest: "critical",
      blockingAlerts: ["allergy_match:a9:p"],
      reasons: ["Allergy blocks"],
    },
  }
}

function postBody(body: Record<string, unknown>) {
  return new NextRequest("https://synapseos.tech/api/hospital/pharmacy/dispense", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    prescription_id: RX,
    product_id: PRODUCT,
    pharmacy_tenant_id: PHARM_TENANT,
    payment_method: "cash",
    ...overrides,
  }
}

describe("POST /api/hospital/pharmacy/dispense", () => {
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
    dbRpc.mockResolvedValue({ data: { sale_id: "sale-1" }, error: null })
    runClinicalSafetyCheck.mockResolvedValue(allowSafety())
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("returns auth denial before loading prescriptions", async () => {
    const denied = NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    requireHospitalStaffContext.mockResolvedValue(denied)

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(401)
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("blocks callers missing prescription.dispense", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    const forbidden = NextResponse.json({ error: "Forbidden" }, { status: 403 })
    requireHospitalCapability.mockResolvedValue(forbidden)

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res).toBe(forbidden)
    expect(requireHospitalCapability).toHaveBeenCalledWith(
      expect.objectContaining({ role: "pharmacist" }),
      "prescription",
      "dispense",
      "dispensing",
    )
  })

  it("rejects invalid bodies with 400", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())

    const { POST } = await import("./route")
    const res = await POST(postBody({ prescription_id: "bad" }))
    expect(res.status).toBe(400)
  })

  it("refuses to draw on another tenant's pharmacy stock", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    const { POST } = await import("./route")
    const res = await POST(postBody(validBody({ pharmacy_tenant_id: FOREIGN_PHARM_TENANT })))
    expect(res.status).toBe(403)
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("returns 404 when prescription is missing for this tenant", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(tableMock({ clinical_prescriptions: { data: null } }))

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(404)
  })

  it("returns 409 when already dispensed", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(tableMock({ clinical_prescriptions: { data: rxRow({ status: "dispensed" }) } }))

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toMatch(/Already dispensed/i)
  })

  it("fails closed on insufficient stock", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(
      tableMock({
        clinical_prescriptions: { data: rxRow({ status: "verified", verifier_id: PHARMACIST, quantity: 10 }) },
        pharmacy_products: { data: { id: PRODUCT, price: 500, name: "Paracetamol 500mg", is_active: true } },
        pharmacy_product_batches: {
          rows: [{
            id: BATCH,
            quantity: 2,
            expiry_date: "2028-12-31",
            status: "active",
            is_active: true,
            selling_price: 500,
          }],
        },
      }),
    )

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe("INSUFFICIENT_STOCK")
    expect(dbRpc).not.toHaveBeenCalled()
  })

  it("dispenses an active prescription when verify+dispense capabilities pass", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(
      tableMock({
        clinical_prescriptions: { data: rxRow({ status: "active", quantity: 3 }) },
        pharmacy_products: { data: { id: PRODUCT, price: 500, name: "Paracetamol 500mg", is_active: true } },
        pharmacy_product_batches: {
          rows: [{
            id: BATCH,
            quantity: 20,
            expiry_date: "2028-12-31",
            status: "active",
            is_active: true,
            selling_price: 500,
          }],
        },
        department_tasks: { data: { id: "task-1" } },
        billing_invoices: { data: null },
      }),
    )

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.prescription.status).toBe("dispensed")
    expect(json.remainingStock).toBe(17)
    expect(json.sale).toEqual({ sale_id: "sale-1" })
    expect(dbRpc).toHaveBeenCalledWith(
      "complete_pharmacy_sale",
      expect.objectContaining({
        p_tenant_id: PHARM_TENANT,
        p_idempotency_key: `clinical_prescriptions:${RX}`,
        p_items: [{
          product_id: PRODUCT,
          batch_id: BATCH,
          quantity: 3,
          unit_price: 500,
          discount_amount: 0,
        }],
      }),
    )
    expect(requireHospitalCapability).toHaveBeenCalledWith(
      expect.anything(),
      "prescription",
      "verify",
      "dispensing",
    )
    expect(logHospitalAudit).toHaveBeenCalled()
    expect(json.safety.decision).toBe("allow")
  })

  it("prices each FEFO batch separately for sale and encounter billing", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(
      tableMock({
        clinical_prescriptions: { data: rxRow({ status: "verified", verifier_id: PHARMACIST, quantity: 3 }) },
        pharmacy_products: { data: { id: PRODUCT, price: 500, name: "Paracetamol 500mg", is_active: true } },
        pharmacy_product_batches: {
          rows: [
            {
              id: BATCH,
              quantity: 2,
              expiry_date: "2027-12-31",
              status: "active",
              is_active: true,
              selling_price: 500,
            },
            {
              id: BATCH_2,
              quantity: 10,
              expiry_date: "2028-12-31",
              status: "active",
              is_active: true,
              selling_price: 700,
            },
          ],
        },
        department_tasks: { data: null },
        billing_invoices: { data: null },
      }),
    )

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))
    expect(res.status).toBe(200)
    expect(dbRpc).toHaveBeenCalledWith(
      "complete_pharmacy_sale",
      expect.objectContaining({
        p_items: [
          { product_id: PRODUCT, batch_id: BATCH, quantity: 2, unit_price: 500, discount_amount: 0 },
          { product_id: PRODUCT, batch_id: BATCH_2, quantity: 1, unit_price: 700, discount_amount: 0 },
        ],
      }),
    )
    expect(appendClinicalChargeBestEffort.mock.calls.map(([, charge]) => ({
      unitPrice: charge.unitPrice,
      qty: charge.qty,
    }))).toEqual([
      { unitPrice: 500, qty: 2 },
      { unitPrice: 700, qty: 1 },
    ])
  })

  it("returns 409 and dispenses nothing when the safety check blocks", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(
      tableMock({
        clinical_prescriptions: { data: rxRow({ status: "verified", verifier_id: PHARMACIST }) },
        pharmacy_products: { data: { id: PRODUCT, price: 500, name: "Warfarin 5mg", is_active: true } },
        pharmacy_product_batches: {
          rows: [{
            id: BATCH,
            quantity: 20,
            expiry_date: "2028-12-31",
            status: "active",
            is_active: true,
            selling_price: 500,
          }],
        },
      }),
    )
    runClinicalSafetyCheck.mockResolvedValue(blockingSafety())

    const { POST } = await import("./route")
    const res = await POST(postBody(validBody()))

    expect(res.status).toBe(409)
    const json = await res.json()
    expect(json.error).toBe("clinical_safety_block")
    expect(json.safety.blockingAlerts).toContain("allergy_match:a9:p")
    expect(dbRpc).not.toHaveBeenCalled()
    expect(logHospitalAudit).not.toHaveBeenCalled()
  })

  it("checks the product actually being handed over, using its generic and ingredient names", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(
      tableMock({
        clinical_prescriptions: { data: rxRow({ status: "verified", verifier_id: PHARMACIST, quantity: 3 }) },
        pharmacy_products: {
          data: {
            id: PRODUCT,
            price: 500,
            name: "Cataflam 50mg",
            generic_name: "Diclofenac potassium",
            active_ingredient: "Diclofenac",
            is_active: true,
          },
        },
        pharmacy_product_batches: {
          rows: [{
            id: BATCH,
            quantity: 20,
            expiry_date: "2028-12-31",
            status: "active",
            is_active: true,
            selling_price: 500,
          }],
        },
        department_tasks: { data: null },
        billing_invoices: { data: null },
      }),
    )

    const { POST } = await import("./route")
    await POST(postBody(validBody()))

    expect(runClinicalSafetyCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "dispense",
        patientId: PATIENT,
        encounterId: ENCOUNTER,
        actorId: PHARMACIST,
        newDrugs: [
          {
            label: "Cataflam 50mg",
            aliases: ["Diclofenac potassium", "Diclofenac", "Paracetamol 500mg"],
            productId: PRODUCT,
            role: "new",
          },
        ],
      }),
    )
  })

  it("proceeds past a block when the pharmacist records an override reason", async () => {
    requireHospitalStaffContext.mockResolvedValue(staffCtx())
    dbFrom.mockImplementation(
      tableMock({
        clinical_prescriptions: { data: rxRow({ status: "verified", verifier_id: PHARMACIST, quantity: 3 }) },
        pharmacy_products: { data: { id: PRODUCT, price: 500, name: "Warfarin 5mg", is_active: true } },
        pharmacy_product_batches: {
          rows: [{
            id: BATCH,
            quantity: 20,
            expiry_date: "2028-12-31",
            status: "active",
            is_active: true,
            selling_price: 500,
          }],
        },
        department_tasks: { data: null },
        billing_invoices: { data: null },
      }),
    )
    runClinicalSafetyCheck.mockResolvedValue(blockingSafety())

    const { POST } = await import("./route")
    const res = await POST(
      postBody(validBody({ safety_override_reason: "Prescriber confirmed; INR monitored daily" })),
    )

    expect(res.status).toBe(200)
    expect(runClinicalSafetyCheck).toHaveBeenCalledWith(
      expect.objectContaining({ overrideReason: "Prescriber confirmed; INR monitored daily" }),
    )
    expect(dbRpc).toHaveBeenCalled()
  })
})
