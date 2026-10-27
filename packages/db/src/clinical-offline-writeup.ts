/**
 * Clinical offline vertical slice (RC1): encounter write-up as SyncCommand.
 * Reuses sync-contract — no second offline system.
 */
import {
  SYNC_SCHEMA_VERSION,
  assertSyncCommand,
  hashPayload,
  resolveSyncConflict,
  type SyncCommand,
  type SyncOutboxStatus,
} from "./sync-contract"
import {
  mergeWriteupIntoMetadata,
  normalizeClinicalWriteup,
  type ClinicalWriteup,
} from "./clinical-writeup"

export const CLINICAL_WRITEUP_COMMAND = "clinical.encounter.writeup.v1" as const

export type EncounterWriteupAggregate = {
  encounterId: string
  metadata: Record<string, unknown>
  revision: number
}

export async function buildWriteupSyncCommand(input: {
  commandId?: string
  tenantId: string
  facilityId: string
  deviceId: string
  actorId: string
  encounterId: string
  writeup: Partial<ClinicalWriteup>
  baseRevision?: number | null
  correlationId?: string | null
}): Promise<SyncCommand> {
  const writeup = normalizeClinicalWriteup({
    ...input.writeup,
    updatedAt: new Date().toISOString(),
    updatedBy: input.actorId,
  })
  const payload = {
    encounter_id: input.encounterId,
    writeup,
  }
  const command: SyncCommand = {
    commandId: input.commandId ?? crypto.randomUUID(),
    commandType: CLINICAL_WRITEUP_COMMAND,
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

export function applyWriteupSyncCommand(
  aggregate: EncounterWriteupAggregate,
  command: SyncCommand,
): EncounterWriteupAggregate {
  assertSyncCommand(command)
  if (command.commandType !== CLINICAL_WRITEUP_COMMAND) {
    throw new Error("UNSUPPORTED_COMMAND")
  }
  if (command.aggregateId !== aggregate.encounterId) {
    throw new Error("AGGREGATE_MISMATCH")
  }
  const writeup = normalizeClinicalWriteup(
    (command.payload.writeup ?? {}) as Partial<ClinicalWriteup>,
  )
  return {
    encounterId: aggregate.encounterId,
    metadata: mergeWriteupIntoMetadata(aggregate.metadata, writeup),
    revision: aggregate.revision + 1,
  }
}

type Queued = {
  command: SyncCommand
  status: SyncOutboxStatus
}

/**
 * In-memory offline→sync proof for write-up drafts.
 * Same commandId+hash → replay; same commandId different hash → conflict.
 */
export async function runClinicalOfflineWriteupGolden(input?: {
  encounterId?: string
  tenantId?: string
}): Promise<{
  ok: boolean
  correlationId: string
  steps: Array<{ id: string; status: "PASS" | "FAIL"; detail?: string }>
  aggregate?: EncounterWriteupAggregate
}> {
  const tenantId = input?.tenantId ?? crypto.randomUUID()
  const facilityId = crypto.randomUUID()
  const encounterId = input?.encounterId ?? crypto.randomUUID()
  const deviceId = crypto.randomUUID()
  const actorId = crypto.randomUUID()
  const commandId = crypto.randomUUID()
  const steps: Array<{ id: string; status: "PASS" | "FAIL"; detail?: string }> = []

  const draft = await buildWriteupSyncCommand({
    commandId,
    tenantId,
    facilityId,
    deviceId,
    actorId,
    encounterId,
    writeup: {
      hpi: "Offline drafted HPI — fever 2 days",
      assessment: "Likely viral",
      plan: "Supportive care; sync when online",
    },
  })
  steps.push({ id: "queue_offline_draft", status: "PASS" })

  const outbox = new Map<string, Queued>()
  outbox.set(draft.commandId, { command: draft, status: "queued" })

  let aggregate: EncounterWriteupAggregate = {
    encounterId,
    metadata: {},
    revision: 0,
  }

  // First apply
  aggregate = applyWriteupSyncCommand(aggregate, draft)
  outbox.set(draft.commandId, { command: draft, status: "applied" })
  const writeupOk = Boolean((aggregate.metadata.writeup as { hpi?: string } | undefined)?.hpi)
  steps.push({
    id: "sync_apply",
    status: writeupOk ? "PASS" : "FAIL",
    detail: writeupOk ? undefined : "writeup missing after apply",
  })

  // Idempotent replay
  const existing = outbox.get(draft.commandId)!
  const replay = resolveSyncConflict({
    existing: {
      commandId: existing.command.commandId,
      payloadHash: existing.command.payloadHash,
      status: existing.status,
    },
    incoming: { commandId: draft.commandId, payloadHash: draft.payloadHash },
    commandType: draft.commandType,
  })
  steps.push({
    id: "idempotent_replay",
    status: replay === "replay" ? "PASS" : "FAIL",
    detail: replay === "replay" ? undefined : JSON.stringify(replay),
  })

  // Conflict on same commandId, different payload
  const conflicting = await buildWriteupSyncCommand({
    commandId,
    tenantId,
    facilityId,
    deviceId,
    actorId,
    encounterId,
    writeup: {
      hpi: "Conflicting offline edit",
      assessment: "Different assessment",
      plan: "Different plan",
    },
  })
  const conflict = resolveSyncConflict({
    existing: {
      commandId: existing.command.commandId,
      payloadHash: existing.command.payloadHash,
      status: "applied",
    },
    incoming: { commandId: conflicting.commandId, payloadHash: conflicting.payloadHash },
    commandType: conflicting.commandType,
  })
  const conflictOk =
    typeof conflict === "object" && conflict.reason === "idempotency_mismatch"
  steps.push({
    id: "conflict_on_hash_mismatch",
    status: conflictOk ? "PASS" : "FAIL",
    detail: conflictOk ? undefined : JSON.stringify(conflict),
  })

  const ok = steps.every((s) => s.status === "PASS")
  return { ok, correlationId: encounterId, steps, aggregate }
}
