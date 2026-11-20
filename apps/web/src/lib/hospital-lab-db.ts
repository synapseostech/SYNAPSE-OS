/**
 * Compatibility entry points for the hospital lab. The implementation moved
 * to lib/lab (engine.ts, worklist.ts): one read and one transactional write
 * per action instead of eight separate calls. These names and their return
 * shapes are kept so existing callers do not change.
 */

import type { LabOrder, LabResult } from '@synapse/db/lab-workflow'
import type { HospitalContext } from './hospital-shared/context'
import { runLabAction } from './lab/engine'
import { fetchLabWorklist, type LabWorklistItem } from './lab/worklist'

export type HospitalLabWorklistOrder = LabWorklistItem

export async function fetchHospitalLabWorklist(
  ctx: HospitalContext,
  filters?: { encounterId?: string | null; status?: string | null },
): Promise<{ orders: HospitalLabWorklistOrder[]; error?: string }> {
  const { orders, error } = await fetchLabWorklist(ctx, {
    encounterId: filters?.encounterId ?? null,
    status: filters?.status ?? null,
    limit: 100,
  })
  return error ? { orders, error } : { orders }
}

export async function executeHospitalLabAction(params: {
  ctx: HospitalContext
  orderId: string
  action: string
  actorId: string
  extra?: Record<string, unknown>
}): Promise<{ order: LabOrder; result: LabResult | null; warnings: string[]; idempotent: boolean }> {
  if (params.actorId !== params.ctx.userId) throw new Error('LAB_ACTOR_MISMATCH')
  const outcome = await runLabAction({ ctx: params.ctx, orderId: params.orderId, action: params.action, extra: params.extra })
  return { order: outcome.order, result: outcome.result, warnings: outcome.warnings, idempotent: outcome.idempotent }
}
