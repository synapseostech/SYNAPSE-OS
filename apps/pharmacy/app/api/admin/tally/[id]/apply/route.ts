import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission, tallyHasCapability } from "@/lib/tally/auth"
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

/**
 * POST /api/admin/tally/[id]/apply
 * Advances the cut-over by one bounded unit of work and checkpoints progress.
 * Each request is safe to repeat: every stage keys on a stable source id.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyPermission(request, "inventory.adjust")
  if (!auth.ok) return auth.response
  const { actorId, tenantId } = auth

  // Two capabilities, both required. requireTallyPermission checks only the first.
  if (!tallyHasCapability(auth, "reports.financial")) {
    return NextResponse.json(
      { error: "Missing capability: reports.financial" },
      { status: 403 },
    )
  }

  const { id } = await params

  const { data: row, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, ai_mapping")
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

    const { error: saveError } = await db()
      .from("pharmacy_import_sessions")
      .update({
        status: done ? "complete" : "importing",
        ai_mapping: nextMapping,
        ...(done ? { completed_at: new Date().toISOString() } : {}),
        error_message: null,
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)

    if (saveError) {
      return NextResponse.json(
        {
          error:
            "Work was written but the checkpoint could not be saved. Re-run apply; completed steps are skipped.",
          progress,
        },
        { status: 500 },
      )
    }

    if (done) {
      await db().from("pharmacy_audit_logs").insert({
        tenant_id: tenantId,
        profile_id: actorId,
        action: "IMPORT_TALLY",
        entity: "IMPORT_SESSION",
        entity_id: id,
        details: `Tally cut-over applied: ${progress.counts.accounts} accounts, ${progress.counts.parties} parties, ${progress.counts.products} products, ${progress.counts.journals} vouchers, ${progress.counts.openingStock} batches; ${progress.failures.length} listed exceptions`,
      })
    }

    return NextResponse.json({
      done,
      progress,
      reconcile,
      totalChunks: summaryForRequest?.chunkCount ?? null,
      nextOffset: progress.stage === "journals" ? progress.offset : null,
    })
  } catch (error) {
    // Persist whatever the run reached so the next call resumes past it.
    const nextMapping = { ...mapping, progress, interruptedAt: new Date().toISOString() }
    await db()
      .from("pharmacy_import_sessions")
      .update({ ai_mapping: nextMapping, error_message: "Apply stopped before the step finished." })
      .eq("id", id)
      .eq("tenant_id", tenantId)
    return tallyErrorResponse(error)
  }
}
