/**
 * Best-effort persistence for department_tasks and synapse_domain_events.
 * Keeps WorkQueue synchronous; callers invoke these after in-memory mutations.
 */

import type { OutboxRecord } from "@synapse/interop"
import { toDomainEventInsert } from "./exchange"
import { InvalidIdentifierError, optionalUuid, requireUuid } from "./identifiers"
import type { DepartmentTask } from "./work-queue"

export type DbClient = {
  from(table: string): {
    upsert(
      row: Record<string, unknown> | Record<string, unknown>[],
      options?: { onConflict?: string; ignoreDuplicates?: boolean },
    ): PromiseLike<{ error: { message?: string } | null }>
  }
}

export function departmentTaskToRow(task: DepartmentTask): Record<string, unknown> {
  return {
    id: requireUuid(task.id, "id"),
    tenant_id: requireUuid(task.tenantId, "tenant_id"),
    facility_id: optionalUuid(task.facilityId, "facility_id"),
    hospital_id: optionalUuid(task.hospitalId, "hospital_id"),
    patient_id: optionalUuid(task.patientId, "patient_id"),
    person_id: optionalUuid(task.personId, "person_id"),
    encounter_id: optionalUuid(task.encounterId, "encounter_id"),
    requester_id: optionalUuid(task.requesterId, "requester_id"),
    owner_department: task.ownerDepartment,
    owner_role: task.ownerRole ?? null,
    task_type: task.taskType,
    priority: task.priority,
    status: task.status,
    title: task.title,
    description: task.description ?? null,
    source_resource: task.sourceResource ?? null,
    source_id: optionalUuid(task.sourceId, "source_id"),
    correlation_id: optionalUuid(task.correlationId, "correlation_id"),
    causation_id: optionalUuid(task.causationId, "causation_id"),
    idempotency_key: task.idempotencyKey ?? null,
    due_at: task.dueAt ?? null,
    accepted_at: task.acceptedAt ?? null,
    completed_at: task.completedAt ?? null,
    cancelled_at: task.cancelledAt ?? null,
    assigned_to: optionalUuid(task.assignedTo, "assigned_to"),
    result_summary: task.resultSummary ?? null,
    metadata: task.metadata ?? {},
    is_synthetic: task.isSynthetic,
    simulation_run_id: optionalUuid(task.simulationRunId, "simulation_run_id"),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  }
}

export function rowToDepartmentTask(row: Record<string, unknown>): DepartmentTask {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    facilityId: (row.facility_id as string | null) ?? null,
    hospitalId: (row.hospital_id as string | null) ?? null,
    patientId: (row.patient_id as string | null) ?? null,
    personId: (row.person_id as string | null) ?? null,
    encounterId: (row.encounter_id as string | null) ?? null,
    requesterId: (row.requester_id as string | null) ?? null,
    ownerDepartment: String(row.owner_department),
    ownerRole: (row.owner_role as string | null) ?? null,
    taskType: row.task_type as DepartmentTask["taskType"],
    priority: row.priority as DepartmentTask["priority"],
    status: row.status as DepartmentTask["status"],
    title: String(row.title),
    description: (row.description as string | null) ?? null,
    sourceResource: (row.source_resource as string | null) ?? null,
    sourceId: (row.source_id as string | null) ?? null,
    correlationId: (row.correlation_id as string | null) ?? null,
    causationId: (row.causation_id as string | null) ?? null,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
    dueAt: (row.due_at as string | null) ?? null,
    acceptedAt: (row.accepted_at as string | null) ?? null,
    completedAt: (row.completed_at as string | null) ?? null,
    cancelledAt: (row.cancelled_at as string | null) ?? null,
    assignedTo: (row.assigned_to as string | null) ?? null,
    resultSummary: (row.result_summary as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    isSynthetic: Boolean(row.is_synthetic),
    simulationRunId: (row.simulation_run_id as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

export async function persistDepartmentTaskBestEffort(
  db: DbClient,
  task: DepartmentTask,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { error } = await db.from("department_tasks").upsert(departmentTaskToRow(task), {
      onConflict: "id",
    })
    if (error) return { ok: false, error: error.message ?? "department_tasks upsert failed" }
    return { ok: true }
  } catch (err) {
    if (err instanceof InvalidIdentifierError) return { ok: false, error: err.message }
    return { ok: false, error: err instanceof Error ? err.message : "department_tasks upsert threw" }
  }
}

export async function persistDomainEventsBestEffort(
  db: DbClient,
  events: OutboxRecord[],
): Promise<{ ok: true; inserted: number } | { ok: false; error: string; inserted: number }> {
  if (events.length === 0) return { ok: true, inserted: 0 }
  try {
    const rows = events.map((event) => toDomainEventInsert(event))
    // `ignoreDuplicates` is load-bearing, not an optimisation. `toDomainEventInsert`
    // carries `status`, `retry_count`, `last_error` and `published_at`, which are
    // delivery state owned by the relay — this function is only an emitter. A plain
    // upsert would therefore let a re-emitted idempotency key reset an already
    // published row back to `pending`, and the relay would deliver it again. With
    // duplicates ignored, a replay is a no-op and the table's own defaults
    // ('pending', 0, null, null) describe every newly inserted event.
    const { error } = await db.from("synapse_domain_events").upsert(rows, {
      onConflict: "idempotency_key",
      ignoreDuplicates: true,
    })
    if (error) {
      // Idempotent replays may hit unique idempotency_key — treat as soft success for journey continuity.
      if (String(error.message ?? "").toLowerCase().includes("duplicate")) {
        return { ok: true, inserted: 0 }
      }
      return { ok: false, error: error.message ?? "synapse_domain_events insert failed", inserted: 0 }
    }
    return { ok: true, inserted: events.length }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "synapse_domain_events insert threw",
      inserted: 0,
    }
  }
}

export async function persistWorkQueueArtifactsBestEffort(
  db: DbClient,
  input: { tasks: DepartmentTask[]; events: OutboxRecord[] },
): Promise<{ tasksPersisted: number; eventsPersisted: number; errors: string[] }> {
  const errors: string[] = []
  let tasksPersisted = 0
  let eventsPersisted = 0

  for (const task of input.tasks) {
    const result = await persistDepartmentTaskBestEffort(db, task)
    if (result.ok) tasksPersisted += 1
    else errors.push(result.error)
  }

  const eventResult = await persistDomainEventsBestEffort(db, input.events)
  if (eventResult.ok) eventsPersisted = eventResult.inserted
  else errors.push(eventResult.error)

  return { tasksPersisted, eventsPersisted, errors }
}
