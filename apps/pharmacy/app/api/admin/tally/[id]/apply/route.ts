import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin, tallyHasCapability } from "@/lib/tally/auth"
import {
  acquireTallyApplyLease,
  CUTOVER_ALREADY_COMPLETE,
  findCompletedCutover,
  releaseTallyApplyLease,
} from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  applyTallyChunk,
  emptyProgress,
  type TallyApplyProgress,
  type TallyApplyStage,
} from "@/lib/tally/apply"
import type { TallyApplyDb } from "@/lib/tally/types"
import { loadStagePlan } from "@/lib/tally/plan"
import { reconcileTallyPlan } from "@/lib/tally/reconcile"
import { tallyErrorResponse } from "@/lib/tally/http"
import type { TallyStorageClient } from "@/lib/tally/storage"

const db = () => supabaseAdmin as any
const applyDb = () => db() as TallyApplyDb
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/** Master-data stages are bulk writes; run them together in one request. */
const STARTER_STAGES: TallyApplyStage[] = ["accounts", "parties", "products"]
const MAX_STAGES = 3

const RESUMABLE = new Set(["review", "mapping", "importing", "failed"])

async function applySessionStep(input: {
  id: string
  tenantId: string
  actorId: string
  mapping: Record<string, unknown>
}): Promise<NextResponse> {
  const { id, tenantId, actorId, mapping } = input
  let progress = (mapping.progress as TallyApplyProgress | undefined) ?? emptyProgress()
  let done = progress.stage === "complete"
  let stagesRun = 0
  let lastPlan: Awaited<ReturnType<typeof loadStagePlan>>["plan"] | null = null
  let summaryForRequest: Awaited<ReturnType<typeof loadStagePlan>>["summary"] | null = null

  try {
    while (!done && stagesRun < MAX_STAGES) {
      const stageBefore = progress.stage
      const loaded = await loadStagePlan(storage(), tenantId, id, stageBefore, progress.offset)
      lastPlan = loaded.plan
      summaryForRequest = loaded.summary

      const result = await applyTallyChunk(applyDb(), {
        tenantId,
        actorId,
        plan: loaded.plan,
        progress,
        chunk: loaded.chunk,
        totalChunks: loaded.totalChunks,
      })

      progress = result.progress
      done = result.done
      stagesRun += 1

      // Master data runs together; every heavier stage gets its own request so
      // no call approaches the platform timeout.
      if (done || !STARTER_STAGES.includes(stageBefore)) break
    }

    const reconcile =
      done && lastPlan ? reconcileTallyPlan(lastPlan, progress.counts) : null
    const nextMapping = {
      ...mapping,
      progress,
      ...(reconcile ? { reconcile, completedAt: new Date().toISOString() } : {}),
    }

    // Keep completion resumable until its audit row is confirmed.
    const { error: checkpointError } = await db()
      .from("pharmacy_import_sessions")
      .update({
        status: "importing",
        ai_mapping: nextMapping,
        error_message: null,
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)

    if (checkpointError) {
      return NextResponse.json(
        {
          error: "Work was written but its checkpoint could not be saved. Retry apply on this session.",
          code: "TALLY_CHECKPOINT_SAVE_FAILED",
          progress,
        },
        { status: 500 },
      )
    }

    if (done) {
      const { data: existingAudit, error: auditReadError } = await db()
        .from("pharmacy_audit_logs")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("action", "IMPORT_TALLY")
        .eq("entity", "IMPORT_SESSION")
        .eq("entity_id", id)
        .limit(1)
        .maybeSingle()

      if (auditReadError) {
        return NextResponse.json(
          {
            error: "The cut-over is applied, but its audit record could not be verified. Retry this session.",
            code: "TALLY_AUDIT_FAILED",
          },
          { status: 500 },
        )
      }

      if (!existingAudit) {
        const { error: auditWriteError } = await db().from("pharmacy_audit_logs").insert({
          tenant_id: tenantId,
          profile_id: actorId,
          action: "IMPORT_TALLY",
          entity: "IMPORT_SESSION",
          entity_id: id,
          details: `Tally cut-over applied: ${progress.counts.accounts} accounts, ${progress.counts.parties} parties, ${progress.counts.products} products, ${progress.counts.journals} vouchers, ${progress.counts.openingStock} batches; ${progress.failures.length} listed exceptions`,
        })

        if (auditWriteError) {
          return NextResponse.json(
            {
              error: "The cut-over is applied, but its audit record could not be saved. Retry this session.",
              code: "TALLY_AUDIT_FAILED",
            },
            { status: 500 },
          )
        }
      }

      const { error: completeError } = await db()
        .from("pharmacy_import_sessions")
        .update({ status: "complete", completed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("tenant_id", tenantId)

      if (completeError) {
        return NextResponse.json(
          {
            error: "The audit record is saved, but cut-over finalization failed. Retry this session.",
            code: "TALLY_FINALIZATION_FAILED",
          },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({
      done,
      progress,
      reconcile: reconcile ?? mapping.reconcile ?? null,
      totalChunks: summaryForRequest?.chunkCount ?? null,
      nextOffset: progress.stage === "journals" ? progress.offset : null,
    })
  } catch (error) {
    const nextMapping = { ...mapping, progress, interruptedAt: new Date().toISOString() }
    const { error: checkpointError } = await db()
      .from("pharmacy_import_sessions")
      .update({
        status: "importing",
        ai_mapping: nextMapping,
        error_message: "Apply stopped before the step finished.",
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)

    if (checkpointError) {
      return NextResponse.json(
        {
          error: "Apply stopped and its resume checkpoint could not be saved. Contact support before retrying.",
          code: "TALLY_CHECKPOINT_SAVE_FAILED",
        },
        { status: 500 },
      )
    }
    return tallyErrorResponse(error)
  }
}

/**
 * POST /api/admin/tally/[id]/apply
 * Advances the cut-over by one bounded unit of work and checkpoints progress.
 * A tenant-scoped database lease serializes retries and competing sessions.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.adjust")
  if (!auth.ok) return auth.response
  const { actorId, tenantId } = auth

  // Two capabilities, both required. requireTallyAdmin checks only the first.
  if (!tallyHasCapability(auth, "reports.financial")) {
    return NextResponse.json(
      { error: "Missing capability: reports.financial" },
      { status: 403 },
    )
  }

  const { id } = await params

  const { data: row, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, flagged_rows, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !row) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (row.ai_mapping ?? {}) as Record<string, unknown>

  if (row.status === "complete") {
    const progress = (mapping.progress as TallyApplyProgress | undefined) ?? emptyProgress()
    return NextResponse.json({
      done: true,
      alreadyComplete: true,
      progress,
      reconcile: mapping.reconcile ?? null,
    })
  }

  const cutover = await findCompletedCutover(tenantId)
  if (cutover && cutover.sessionId !== id) {
    return NextResponse.json(CUTOVER_ALREADY_COMPLETE, { status: 409 })
  }

  if (!RESUMABLE.has(row.status)) {
    return NextResponse.json(
      { error: "Preview the file before applying it." },
      { status: 409 },
    )
  }
  if (!mapping.summary) {
    return NextResponse.json(
      { error: "This session has no reviewed plan. Run the preview again." },
      { status: 409 },
    )
  }

  const blocking = Number(row.flagged_rows ?? 0)
  if (blocking > 0) {
    return NextResponse.json(
      {
        error: `This plan has ${blocking} blocking exception${blocking === 1 ? "" : "s"}. Correct the export or the mapping, then preview it again.`,
        code: "TALLY_BLOCKING_EXCEPTIONS",
      },
      { status: 409 },
    )
  }

  let lease
  try {
    lease = await acquireTallyApplyLease(tenantId, id)
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Tally cut-over lock is unavailable.",
        code: "TALLY_CUTOVER_LOCK_UNAVAILABLE",
      },
      { status: 503 },
    )
  }

  if (lease.status === "busy") {
    return NextResponse.json(
      { error: "An apply request is already running for this pharmacy.", code: "TALLY_CUTOVER_BUSY" },
      { status: 409 },
    )
  }
  if (lease.status === "owned_by_another_session") {
    return NextResponse.json(
      {
        error: "Another Tally session already started this pharmacy's one-shot cut-over.",
        code: "TALLY_CUTOVER_IN_PROGRESS",
      },
      { status: 409 },
    )
  }
  if (lease.status === "invalid_session" || !lease.token) {
    return NextResponse.json({ error: "Import session not found.", code: "TALLY_SESSION_NOT_FOUND" }, { status: 404 })
  }

  const { error: startError } = await db()
    .from("pharmacy_import_sessions")
    .update({ status: "importing" })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (startError) {
    try {
      await releaseTallyApplyLease(tenantId, id, lease.token)
    } catch (error) {
      return NextResponse.json(
        {
          error: error instanceof Error ? error.message : "Tally cut-over lock could not be released.",
          code: "TALLY_CUTOVER_LOCK_RELEASE_FAILED",
        },
        { status: 500 },
      )
    }
    return NextResponse.json(
      { error: "The session could not be reserved for apply.", code: "TALLY_CHECKPOINT_SAVE_FAILED" },
      { status: 500 },
    )
  }

  let response: NextResponse
  try {
    response = await applySessionStep({ id, tenantId, actorId, mapping })
  } catch (error) {
    response = tallyErrorResponse(error)
  }

  try {
    await releaseTallyApplyLease(tenantId, id, lease.token)
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Tally cut-over lock could not be released.",
        code: "TALLY_CUTOVER_LOCK_RELEASE_FAILED",
      },
      { status: 500 },
    )
  }

  return response
}
