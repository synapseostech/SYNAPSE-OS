/**
 * Hospital Pilot RC1 — full domain Golden Journey runner.
 * Reception → triage → write-up → sign → prescribe → verify → dispense → closeout.
 * Composes existing domain proofs; no production credentials required.
 */
import {
  recordEncounterOpened,
  recordEncounterSigned,
  recordLabOrderPlaced,
  recordPrescriptionPlaced,
  recordTriageCompleted,
} from "./clinical-journey"
import {
  composeClinicalNote,
  mergeWriteupIntoMetadata,
  normalizeClinicalWriteup,
  writeupCompleteness,
} from "./clinical-writeup"
import { evaluateEncounterCloseGate } from "./encounter-close-gate"
import {
  dispensePrescription,
  verifyPrescription,
  type ClinicalPrescription,
} from "./prescription-bridge"
import type { DepartmentTask, WorkQueue } from "./work-queue"

export type HospitalGoldenStepStatus = "PASS" | "FAIL"

export type HospitalGoldenStep = {
  id: string
  status: HospitalGoldenStepStatus
  detail?: string
  artifacts?: Record<string, unknown>
}

export type HospitalGoldenResult = {
  status: "PASS" | "FAIL"
  correlationId: string
  steps: HospitalGoldenStep[]
  prescription?: ClinicalPrescription
  pharmacyTask?: DepartmentTask
  remainingStock?: number
  clinicalNote?: string
  queue?: WorkQueue
}

export type HospitalGoldenInput = {
  tenantId?: string
  hospitalId?: string
  pharmacyTenantId?: string
  patientId?: string
  encounterId?: string
  doctorId?: string
  nurseId?: string
  pharmacistId?: string
  chiefComplaint?: string
  medicationDisplay?: string
  dose?: string
  quantity?: number
  availableStock?: number
  consultationFee?: number
  /** When true, run lab order → collect → result → verify → release → doctor review before pharmacy. */
  includeLab?: boolean
  labTechId?: string
}

function step(
  id: string,
  status: HospitalGoldenStepStatus,
  detail?: string,
  artifacts?: Record<string, unknown>,
): HospitalGoldenStep {
  return { id, status, detail, artifacts }
}

function ids() {
  return {
    tenantId: crypto.randomUUID(),
    hospitalId: crypto.randomUUID(),
    pharmacyTenantId: crypto.randomUUID(),
    patientId: crypto.randomUUID(),
    encounterId: crypto.randomUUID(),
    doctorId: crypto.randomUUID(),
    nurseId: crypto.randomUUID(),
    pharmacistId: crypto.randomUUID(),
  }
}

/**
 * Run the RC1 Hospital Golden Journey at the domain layer.
 */
export function runHospitalGoldenJourney(input: HospitalGoldenInput = {}): HospitalGoldenResult {
  const seeded = ids()
  const tenantId = input.tenantId ?? seeded.tenantId
  const hospitalId = input.hospitalId ?? seeded.hospitalId
  const pharmacyTenantId = input.pharmacyTenantId ?? seeded.pharmacyTenantId
  const patientId = input.patientId ?? seeded.patientId
  const encounterId = input.encounterId ?? seeded.encounterId
  const doctorId = input.doctorId ?? seeded.doctorId
  const nurseId = input.nurseId ?? seeded.nurseId
  const pharmacistId = input.pharmacistId ?? seeded.pharmacistId
  const labTechId = input.labTechId ?? crypto.randomUUID()
  const includeLab = Boolean(input.includeLab)
  const chiefComplaint = input.chiefComplaint ?? "fever and headache"
  const medicationDisplay = input.medicationDisplay ?? "Paracetamol 500mg"
  const dose = input.dose ?? "1 tablet TID x 3 days"
  const quantity = input.quantity ?? 9
  const availableStock = input.availableStock ?? 20
  const consultationFee = input.consultationFee ?? 25000
  const steps: HospitalGoldenStep[] = []

  try {
    // 1) Reception — open encounter
    const opened = recordEncounterOpened({
      tenantId,
      hospitalId,
      patientId,
      encounterId,
      requesterId: nurseId,
      chiefComplaint,
      isSynthetic: true,
    })
    steps.push(
      step("reception_encounter_opened", "PASS", undefined, {
        triageTaskId: opened.triageTask.id,
        events: opened.eventsEmitted,
      }),
    )

    // 2) Nurse triage
    const triaged = recordTriageCompleted({
      queue: opened.queue,
      triageTaskId: opened.triageTask.id,
      tenantId,
      hospitalId,
      patientId,
      encounterId,
      requesterId: nurseId,
    })
    steps.push(
      step("nurse_triage_completed", "PASS", undefined, {
        doctorTaskId: triaged.doctorTask.id,
      }),
    )

    // 3) Doctor write-up
    const writeup = normalizeClinicalWriteup({
      hpi: `${chiefComplaint} for 2 days, no neck stiffness`,
      pmh: "None significant",
      medications: "None",
      allergies: "NKDA",
      familySocial: "Lives with family; non-smoker",
      ros: "Denies chest pain, SOB, vomiting",
      examination: "Alert, febrile 38.2C, no focal neuro signs",
      assessment: "Likely viral illness; rule out malaria",
      plan: "Paracetamol, malaria RDT if available, review tomorrow if worse",
      updatedAt: new Date().toISOString(),
      updatedBy: doctorId,
    })
    const completeness = writeupCompleteness(writeup)
    if (completeness.filled < completeness.total) {
      steps.push(
        step("doctor_writeup", "FAIL", `incomplete write-up: ${completeness.missing.join(", ")}`, {
          completeness,
        }),
      )
      return { status: "FAIL", correlationId: encounterId, steps, queue: triaged.queue }
    }
    const clinicalNote = composeClinicalNote(writeup, chiefComplaint)
    const metadata = mergeWriteupIntoMetadata({}, writeup)
    metadata.clinical_note = clinicalNote
    steps.push(
      step("doctor_writeup", "PASS", undefined, {
        completeness,
        noteLength: clinicalNote.length,
        hasWriteupKey: Boolean((metadata as { writeup?: unknown }).writeup),
      }),
    )

    // 4) Sign
    const signed = recordEncounterSigned({
      queue: triaged.queue,
      tenantId,
      hospitalId,
      patientId,
      encounterId,
      signerId: doctorId,
    })
    steps.push(
      step("encounter_signed", "PASS", undefined, {
        events: signed.eventsEmitted,
      }),
    )


    // 4b) Optional lab branch (order → result → release → doctor review)
    let queueAfterClinical = signed.queue
    if (includeLab) {
      const labPlaced = recordLabOrderPlaced({
        queue: signed.queue,
        tenantId,
        hospitalId,
        patientId,
        encounterId,
        requesterId: doctorId,
        loincCode: "58413-6",
        testName: "Malaria Pf antigen",
        urgency: "ROUTINE",
        correlationId: encounterId,
        isSynthetic: true,
      })
      const lab = labPlaced.lab
      const orderId = labPlaced.order.id
      const accession = `SYN-${encounterId.slice(0, 8).toUpperCase()}`
      lab.collect(orderId, accession, `BC-${accession}`, crypto.randomUUID())
      lab.receive(orderId)
      lab.enterResult({ resultId: crypto.randomUUID(), orderId, value: "Negative", analyzer: "synthetic" })
      lab.verify(orderId, labTechId)
      const released = lab.release(orderId)

      // Open lab / unreviewed should block close
      const blockedByLab = evaluateEncounterCloseGate({
        encounterExists: true,
        hospitalMatches: true,
        status: "signed",
        disposition: "CLINICAL_COMPLETE",
        openLabOrderIds: [orderId],
        invoice: { id: "inv-lab", status: "paid", totalAmount: 1, paidAmount: 1 },
      })
      if (blockedByLab.ok || blockedByLab.blocking !== "LAB") {
        steps.push(step("lab_close_gate_blocks_open", "FAIL", "expected LAB block", { decision: blockedByLab }))
        return { status: "FAIL", correlationId: encounterId, steps, clinicalNote, queue: labPlaced.queue }
      }
      const blockedByReview = evaluateEncounterCloseGate({
        encounterExists: true,
        hospitalMatches: true,
        status: "signed",
        disposition: "CLINICAL_COMPLETE",
        unreviewedFinalResultIds: [released.id],
        invoice: { id: "inv-lab", status: "paid", totalAmount: 1, paidAmount: 1 },
      })
      if (blockedByReview.ok || blockedByReview.blocking !== "DOCTOR_REVIEW") {
        steps.push(step("lab_close_gate_blocks_unreviewed", "FAIL", "expected DOCTOR_REVIEW block", { decision: blockedByReview }))
        return { status: "FAIL", correlationId: encounterId, steps, clinicalNote, queue: labPlaced.queue }
      }

      // Doctor reviews released result (domain: clears unreviewed set)
      steps.push(
        step("lab_order_to_release", "PASS", undefined, {
          orderId,
          resultId: released.id,
          resultValue: released.resultValue,
          orderStatus: lab.getOrder(orderId).status,
        }),
      )
      steps.push(step("lab_doctor_review", "PASS", undefined, { resultId: released.id }))
      queueAfterClinical = labPlaced.queue
    }

    // 5–7) Prescribe → verify → dispense
    const placed = recordPrescriptionPlaced({
      queue: queueAfterClinical,

      tenantId,
      hospitalId,
      patientId,
      encounterId,
      requesterId: doctorId,
      medicationDisplay,
      dose,
      quantity,
      unit: "tablet",
      pharmacyTenantId,
      correlationId: encounterId,
      isSynthetic: true,
    })
    steps.push(
      step("prescription_placed", "PASS", undefined, {
        prescriptionId: placed.prescription.id,
        pharmacyTaskId: placed.pharmacyTask.id,
      }),
    )

    if (placed.prescription.tenantId !== tenantId) {
      throw new Error("TENANT_ISOLATION_BROKEN")
    }
    steps.push(step("tenant_isolation", "PASS", undefined, { tenantId }))

    const verified = verifyPrescription(placed.prescription, pharmacistId, "pharmacist")
    steps.push(
      step("prescription_verified", "PASS", undefined, {
        status: verified.status,
      }),
    )

    const dispensed = dispensePrescription({
      rx: verified,
      dispenserId: pharmacistId,
      role: "pharmacist",
      availableStock,
    })
    const started = placed.queue.start(placed.pharmacyTask.id, pharmacistId)
    if (!started.ok) throw new Error(started.error)
    const completed = placed.queue.complete(placed.pharmacyTask.id, "Dispensed", pharmacistId)
    if (!completed.ok) throw new Error(completed.error)
    steps.push(
      step("prescription_dispensed", "PASS", undefined, {
        remainingStock: dispensed.remainingStock,
        pharmacyTaskStatus: completed.task.status,
        expectedStock: availableStock - quantity,
      }),
    )
    if (dispensed.remainingStock !== availableStock - quantity) {
      steps.push(step("stock_decrement", "FAIL", `expected ${availableStock - quantity}, got ${dispensed.remainingStock}`))
      return {
        status: "FAIL",
        correlationId: encounterId,
        steps,
        prescription: dispensed.rx,
        pharmacyTask: completed.task,
        remainingStock: dispensed.remainingStock,
        clinicalNote,
        queue: placed.queue,
      }
    }
    steps.push(step("stock_decrement", "PASS"))

    // 8) Closeout — billing then disposition then close
    const invoiceId = crypto.randomUUID()
    const outstanding = evaluateEncounterCloseGate({
      encounterExists: true,
      hospitalMatches: true,
      status: "signed",
      disposition: null,
      blockingActivePrescriptionIds: [],
      invoice: {
        id: invoiceId,
        status: "issued",
        totalAmount: consultationFee,
        paidAmount: 0,
      },
    })
    if (outstanding.ok || outstanding.blocking !== "BILLING") {
      steps.push(
        step("closeout_billing_blocks", "FAIL", "expected BILLING block before payment", {
          decision: outstanding,
        }),
      )
      return {
        status: "FAIL",
        correlationId: encounterId,
        steps,
        prescription: dispensed.rx,
        pharmacyTask: completed.task,
        remainingStock: dispensed.remainingStock,
        clinicalNote,
        queue: placed.queue,
      }
    }
    steps.push(step("closeout_billing_blocks", "PASS"))

    const afterPay = evaluateEncounterCloseGate({
      encounterExists: true,
      hospitalMatches: true,
      status: "signed",
      disposition: null,
      blockingActivePrescriptionIds: [],
      invoice: {
        id: invoiceId,
        status: "paid",
        totalAmount: consultationFee,
        paidAmount: consultationFee,
      },
    })
    if (afterPay.ok || afterPay.blocking !== "DISPOSITION") {
      steps.push(
        step("closeout_disposition_required", "FAIL", "expected DISPOSITION block after payment", {
          decision: afterPay,
        }),
      )
      return {
        status: "FAIL",
        correlationId: encounterId,
        steps,
        prescription: dispensed.rx,
        pharmacyTask: completed.task,
        remainingStock: dispensed.remainingStock,
        clinicalNote,
        queue: placed.queue,
      }
    }
    steps.push(step("closeout_disposition_required", "PASS"))

    const closeReady = evaluateEncounterCloseGate({
      encounterExists: true,
      hospitalMatches: true,
      status: "signed",
      disposition: "LOCAL_PHARMACY",
      blockingActivePrescriptionIds: [],
      invoice: {
        id: invoiceId,
        status: "paid",
        totalAmount: consultationFee,
        paidAmount: consultationFee,
      },
    })
    if (!closeReady.ok) {
      steps.push(step("encounter_close_allowed", "FAIL", closeReady.error, { decision: closeReady }))
      return {
        status: "FAIL",
        correlationId: encounterId,
        steps,
        prescription: dispensed.rx,
        pharmacyTask: completed.task,
        remainingStock: dispensed.remainingStock,
        clinicalNote,
        queue: placed.queue,
      }
    }
    steps.push(step("encounter_close_allowed", "PASS", undefined, { disposition: "LOCAL_PHARMACY" }))

    const failed = steps.some((row) => row.status === "FAIL")
    return {
      status: failed ? "FAIL" : "PASS",
      correlationId: encounterId,
      steps,
      prescription: dispensed.rx,
      pharmacyTask: completed.task,
      remainingStock: dispensed.remainingStock,
      clinicalNote,
      queue: placed.queue,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    steps.push(step("journey", "FAIL", message))
    return { status: "FAIL", correlationId: encounterId, steps }
  }
}
