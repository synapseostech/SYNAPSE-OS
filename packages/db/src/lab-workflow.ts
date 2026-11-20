/**
 * Synapse Lab order → result state machine.
 * Reuses lab_orders / lab_specimens / lab_results concepts. Never silently
 * overwrites a verified result. AI is not a verifier.
 *
 * Malaria golden-journey LOINC: 58413-6 (Pf antigen).
 */

export const MALARIA_PF_ANTIGEN_LOINC = "58413-6" as const
export const MALARIA_PF_ANTIGEN_TEST_NAME = "Malaria Pf antigen" as const

export const LAB_ORDER_STATUSES = [
  "ORDERED",
  "COLLECTION_PENDING",
  "COLLECTED",
  "IN_TRANSIT",
  "RECEIVED",
  "REJECTED",
  "PROCESSING",
  "RESULT_ENTERED",
  "VERIFICATION_PENDING",
  "VERIFIED",
  "RELEASED",
  "AMENDED",
  "CANCELLED",
] as const

export type LabOrderStatus = (typeof LAB_ORDER_STATUSES)[number]

export const SPECIMEN_REJECTION_REASONS = [
  "hemolyzed",
  "clotted",
  "insufficient_volume",
  "unlabelled",
  "mislabeled",
  "wrong_container",
  "leaked",
  "too_old",
  "contaminated",
  "patient_mismatch",
  "other",
] as const

export type SpecimenRejectionReason = (typeof SPECIMEN_REJECTION_REASONS)[number]

export type AbnormalFlag = "N" | "H" | "L" | "HH" | "LL" | "A" | "AA" | "CRIT"

export type LabReferenceRange = {
  loincCode: string
  testName: string
  unit: string
  sex?: "M" | "F" | "I" | "U" | null
  ageMinYears?: number | null
  ageMaxYears?: number | null
  low: number
  high: number
  criticalLow?: number | null
  criticalHigh?: number | null
}

export type LabOrder = {
  id: string
  tenantId: string
  patientId: string
  personId?: string | null
  encounterId: string
  carePlanId?: string | null
  loincCode: string
  testName: string
  urgency: "STAT" | "URGENT" | "ROUTINE"
  status: LabOrderStatus
  orderedBy: string
  orderedAt: string
  accessionNumber?: string | null
  barcode?: string | null
  specimenId?: string | null
  rejectionReason?: SpecimenRejectionReason | null
  rejectionNote?: string | null
  isSynthetic: boolean
  simulationRunId?: string | null
  correlationId: string
  /** Prior rejected order this replacement recollects; null for original orders. */
  replacesLabOrderId?: string | null
}

export type LabResult = {
  id: string
  labOrderId: string
  tenantId: string
  patientId: string
  loincCode: string
  testName: string
  resultValue: string
  numericValue: number | null
  unit: string
  referenceRange: string
  flag: AbnormalFlag
  isCritical: boolean
  isAbnormal: boolean
  status: "preliminary" | "final" | "amended" | "cancelled"
  analyzer?: string | null
  verifiedBy?: string | null
  verifiedAt?: string | null
  releasedAt?: string | null
  version: number
  provenance: "LAB_VERIFIED" | "IMPORTED" | "SYSTEM_GENERATED"
  isSynthetic: boolean
}

export type LabAmendment = {
  id: string
  resultId: string
  previousValue: string
  previousStatus: string
  newValue: string
  reason: string
  amendedBy: string
  amendedAt: string
}

export type CriticalAcknowledgement = {
  id: string
  resultId: string
  labOrderId: string
  acknowledgedBy: string
  acknowledgedAt: string
  note?: string | null
}

const ALLOWED: Record<LabOrderStatus, LabOrderStatus[]> = {
  ORDERED: ["COLLECTION_PENDING", "CANCELLED"],
  COLLECTION_PENDING: ["COLLECTED", "CANCELLED"],
  COLLECTED: ["IN_TRANSIT", "RECEIVED", "REJECTED", "CANCELLED"],
  IN_TRANSIT: ["RECEIVED", "REJECTED", "CANCELLED"],
  RECEIVED: ["PROCESSING", "REJECTED", "CANCELLED"],
  REJECTED: [],
  PROCESSING: ["RESULT_ENTERED", "REJECTED", "CANCELLED"],
  RESULT_ENTERED: ["VERIFICATION_PENDING", "CANCELLED"],
  VERIFICATION_PENDING: ["VERIFIED", "CANCELLED"],
  VERIFIED: ["RELEASED", "AMENDED"],
  RELEASED: ["AMENDED"],
  // A released report can be amended again (version 3, 4, ...).
  AMENDED: ["RELEASED", "AMENDED"],
  CANCELLED: [],
}

export const DEMO_REFERENCE_RANGES: LabReferenceRange[] = [
  {
    loincCode: "2524-7",
    testName: "Lactate",
    unit: "mmol/L",
    low: 0.5,
    high: 2.0,
    criticalHigh: 4.0,
  },
  {
    loincCode: "6690-2",
    testName: "WBC",
    unit: "10*9/L",
    low: 4.0,
    high: 11.0,
    criticalLow: 1.0,
    criticalHigh: 30.0,
  },
  {
    loincCode: "2345-7",
    testName: "Glucose",
    unit: "mmol/L",
    low: 3.9,
    high: 6.1,
    criticalLow: 2.2,
    criticalHigh: 30.0,
  },
  {
    loincCode: "2951-2",
    testName: "Sodium",
    unit: "mmol/L",
    low: 135,
    high: 145,
    criticalLow: 120,
    criticalHigh: 160,
  },
  {
    loincCode: "2823-3",
    testName: "Potassium",
    unit: "mmol/L",
    low: 3.5,
    high: 5.1,
    criticalLow: 2.5,
    criticalHigh: 6.5,
  },
  {
    loincCode: "58413-6",
    testName: "Malaria Pf antigen",
    unit: "arb",
    low: 0,
    high: 0,
  },
]

export function canTransitionLabStatus(from: LabOrderStatus, to: LabOrderStatus): boolean {
  return ALLOWED[from].includes(to)
}

export function assertLabTransition(from: LabOrderStatus, to: LabOrderStatus): void {
  if (!canTransitionLabStatus(from, to)) {
    const allowed = ALLOWED[from]
    const hint =
      allowed.length === 0
        ? `${from} is terminal`
        : `allowed next: ${allowed.join(", ")}`
    throw new Error(`LAB_ILLEGAL_TRANSITION:${from}->${to} (${hint})`)
  }
}

export function nextLabStatuses(from: LabOrderStatus): LabOrderStatus[] {
  return [...ALLOWED[from]]
}

export function formatAccession(tenantCode: string, seq: number, date = new Date()): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, "0")
  const d = String(date.getUTCDate()).padStart(2, "0")
  return `${tenantCode}-${y}${m}${d}-${String(seq).padStart(5, "0")}`
}

export function barcodeFromAccession(accession: string): string {
  return accession.replace(/[^A-Z0-9]/gi, "").toUpperCase()
}

export function parseNumericResult(value: string): number | null {
  const match = value.trim().replace(",", ".").match(/-?\d+(\.\d+)?/)
  if (!match) return null
  const n = Number(match[0])
  return Number.isFinite(n) ? n : null
}

export function interpretResult(params: {
  loincCode: string
  value: string
  sex?: "M" | "F" | "I" | "U" | null
  ageYears?: number | null
  ranges?: LabReferenceRange[]
}): {
  flag: AbnormalFlag
  isCritical: boolean
  isAbnormal: boolean
  range: LabReferenceRange | null
  referenceRange: string
} {
  const ranges = params.ranges ?? DEMO_REFERENCE_RANGES
  const range =
    ranges.find((item) => {
      if (item.loincCode !== params.loincCode) return false
      if (item.sex && params.sex && item.sex !== params.sex && params.sex !== "U") return false
      if (item.ageMinYears != null && params.ageYears != null && params.ageYears < item.ageMinYears) return false
      if (item.ageMaxYears != null && params.ageYears != null && params.ageYears > item.ageMaxYears) return false
      return true
    }) ?? null

  if (!range) {
    // Qualitative tests (RDTs, serology) rarely carry a numeric interval: read
    // the wording so a "Positive" malaria RDT is flagged without a range row.
    if (parseNumericResult(params.value) == null) {
      if (/\b(positive|detected|reactive|seen)\b/i.test(params.value) && !/\b(non[- ]?reactive|not detected|not seen)\b/i.test(params.value)) {
        return { flag: "A", isCritical: false, isAbnormal: true, range: null, referenceRange: "Negative" }
      }
      if (/\b(negative|not detected|non[- ]?reactive|not seen|nil)\b/i.test(params.value)) {
        return { flag: "N", isCritical: false, isAbnormal: false, range: null, referenceRange: "Negative" }
      }
    }
    return { flag: "A", isCritical: false, isAbnormal: false, range: null, referenceRange: "not established" }
  }

  const numeric = parseNumericResult(params.value)
  if (numeric == null) {
    const positive = /positive|detected|reactive/i.test(params.value)
    return {
      flag: positive ? "A" : "N",
      isCritical: false,
      isAbnormal: positive,
      range,
      referenceRange: `${range.low}–${range.high} ${range.unit}`,
    }
  }

  let flag: AbnormalFlag = "N"
  if (range.criticalHigh != null && numeric >= range.criticalHigh) flag = "CRIT"
  else if (range.criticalLow != null && numeric <= range.criticalLow) flag = "CRIT"
  else if (numeric > range.high) flag = numeric > range.high * 1.5 ? "HH" : "H"
  else if (numeric < range.low) flag = numeric < range.low * 0.5 ? "LL" : "L"

  return {
    flag,
    isCritical: flag === "CRIT",
    isAbnormal: flag !== "N",
    range,
    referenceRange: `${range.low}–${range.high} ${range.unit}`,
  }
}

export function persistableLabOrderStatus(status: LabOrderStatus): string {
  switch (status) {
    case "ORDERED":
    case "COLLECTION_PENDING":
      return "ordered"
    case "COLLECTED":
    case "IN_TRANSIT":
      return "collected"
    case "RECEIVED":
    case "PROCESSING":
      return "processing"
    case "RESULT_ENTERED":
    case "VERIFICATION_PENDING":
      return "resulted"
    case "VERIFIED":
    case "RELEASED":
    case "AMENDED":
      return "verified"
    case "REJECTED":
    case "CANCELLED":
      return "cancelled"
  }
}

export class LabWorkflow {
  private orders: LabOrder[]
  private results: LabResult[]
  private amendments: LabAmendment[]
  private acknowledgements: CriticalAcknowledgement[]

  constructor(
    orders: LabOrder[] = [],
    results: LabResult[] = [],
    amendments: LabAmendment[] = [],
    acknowledgements: CriticalAcknowledgement[] = [],
  ) {
    this.orders = orders
    this.results = results
    this.amendments = amendments
    this.acknowledgements = acknowledgements
  }

  createOrder(order: LabOrder): LabOrder {
    this.orders.push(order)
    return order
  }

  getOrder(id: string): LabOrder {
    const order = this.orders.find((row) => row.id === id)
    if (!order) throw new Error("LAB_ORDER_NOT_FOUND")
    return order
  }

  transition(orderId: string, to: LabOrderStatus, patch?: Partial<LabOrder>): LabOrder {
    const order = this.getOrder(orderId)
    assertLabTransition(order.status, to)
    Object.assign(order, patch, { status: to })
    return order
  }

  collect(orderId: string, accessionNumber: string, barcode: string, specimenId: string): LabOrder {
    const order = this.getOrder(orderId)
    // Retry after a committed collect (audit/network) must not mint a second specimen.
    if (
      order.status !== "ORDERED" &&
      order.status !== "COLLECTION_PENDING" &&
      order.status !== "REJECTED" &&
      order.status !== "CANCELLED"
    ) {
      return order
    }
    if (order.status === "ORDERED") {
      this.transition(orderId, "COLLECTION_PENDING")
    }
    return this.transition(orderId, "COLLECTED", { accessionNumber, barcode, specimenId })
  }

  receive(orderId: string): LabOrder {
    const order = this.getOrder(orderId)
    if (order.status === "COLLECTED") this.transition(orderId, "IN_TRANSIT")
    const current = this.getOrder(orderId)
    if (current.status === "IN_TRANSIT") return this.transition(orderId, "RECEIVED")
    if (current.status === "RECEIVED") return current
    return this.transition(orderId, "RECEIVED")
  }

  reject(orderId: string, reason: SpecimenRejectionReason, note?: string): LabOrder {
    return this.transition(orderId, "REJECTED", { rejectionReason: reason, rejectionNote: note ?? null })
  }

  enterResult(params: {
    resultId: string
    orderId: string
    value: string
    analyzer?: string | null
    sex?: "M" | "F" | "I" | "U" | null
    ageYears?: number | null
    /** Tenant / national reference ranges for this test; defaults to DEMO_REFERENCE_RANGES. */
    ranges?: LabReferenceRange[]
    /** Unit to report when no reference range matches (from the test catalogue). */
    unit?: string | null
  }): { order: LabOrder; result: LabResult } {
    const order = this.getOrder(params.orderId)
    const existing = this.results.find((row) => row.labOrderId === params.orderId)
    if (existing && (existing.status === "final" || existing.status === "amended")) {
      throw new Error("LAB_RESULT_LOCKED:verified results require amend()")
    }
    if (
      order.status === "VERIFIED" ||
      order.status === "RELEASED" ||
      order.status === "AMENDED" ||
      order.status === "RESULT_ENTERED" ||
      order.status === "VERIFICATION_PENDING"
    ) {
      throw new Error(
        `LAB_RESULT_LOCKED:cannot enter result while status is ${order.status}; use amend() after verification`,
      )
    }
    if (order.status === "RECEIVED") this.transition(order.id, "PROCESSING")
    const processing = this.getOrder(order.id)
    if (processing.status !== "PROCESSING") {
      throw new Error(
        `LAB_ENTER_REFUSED:expected PROCESSING (after RECEIVED), got ${processing.status}`,
      )
    }
    this.transition(order.id, "RESULT_ENTERED")
    const interp = interpretResult({
      loincCode: order.loincCode,
      value: params.value,
      sex: params.sex,
      ageYears: params.ageYears,
      ranges: params.ranges,
    })
    const result: LabResult = {
      id: params.resultId,
      labOrderId: order.id,
      tenantId: order.tenantId,
      patientId: order.patientId,
      loincCode: order.loincCode,
      testName: order.testName,
      resultValue: params.value,
      numericValue: parseNumericResult(params.value),
      unit: interp.range?.unit ?? params.unit ?? "",
      referenceRange: interp.referenceRange,
      flag: interp.flag,
      isCritical: interp.isCritical,
      isAbnormal: interp.isAbnormal,
      status: "preliminary",
      analyzer: params.analyzer ?? null,
      version: 1,
      provenance: "SYSTEM_GENERATED",
      isSynthetic: order.isSynthetic,
    }
    if (existing) {
      Object.assign(existing, result)
    } else {
      this.results.push(result)
    }
    this.transition(order.id, "VERIFICATION_PENDING")
    return { order: this.getOrder(order.id), result: this.results.find((row) => row.labOrderId === order.id)! }
  }

  /**
   * Human lab verification only. There is intentionally no AI / model path.
   * First call requires RESULT_ENTERED or VERIFICATION_PENDING.
   * Retry after a committed verify/release/amend is idempotent (audit-fail / lost-ack).
   */
  verify(orderId: string, verifierId: string, at = new Date().toISOString()): LabResult {
    if (!verifierId || verifierId.trim().length === 0) {
      throw new Error("LAB_VERIFIER_REQUIRED:human verifierId is mandatory")
    }
    if (/^(ai[_-]|model|copilot|assistant)/i.test(verifierId.trim())) {
      throw new Error("LAB_AI_CANNOT_VERIFY:AI actors cannot verify lab results")
    }
    const order = this.getOrder(orderId)
    if (order.status === "VERIFIED" || order.status === "RELEASED" || order.status === "AMENDED") {
      const existing = this.results.find((row) => row.labOrderId === orderId)
      if (!existing) throw new Error("LAB_RESULT_NOT_FOUND")
      return existing
    }
    if (order.status !== "RESULT_ENTERED" && order.status !== "VERIFICATION_PENDING") {
      throw new Error(
        `LAB_VERIFY_REFUSED:expected RESULT_ENTERED or VERIFICATION_PENDING, got ${order.status}`,
      )
    }
    if (order.status === "RESULT_ENTERED") {
      this.transition(order.id, "VERIFICATION_PENDING")
    }
    this.transition(order.id, "VERIFIED")
    const result = this.results.find((row) => row.labOrderId === orderId)
    if (!result) throw new Error("LAB_RESULT_NOT_FOUND")
    result.status = "final"
    result.verifiedBy = verifierId
    result.verifiedAt = at
    result.provenance = "LAB_VERIFIED"
    return result
  }

  release(orderId: string, at = new Date().toISOString()): LabResult {
    const order = this.getOrder(orderId)
    if (order.status === "RELEASED") {
      const existing = this.results.find((row) => row.labOrderId === orderId)
      if (!existing) throw new Error("LAB_RESULT_NOT_FOUND")
      return existing
    }
    this.transition(orderId, "RELEASED")
    const result = this.results.find((row) => row.labOrderId === orderId)
    if (!result) throw new Error("LAB_RESULT_NOT_FOUND")
    result.releasedAt = at
    return result
  }

  amend(params: {
    amendmentId: string
    orderId: string
    newValue: string
    reason: string
    amendedBy: string
    sex?: "M" | "F" | "I" | "U" | null
    ageYears?: number | null
    ranges?: LabReferenceRange[]
  }): { result: LabResult; amendment: LabAmendment } {
    const result = this.results.find((row) => row.labOrderId === params.orderId)
    if (!result) throw new Error("LAB_RESULT_NOT_FOUND")
    if (result.status !== "final" && result.status !== "amended") {
      throw new Error("LAB_AMEND_REQUIRES_VERIFIED")
    }
    const prior = this.amendments.find((row) => row.id === params.amendmentId)
    if (prior) {
      if (prior.resultId !== result.id || prior.newValue !== params.newValue ||
          prior.reason !== params.reason || prior.amendedBy !== params.amendedBy) {
        throw new Error("LAB_AMEND_IDEMPOTENCY_CONFLICT")
      }
      return { result, amendment: prior }
    }
    const previousValue = result.resultValue
    const previousStatus = result.status
    const interp = interpretResult({
      loincCode: result.loincCode,
      value: params.newValue,
      sex: params.sex,
      ageYears: params.ageYears,
      ranges: params.ranges,
    })
    result.resultValue = params.newValue
    result.numericValue = parseNumericResult(params.newValue)
    result.flag = interp.flag
    result.isCritical = interp.isCritical
    result.isAbnormal = interp.isAbnormal
    result.referenceRange = interp.referenceRange
    result.status = "amended"
    result.version += 1
    this.transition(params.orderId, "AMENDED")
    const amendment: LabAmendment = {
      id: params.amendmentId,
      resultId: result.id,
      previousValue,
      previousStatus,
      newValue: params.newValue,
      reason: params.reason,
      amendedBy: params.amendedBy,
      amendedAt: new Date().toISOString(),
    }
    this.amendments.push(amendment)
    return { result, amendment }
  }

  acknowledgeCritical(params: {
    id: string
    orderId: string
    acknowledgedBy: string
    note?: string
  }): CriticalAcknowledgement {
    const result = this.results.find((row) => row.labOrderId === params.orderId)
    if (!result) throw new Error("LAB_RESULT_NOT_FOUND")
    if (!result.isCritical) throw new Error("LAB_NOT_CRITICAL")
    if (result.status !== "final" && result.status !== "amended") {
      throw new Error("LAB_ACK_REQUIRES_VERIFIED")
    }
    const ack: CriticalAcknowledgement = {
      id: params.id,
      resultId: result.id,
      labOrderId: params.orderId,
      acknowledgedBy: params.acknowledgedBy,
      acknowledgedAt: new Date().toISOString(),
      note: params.note ?? null,
    }
    this.acknowledgements.push(ack)
    return ack
  }

  snapshot() {
    return {
      orders: [...this.orders],
      results: [...this.results],
      amendments: [...this.amendments],
      acknowledgements: [...this.acknowledgements],
    }
  }
}

/** Domain events emitted along the malaria lab vertical slice (correlation_id required). */
export const MALARIA_LAB_SLICE_EVENTS = [
  "LabOrderCreated",
  "SpecimenCollected",
  "SpecimenReceived",
  "LabResultEntered",
  "LabResultVerified",
  "LabResultReleased",
] as const

export type MalariaLabSliceEventType = (typeof MALARIA_LAB_SLICE_EVENTS)[number]

export type MalariaLabSliceEvent = {
  eventType: MalariaLabSliceEventType
  action: string
  aggregateId: string
  correlationId: string
  payload: Record<string, unknown>
}

export type MalariaLabSliceInput = {
  tenantId: string
  patientId: string
  personId?: string | null
  encounterId: string
  carePlanId?: string | null
  orderedBy: string
  verifierId: string
  correlationId: string
  orderId?: string
  resultId?: string
  specimenId?: string
  accessionSeq?: number
  tenantCode?: string
  /** Default "Positive" for Pf antigen golden journey. */
  value?: string
  isSynthetic?: boolean
  simulationRunId?: string | null
  now?: Date
  sex?: "M" | "F" | "I" | "U" | null
  ageYears?: number | null
  /** Optional existing workflow instance (Agent 2 can share one LabWorkflow). */
  lab?: LabWorkflow
}

export type MalariaLabSliceResult = {
  lab: LabWorkflow
  order: LabOrder
  result: LabResult
  accession: string
  barcode: string
  statuses: LabOrderStatus[]
  events: MalariaLabSliceEvent[]
}

/**
 * Order → Collect → Receive → Enter Positive → Verify → Release.
 * Pure in-memory slice for Agent 2's `runMalariaGoldenJourney` and unit tests.
 * Callers emit `events` via ExchangeOutbox with the same correlationId.
 */
export function runMalariaLabSlice(input: MalariaLabSliceInput): MalariaLabSliceResult {
  if (!input.correlationId?.trim()) {
    throw new Error("LAB_CORRELATION_REQUIRED")
  }
  const lab = input.lab ?? new LabWorkflow()
  const now = input.now ?? new Date()
  const orderId = input.orderId ?? crypto.randomUUID()
  const resultId = input.resultId ?? crypto.randomUUID()
  const specimenId = input.specimenId ?? crypto.randomUUID()
  const accession = formatAccession(input.tenantCode ?? "DEMO", input.accessionSeq ?? 1, now)
  const barcode = barcodeFromAccession(accession)
  const value = input.value ?? "Positive"
  const statuses: LabOrderStatus[] = []

  const order = lab.createOrder({
    id: orderId,
    tenantId: input.tenantId,
    patientId: input.patientId,
    personId: input.personId ?? null,
    encounterId: input.encounterId,
    carePlanId: input.carePlanId ?? null,
    loincCode: MALARIA_PF_ANTIGEN_LOINC,
    testName: MALARIA_PF_ANTIGEN_TEST_NAME,
    urgency: "URGENT",
    status: "ORDERED",
    orderedBy: input.orderedBy,
    orderedAt: now.toISOString(),
    isSynthetic: input.isSynthetic ?? true,
    simulationRunId: input.simulationRunId ?? null,
    correlationId: input.correlationId,
  })
  statuses.push(order.status)

  const events: MalariaLabSliceEvent[] = [
    {
      eventType: "LabOrderCreated",
      action: "create",
      aggregateId: order.id,
      correlationId: input.correlationId,
      payload: {
        loincCode: order.loincCode,
        testName: order.testName,
        urgency: order.urgency,
      },
    },
  ]

  lab.collect(order.id, accession, barcode, specimenId)
  statuses.push(lab.getOrder(order.id).status)
  events.push({
    eventType: "SpecimenCollected",
    action: "collect",
    aggregateId: order.id,
    correlationId: input.correlationId,
    payload: { accession, barcode, specimenId },
  })

  lab.receive(order.id)
  statuses.push(lab.getOrder(order.id).status)
  events.push({
    eventType: "SpecimenReceived",
    action: "receive",
    aggregateId: order.id,
    correlationId: input.correlationId,
    payload: { accession },
  })

  const entered = lab.enterResult({
    resultId,
    orderId: order.id,
    value,
    sex: input.sex,
    ageYears: input.ageYears,
  })
  statuses.push(lab.getOrder(order.id).status)
  events.push({
    eventType: "LabResultEntered",
    action: "enter",
    aggregateId: entered.result.id,
    correlationId: input.correlationId,
    payload: {
      value: entered.result.resultValue,
      flag: entered.result.flag,
      isAbnormal: entered.result.isAbnormal,
      loincCode: entered.result.loincCode,
    },
  })

  const verified = lab.verify(order.id, input.verifierId, now.toISOString())
  statuses.push(lab.getOrder(order.id).status)
  events.push({
    eventType: "LabResultVerified",
    action: "verify",
    aggregateId: verified.id,
    correlationId: input.correlationId,
    payload: {
      value: verified.resultValue,
      flag: verified.flag,
      isAbnormal: verified.isAbnormal,
      verifiedBy: verified.verifiedBy,
      provenance: verified.provenance,
    },
  })

  const released = lab.release(order.id, now.toISOString())
  statuses.push(lab.getOrder(order.id).status)
  events.push({
    eventType: "LabResultReleased",
    action: "release",
    aggregateId: released.id,
    correlationId: input.correlationId,
    payload: {
      value: released.resultValue,
      releasedAt: released.releasedAt,
      accession,
    },
  })

  return {
    lab,
    order: lab.getOrder(order.id),
    result: released,
    accession,
    barcode,
    statuses,
    events,
  }
}
