import type { PatientContextPacket } from "@synapse/interop"

/** Build a tenant-scoped PatientContextPacket. Caller-supplied tenantId is ignored. */
export function buildClinicalContext(input: {
  tenantId: string
  clinicianId: string
  patientId?: string
  facilityId?: string | null
  encounterId?: string | null
  presentingComplaint: string
  vitals?: PatientContextPacket["vitals"]
  laboratory?: PatientContextPacket["laboratory"]
  history?: string[]
  examination?: string[]
  medications?: string[]
  allergies?: string[]
  previousDiagnoses?: string[]
  demographics?: PatientContextPacket["demographics"]
}): PatientContextPacket {
  const complaint = input.presentingComplaint.trim()
  if (!complaint) {
    throw new Error("presentingComplaint is required")
  }
  return {
    patientId: input.patientId?.trim() || "session",
    tenantId: input.tenantId,
    facilityId: input.facilityId ?? null,
    encounterId: input.encounterId ?? null,
    clinicianId: input.clinicianId,
    demographics: input.demographics,
    presentingComplaint: complaint,
    history: input.history,
    examination: input.examination,
    vitals: input.vitals,
    previousDiagnoses: input.previousDiagnoses,
    medications: input.medications,
    allergies: input.allergies,
    laboratory: input.laboratory,
  }
}

export function summarizeContextForPrompt(packet: PatientContextPacket): string {
  // Deliberately coarse — no free-text PHI dump beyond complaint/vitals already in packet.
  return JSON.stringify({
    presentingComplaint: packet.presentingComplaint,
    demographics: packet.demographics ?? null,
    vitals: packet.vitals ?? null,
    laboratory: packet.laboratory ?? null,
    previousDiagnoses: packet.previousDiagnoses ?? [],
    medications: packet.medications ?? [],
    allergies: packet.allergies ?? [],
  })
}
