import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission } from "@/lib/tally/auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import type { TallyApplyProgress } from "@/lib/tally/apply"
import type { TallyPlanSummary } from "@/lib/tally/types"
import type { TallyReconcileCheck } from "@/lib/tally/reconcile"

const db = () => supabaseAdmin as any
const FAILURE_LIMIT = 200

/** GET /api/admin/tally/[id] — everything the workspace needs to resume. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyPermission(request, "inventory.read")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select(
      "id, status, source_system, file_name, total_rows, flagged_rows, ai_mapping, ai_summary, error_message, created_at, completed_at",
    )
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (session.ai_mapping ?? {}) as Record<string, unknown>
  const progress = (mapping.progress as TallyApplyProgress | undefined) ?? null
  const summary = (mapping.summary as TallyPlanSummary | undefined) ?? null
  const reconcile = (mapping.reconcile as TallyReconcileCheck[] | undefined) ?? null

  return NextResponse.json({
    id: session.id,
    status: session.status,
    sourceSystem: session.source_system,
    fileName: session.file_name,
    totalRows: session.total_rows,
    flaggedRows: session.flagged_rows,
    errorMessage: session.error_message,
    createdAt: session.created_at,
    completedAt: session.completed_at,
    format: mapping.format ?? null,
    conversionDate: mapping.conversionDate ?? null,
    preparedAt: mapping.preparedAt ?? null,
    summary,
    reconcile,
    progress,
    failures: progress ? progress.failures.slice(0, FAILURE_LIMIT) : [],
    failureCount: progress ? progress.failures.length : 0,
  })
}

/** DELETE — forget a session that never reached the ledger. */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyPermission(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "An applied import cannot be discarded; reverse the journals instead." },
      { status: 409 },
    )
  }

  const { error: deleteError } = await db()
    .from("pharmacy_import_sessions")
    .delete()
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (deleteError) {
    return NextResponse.json({ error: "The session could not be discarded." }, { status: 500 })
  }
  return NextResponse.json({ deleted: true })
}
