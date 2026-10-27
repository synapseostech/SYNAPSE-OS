/**
 * Clinical offline triage (RC1): vitals + acuity as SyncCommand.
 * Completes the offline clinical trio with write-up and disposition.
 */
import {
  SYNC_SCHEMA_VERSION,
  assertSyncCommand,
  hashPayload,
  resolveSyncConflict,
  type SyncCommand,
} from "./sync-contract"

export const CLINICAL_TRIAGE_COMMAND = "clinical.encounter.triage.v1" as const

export const CLINICAL_STAGES = ["RED", "YELLOW", "GREEN"] as const
export type ClinicalStage = (typeof CLINICAL_STAGES)[number]

export type TriageVitals = {
  bp_systolic?: number | null
  bp_diastolic?: number | null
  heart_rate?: number | null
  respiratory_rate?: number | null
  temperature_c?: number | null
  spo2?: number | null
  notes?: string | null
}

export type TriageSnapshot = TriageVitals & {
  clinical_stage?: ClinicalStage | null
  recordedAt?: string | null
  recordedBy?: string | null
}

export type EncounterTriageAggregate = {
  encounterId: string
  metadata: Record<string, unknown>
  clinicalStage: string | null
  isSigned: boolean
  revision: number
}

export function isClinicalStage(value: string): value is ClinicalStage {
  return (CLINICAL_STAGES as readonly string[]).includes(value)
}

export function normalizeTriageSnapshot(
  input: Partial<TriageSnapshot>,
  actorId?: string,
): TriageSnapshot {
  const stage =
    typeof input.clinical_stage === "string" && isClinicalStage(input.clinical_stage)
      ? input.clinical_stage
      : null
  return {
    bp_systolic: numOrNull(input.bp_systolic),
    bp_diastolic: numOrNull(input.bp_diastolic),
    heart_rate: numOrNull(input.heart_rate),
    respiratory_rate: numOrNull(input.respiratory_rate),
    temperature_c: numOrNull(input.temperature_c),
    spo2: numOrNull(input.spo2),
    notes: typeof input.notes === "string" && input.notes.trim() ? input.notes.trim() : null,
    clinical_stage: stage,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    recordedBy: (input.recordedBy ?? actorId ?? null) as string | null,
  }
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

export function triageFromEncounterMetadata(metadata: Record<string, unknown> | null | undefined): TriageSnapshot {
  const raw = (metadata ?? {}).triage
  if (!raw || typeof raw !== "object") return normalizeTriageSnapshot({})
  return normalizeTriageSnapshot(raw as Partial<TriageSnapshot>)
}

export function mergeTriageIntoMetadata(
  metadata: Record<string, unknown> | null | undefined,
  triage: TriageSnapshot,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    triage,
  }
}

export function vitalsInsertFromTriage(input: {
  tenantId: string
  encounterId: string
  triage: TriageSnapshot
  actorId: string
  /** Server-owned stable id for retry upserts; never a client-selected primary key. */
  id?: string
}): Record<string, unknown> {
  return {
    ...(input.id ? { id: input.id } : {}),
    tenant_id: input.tenantId,
    encounter_id: input.encounterId,
    bp_systolic: input.triage.bp_systolic,
    bp_diastolic: input.triage.bp_diastolic,
    heart_rate: input.triage.heart_rate,
    respiratory_rate: input.triage.respiratory_rate,
    temperature_c: input.triage.temperature_c,
    spo2: input.triage.spo2,
    notes: input.triage.notes,
    recorded_by: input.actorId,
    recorded_at: input.triage.recordedAt ?? new Date().toISOString(),
    is_deleted: false,
  }
}

export async function buildTriageSyncCommand(input: {
  commandId?: string
  tenantId: string
  facilityId: string
  deviceId: string
  actorId: string
  encounterId: string
  triage: Partial<TriageSnapshot>
  baseRevision?: number | null
  correlationId?: string | null
}): Promise<SyncCommand> {
  const triage = normalizeTriageSnapshot(input.triage, input.actorId)
  const payload = {
    encounter_id: input.encounterId,
    triage,
  }
  const command: SyncCommand = {
    commandId: input.commandId ?? crypto.randomUUID(),
    commandType: CLINICAL_TRIAGE_COMMAND,
    schemaVersion: SYNC_SCHEMA_VERSION,
    tenantId: input.tenantId,
    facilityId: input.facilityId,
    deviceId: input.deviceId,
    actorId: input.actorId,
    aggregateType: "encounter",
    aggregateId: input.encounterId,
    baseRevision: input.baseRevision ?? null,
    capturedAtClient: new Date().toISOString(),
    payload,
    payloadHash: await hashPayload(payload),
    correlationId: input.correlationId ?? input.encounterId,
  }
  assertSyncCommand(command)
  return command
}

export function applyTriageSyncCommand(
  aggregate: EncounterTriageAggregate,
  command: SyncCommand,
): EncounterTriageAggregate {
  assertSyncCommand(command)
  if (command.commandType !== CLINICAL_TRIAGE_COMMAND) throw new Error("UNSUPPORTED_COMMAND")
  if (command.aggregateId !== aggregate.encounterId) throw new Error("AGGREGATE_MISMATCH")
  if (aggregate.isSigned) throw new Error("ENCOUNTER_SIGNED_IMMUTABLE")
  const triage = normalizeTriageSnapshot(
    (command.payload.triage ?? {}) as Partial<TriageSnapshot>,
    command.actorId,
  )
  return {
    encounterId: aggregate.encounterId,
    metadata: mergeTriageIntoMetadata(aggregate.metadata, triage),
    clinicalStage: triage.clinical_stage ?? aggregate.clinicalStage,
    isSigned: aggregate.isSigned,
    revision: aggregate.revision + 1,
  }
}

/**
 * In-memory offline→sync proof for triage vitals.
 */
export async function runClinicalOfflineTriageGolden(input?: {
  encounterId?: string
}): Promise<{
  ok: boolean
  correlationId: string
  steps: Array<{ id: string; status: "PASS" | "FAIL"; detail?: string }>
  aggregate?: EncounterTriageAggregate
}> {
  const tenantId = crypto.randomUUID()
  const facilityId = crypto.randomUUID()
  const encounterId = input?.encounterId ?? crypto.randomUUID()
  const deviceId = crypto.randomUUID()
  const actorId = crypto.randomUUID()
  const commandId = crypto.randomUUID()
  const steps: Array<{ id: string; status: "PASS" | "FAIL"; detail?: string }> = []

  const draft = await buildTriageSyncCommand({
    commandId,
    tenantId,
    facilityId,
    deviceId,
    actorId,
    encounterId,
    triage: {
      clinical_stage: "YELLOW",
      temperature_c: 38.4,
      heart_rate: 104,
      spo2: 96,
      bp_systolic: 128,
      bp_diastolic: 78,
      notes: "Offline nurse triage",
    },
  })
  steps.push({ id: "queue", status: "PASS" })

  let aggregate: EncounterTriageAggregate = {
    encounterId,
    metadata: {},
    clinicalStage: null,
    isSigned: false,
    revision: 0,
  }

  try {
    aggregate = applyTriageSyncCommand(aggregate, draft)
    steps.push({ id: "apply", status: "PASS" })
  } catch (error) {
    steps.push({
      id: "apply",
      status: "FAIL",
      detail: error instanceof Error ? error.message : String(error),
    })
    return { ok: false, correlationId: encounterId, steps, aggregate }
  }

  const replay = resolveSyncConflict({
    existing: { commandId: draft.commandId, payloadHash: draft.payloadHash, status: "applied" },
    incoming: { commandId: draft.commandId, payloadHash: draft.payloadHash },
    commandType: draft.commandType,
  })
  steps.push({
    id: "replay",
    status: replay === "replay" ? "PASS" : "FAIL",
    detail: replay === "replay" ? undefined : JSON.stringify(replay),
  })

  const conflicting = await buildTriageSyncCommand({
    commandId,
    tenantId,
    facilityId,
    deviceId,
    actorId,
    encounterId,
    triage: { clinical_stage: "RED", temperature_c: 40.1, heart_rate: 130 },
  })
  const conflict = resolveSyncConflict({
    existing: { commandId: draft.commandId, payloadHash: draft.payloadHash, status: "applied" },
    incoming: { commandId: conflicting.commandId, payloadHash: conflicting.payloadHash },
    commandType: conflicting.commandType,
  })
  const conflictOk = typeof conflict === "object" && conflict.reason === "idempotency_mismatch"
  steps.push({
    id: "conflict",
    status: conflictOk ? "PASS" : "FAIL",
    detail: conflictOk ? undefined : JSON.stringify(conflict),
  })

  try {
    applyTriageSyncCommand({ ...aggregate, isSigned: true }, draft)
    steps.push({ id: "signed_reject", status: "FAIL", detail: "expected ENCOUNTER_SIGNED_IMMUTABLE" })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    steps.push({
      id: "signed_reject",
      status: msg === "ENCOUNTER_SIGNED_IMMUTABLE" ? "PASS" : "FAIL",
      detail: msg,
    })
  }

  const triage = triageFromEncounterMetadata(aggregate.metadata)
  const shapeOk = triage.clinical_stage === "YELLOW" && triage.temperature_c === 38.4
  steps.push({ id: "shape", status: shapeOk ? "PASS" : "FAIL" })

  const ok = steps.every((s) => s.status === "PASS")
  return { ok, correlationId: encounterId, steps, aggregate }
}
