import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin, tallyHasCapability } from "@/lib/tally/auth"
import {
  CUTOVER_ALREADY_COMPLETE,
  findCompletedCutover,
  findTallyCutoverOwner,
} from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import type { TallyApplyProgress } from "@/lib/tally/apply"
import {
  isManifestLike,
  type TallyExtractionSummary,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import type { TallyConsolidationReport } from "@/lib/tally/consolidate"
import { isTallyCutoverSession, readStagedSources } from "@/lib/tally/manifest"
import { buildCutoverPreflight } from "@/lib/tally/preflight"
import type { TallyPlanSummary } from "@/lib/tally/types"
import type { TallyReconcileCheck } from "@/lib/tally/reconcile"

const db = () => supabaseAdmin as any
const FAILURE_LIMIT = 200

/** GET /api/admin/tally/[id] — everything the workspace needs to resume. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.read")
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
  const manifest =
    (mapping.manifest as
      | {
          period?: { from: string; to: string }
          periodSource?: string
          declaredPeriod?: { from: string; to: string }
          updatedAt?: string
        }
      | undefined) ?? null

  // The same preflight the apply route enforces, so the review screen can show
  // what is blocking rather than restating the conditions of its own.
  const tagged = isTallyCutoverSession({
    source_system: session.source_system,
    ai_mapping: mapping,
  })
  let auditRecorded: boolean | undefined
  if (tagged && session.status === "complete") {
    const { data: audit } = await db()
      .from("pharmacy_audit_logs")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("action", "IMPORT_TALLY")
      .eq("entity", "IMPORT_SESSION")
      .eq("entity_id", id)
      .limit(1)
      .maybeSingle()
    auditRecorded = Boolean(audit)
  }
  const cutoverPreflight = tagged
    ? buildCutoverPreflight({
        sessionStatus: session.status,
        capabilities: (["inventory.adjust", "reports.financial"] as const).filter((capability) =>
          tallyHasCapability(auth, capability),
        ),
        summary,
        manifest:
          mapping.manifest !== undefined && isManifestLike(mapping.manifest)
            ? (mapping.manifest as TallyMigrationManifest)
            : null,
        manifestProblems: Array.isArray(mapping.manifestProblems)
          ? (mapping.manifestProblems as string[])
          : [],
        flaggedRows: Number(session.flagged_rows ?? 0),
        reconcile,
        auditRecorded,
      })
    : null

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
    mode: mapping.mode ?? "opening",
    preparedAt: mapping.preparedAt ?? null,
    summary,
    // The review's coverage evidence, unchanged from what the preview returned,
    // so a reload shows the same notice and the same acknowledgement state.
    manifest: manifest
      ? {
          period: manifest.period ?? null,
          periodSource: manifest.periodSource ?? null,
          declaredPeriod: manifest.declaredPeriod ?? null,
          coverage: (mapping.manifestCoverage as string | undefined) ?? null,
          problems: Array.isArray(mapping.manifestProblems)
            ? (mapping.manifestProblems as string[])
            : [],
          evidence: mapping.manifestEvidence ?? null,
          manifestUpdatedAt: manifest.updatedAt ?? null,
        }
      : null,
    manifestReason: typeof mapping.manifestReason === "string" ? mapping.manifestReason : null,
    // The files staged one by one, so a reload lists what has arrived so far.
    sources: readStagedSources(mapping.sources),
    // Chunk progress and the merge report, so a reload can resume and review.
    extraction: (mapping.extraction as TallyExtractionSummary | undefined) ?? null,
    consolidation: (mapping.consolidation as TallyConsolidationReport | undefined) ?? null,
    unverifiedAcknowledged: Boolean(mapping.unverifiedAcknowledgement),
    cutoverPreflight,
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
  const auth = await requireTallyAdmin(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  // One-shot: nothing to discard once the cut-over has landed.
  if (await findCompletedCutover(tenantId)) {
    return NextResponse.json(CUTOVER_ALREADY_COMPLETE, { status: 409 })
  }

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  const cutoverOwner = await findTallyCutoverOwner(tenantId)
  if (cutoverOwner === id) {
    return NextResponse.json(
      {
        error: "This Tally cut-over has started and cannot be discarded. Resume the existing session.",
        code: "TALLY_CUTOVER_IN_PROGRESS",
      },
      { status: 409 },
    )
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
