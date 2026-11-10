import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin, tallyHasCapability } from "@/lib/tally/auth"
import { reverseTallyJournals } from "@/lib/tally/apply"
import { loadStagePlan } from "@/lib/tally/plan"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { logTallyEvent, logTallyFailure } from "@/lib/tally/http"
import type { TallyApplyDb, TallyPlanSummary } from "@/lib/tally/types"
import type { TallyStorageClient } from "@/lib/tally/storage"
import { reverseTallyReplaySession } from "@synapse/db/tally-replay-rpc"

const db = () => supabaseAdmin as any
const applyDb = () => db() as TallyApplyDb
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/**
 * POST /api/admin/tally/[id]/rollback
 *
 * Undoes a completed Tally import. Nothing is deleted: every applied stock
 * movement gets an inverse movement through the replay RPC, and every journal
 * gets a reversing entry dated where the original landed, so the imported
 * period nets back to zero.
 *
 * The stock call runs first because it is the one that refuses: it declines
 * once any post-cut-over trading exists and writes nothing when it does. Only
 * after it succeeds are journals reversed, and a failure there is retryable —
 * both steps are idempotent on their source keys.
 *
 * The session row keeps its history. `reversedAt` is what marks it undone, and
 * the one-shot cut-over guard reads past a reversed session so the pharmacy can
 * be imported again.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.adjust")
  if (!auth.ok) return auth.response
  const { actorId, tenantId } = auth

  if (!tallyHasCapability(auth, "reports.financial")) {
    return NextResponse.json(
      { error: "Missing capability: reports.financial" },
      { status: 403 },
    )
  }

  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, source_system, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (session.ai_mapping ?? {}) as Record<string, unknown>
  if (typeof mapping.reversedAt === "string") {
    return NextResponse.json({
      done: true,
      alreadyReversed: true,
      reversedAt: mapping.reversedAt,
    })
  }

  if (session.status !== "complete") {
    return NextResponse.json(
      {
        error:
          "Only a completed Tally import can be rolled back. This session has not finished applying, so there is nothing to reverse.",
        code: "TALLY_ROLLBACK_NOT_COMPLETE",
      },
      { status: 409 },
    )
  }

  const summary = mapping.summary as TallyPlanSummary | undefined
  if (!summary) {
    return NextResponse.json(
      {
        error:
          "This session has no saved plan, so its journals cannot be named for reversal. Nothing was reversed.",
        code: "TALLY_ROLLBACK_PLAN_MISSING",
      },
      { status: 409 },
    )
  }

  logTallyEvent("tally.rollback.start", { sessionId: id, tenantId })

  const stock = await reverseTallyReplaySession(db(), tenantId, id)
  if (stock.error) {
    // Every refusal from the replay RPC is a state refusal, not a bad request.
    const status = stock.error.code.startsWith("TALLY_REVERSAL_") ? 409 : 400
    logTallyFailure("tally.rollback.refused", { sessionId: id, tenantId, code: stock.error.code }, stock.error.humanMessage)
    return NextResponse.json(
      { error: stock.error.humanMessage, code: stock.error.code },
      { status },
    )
  }

  let posted = 0
  const failures: Array<{ sourceId: string; code: string; message: string }> = []
  try {
    for (let index = 0; index < summary.chunkCount; index += 1) {
      const loaded = await loadStagePlan(storage(), tenantId, id, "journals", index)
      const result = await reverseTallyJournals(applyDb(), {
        tenantId,
        actorId,
        vouchers: loaded.chunk?.vouchers ?? [],
      })
      posted += result.posted
      failures.push(...result.failures)
    }
  } catch (error) {
    logTallyFailure("tally.rollback.failed", { sessionId: id, tenantId }, error)
    return NextResponse.json(
      {
        error:
          "Stock was reversed, but the reversing journals could not be written. Retry this rollback to finish them; nothing will be reversed twice.",
        code: "TALLY_ROLLBACK_INCOMPLETE",
        stock,
      },
      { status: 500 },
    )
  }

  if (failures.length > 0) {
    logTallyFailure("tally.rollback.journal_refused", { sessionId: id, tenantId, failures: failures.length }, failures[0]!.message)
    return NextResponse.json(
      {
        error:
          "Stock was reversed, but some reversing journals were refused. Retry this rollback once the cause is fixed; nothing will be reversed twice.",
        code: "TALLY_ROLLBACK_INCOMPLETE",
        stock,
        failures: failures.slice(0, 20),
        failedCount: failures.length,
      },
      { status: 500 },
    )
  }

  const reversedAt = new Date().toISOString()
  const { error: markError } = await db()
    .from("pharmacy_import_sessions")
    .update({ ai_mapping: { ...mapping, reversedAt } })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (markError) {
    return NextResponse.json(
      {
        error:
          "Everything was reversed, but the session could not be marked as rolled back. Retry this rollback; it will not reverse anything twice.",
        code: "TALLY_ROLLBACK_MARK_FAILED",
        stock,
      },
      { status: 500 },
    )
  }

  const { error: auditError } = await db().from("pharmacy_audit_logs").insert({
    tenant_id: tenantId,
    profile_id: actorId,
    action: "IMPORT_TALLY_ROLLBACK",
    entity: "IMPORT_SESSION",
    entity_id: id,
    details: `Tally cut-over rolled back: ${stock.data?.movementsReversed ?? 0} stock movements reversed, ${posted} reversing journals posted; company "${stock.data?.companyKey ?? summary.companyKey}", closed through ${stock.data?.throughDate ?? "not stated"}, session ${id}`,
  })

  if (auditError) {
    return NextResponse.json(
      {
        error:
          "Everything was reversed, but the audit record could not be saved. Retry this rollback; it will not reverse anything twice.",
        code: "TALLY_AUDIT_FAILED",
        stock,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    done: true,
    reversedAt,
    stock: stock.data,
    journalsReversed: posted,
  })
}
