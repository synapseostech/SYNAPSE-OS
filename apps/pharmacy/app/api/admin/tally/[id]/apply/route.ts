import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin, tallyHasCapability } from "@/lib/tally/auth"
import {
  acquireTallyApplyLease,
  CUTOVER_ALREADY_COMPLETE,
  findCompletedCutover,
  findTallyCutoverOwner,
  releaseTallyApplyLease,
} from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  applyTallyChunk,
  emptyProgress,
  TALLY_STAGE_ORDER,
  type TallyApplyProgress,
  type TallyApplyStage,
} from "@/lib/tally/apply"
import type { TallyApplyDb, TallyPlanSummary } from "@/lib/tally/types"
import { loadStagePlan } from "@/lib/tally/plan"
import {
  canApplyManifest,
  isManifestLike,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import { isTallyCutoverSession } from "@/lib/tally/manifest"
import { buildCutoverPreflight } from "@/lib/tally/preflight"
import { reconcileTallyPlan } from "@/lib/tally/reconcile"
import {
  describeTallyError,
  logTallyEvent,
  logTallyFailure,
  tallyErrorResponse,
} from "@/lib/tally/http"
import type { TallyStorageClient } from "@/lib/tally/storage"

const db = () => supabaseAdmin as any
const applyDb = () => db() as TallyApplyDb
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/** Master-data stages are bulk writes; run them together in one request. */
const STARTER_STAGES: TallyApplyStage[] = ["accounts", "parties", "products"]
const MAX_STAGES = 3

const RESUMABLE = new Set(["review", "mapping", "importing", "failed"])

/** How far a request got before it stopped. A failure names it so the log does. */
type ApplyPhase = "load-plan" | "apply" | "checkpoint" | "finalize"

const STAGES = new Set<string>(TALLY_STAGE_ORDER)

/** The sentence saved to the session, so the reason is visible without the log. */
function applyFailureReason(
  progress: TallyApplyProgress,
  phase: ApplyPhase,
  error: unknown,
): string {
  const step =
    progress.stage === "journals"
      ? `journals chunk ${progress.offset + 1}`
      : `the "${progress.stage}" step`
  const where =
    phase === "load-plan"
      ? `before ${step} started`
      : phase === "apply"
        ? `in ${step}`
        : phase === "checkpoint"
          ? `after ${step}, saving its checkpoint`
          : "while finalising the cut-over"
  return `Apply stopped ${where}: ${describeTallyError(error).errorMessage}`.slice(0, 500)
}

/** The saved execution record a resumed import must carry. */
function isApplyProgressLike(value: unknown): value is TallyApplyProgress {
  if (typeof value !== "object" || value === null) return false
  const progress = value as Record<string, unknown>
  return (
    typeof progress.stage === "string" &&
    STAGES.has(progress.stage) &&
    Number.isInteger(progress.offset) &&
    typeof progress.counts === "object" &&
    progress.counts !== null &&
    Array.isArray(progress.failures) &&
    typeof progress.startedAt === "string" &&
    typeof progress.updatedAt === "string"
  )
}

/**
 * The operator's recorded decision to apply a migration whose completeness no
 * independent count confirms. It names itself `unverified` and is bound to the
 * preview it was given, so a re-preview invalidates it.
 */
type UnverifiedAcknowledgement = {
  coverage: "unverified"
  acknowledgedAt: string
  acknowledgedBy: string
  manifestUpdatedAt: string
}

/** Releases the lease; returns the refusal to send when it cannot be released. */
async function releaseLease(
  tenantId: string,
  id: string,
  token: string,
): Promise<NextResponse | null> {
  try {
    await releaseTallyApplyLease(tenantId, id, token)
    return null
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Tally cut-over lock could not be released.",
        code: "TALLY_CUTOVER_LOCK_RELEASE_FAILED",
      },
      { status: 500 },
    )
  }
}

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
  let phase: ApplyPhase = "load-plan"

  try {
    while (!done && stagesRun < MAX_STAGES) {
      const stageBefore = progress.stage
      // Written before the work, so a request the platform kills still leaves a
      // last-known position to read.
      logTallyEvent("tally.apply.step", {
        sessionId: id,
        tenantId,
        stage: stageBefore,
        offset: progress.offset,
        counts: progress.counts,
        failures: progress.failures.length,
      })

      phase = "load-plan"
      const loaded = await loadStagePlan(storage(), tenantId, id, stageBefore, progress.offset)
      lastPlan = loaded.plan
      summaryForRequest = loaded.summary

      phase = "apply"
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

    phase = "checkpoint"
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
      phase = "finalize"
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
        const storedSummary =
          typeof mapping.summary === "object" && mapping.summary !== null
            ? (mapping.summary as TallyPlanSummary)
            : null
        const sourceCompany = storedSummary?.company ?? storedSummary?.companyKey ?? "not stated"
        const storedManifest =
          mapping.manifest !== undefined && isManifestLike(mapping.manifest)
            ? (mapping.manifest as TallyMigrationManifest)
            : null
        const { error: auditWriteError } = await db().from("pharmacy_audit_logs").insert({
          tenant_id: tenantId,
          profile_id: actorId,
          action: "IMPORT_TALLY",
          entity: "IMPORT_SESSION",
          entity_id: id,
          details: `Tally cut-over applied: ${progress.counts.accounts} accounts, ${progress.counts.parties} parties, ${progress.counts.products} products, ${progress.counts.journals} vouchers, ${progress.counts.openingStock} batches; ${progress.failures.length} listed exceptions; source company "${sourceCompany}", edition ${storedManifest?.edition ?? "not stated"}, session ${id}${mapping.unverifiedAcknowledgement ? "; source completeness unverified, acknowledged by the operator before apply" : ""}`,
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
    const reason = applyFailureReason(progress, phase, error)
    logTallyFailure(
      "tally.apply.failed",
      {
        sessionId: id,
        tenantId,
        phase,
        stage: progress.stage,
        offset: progress.offset,
        counts: progress.counts,
        failureCount: progress.failures.length,
        // The step that stopped is the one being run, so these are the items
        // it had already refused before it could not continue.
        recentFailures: progress.failures.slice(-5),
      },
      error,
    )

    const nextMapping = { ...mapping, progress, interruptedAt: new Date().toISOString() }
    const { error: checkpointError } = await db()
      .from("pharmacy_import_sessions")
      .update({
        status: "importing",
        ai_mapping: nextMapping,
        error_message: reason,
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
    return tallyErrorResponse(
      error,
      "Apply stopped before this step finished. What it already wrote is saved; retry to resume from here.",
    )
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

  // The only field Apply accepts. An unverified migration is applied only after
  // the operator has been shown its evidence and said so; this is that "so".
  let acknowledgedInRequest = false
  const bodyText = await request.text()
  if (bodyText.trim()) {
    let body: { acknowledgeUnverified?: unknown }
    try {
      body = JSON.parse(bodyText) as { acknowledgeUnverified?: unknown }
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "TALLY_APPLY_BODY_INVALID" },
        { status: 400 },
      )
    }
    acknowledgedInRequest = body?.acknowledgeUnverified === true
  }

  const { id } = await params

  const { data: row, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, source_system, flagged_rows, ai_mapping")
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

  const summary = mapping.summary as TallyPlanSummary
  const truncated = summary.exceptions?.some(
    (entry) => entry.code === "SOURCE_TRUNCATED" && entry.severity === "blocking",
  )
  if (truncated) {
    return NextResponse.json(
      {
        error:
          "The importer stopped reading this export part-way through, so the plan is incomplete and cannot be applied. Export the period again, or a shorter one, and preview it.",
        code: "TALLY_SOURCE_TRUNCATED",
      },
      { status: 409 },
    )
  }

  // A Tally cut-over must be able to prove what company and period it covers.
  // Sessions from other import flows never reach this check, so a CSV or Excel
  // import that is not a Tally export is unaffected.
  let acknowledgement: UnverifiedAcknowledgement | undefined
  let cutoverManifest: TallyMigrationManifest | null = null
  let cutoverProblems: string[] = []

  if (isTallyCutoverSession({ source_system: row.source_system, ai_mapping: mapping })) {
    const stored = Array.isArray(mapping.manifestProblems)
      ? mapping.manifestProblems.filter((entry): entry is string => typeof entry === "string")
      : []
    const manifest = mapping.manifest
    // An importing session cannot be re-previewed, so telling it to preview
    // again would be advice that cannot be followed.
    const resuming = row.status === "importing"

    if (manifest === undefined) {
      const reason = typeof mapping.manifestReason === "string" ? mapping.manifestReason : undefined
      return NextResponse.json(
        {
          error: resuming
            ? "This import was already running, but no plan stating its company and period was ever saved, so it cannot be resumed. Nothing was written. Contact support with this session's id rather than starting a new Tally import."
            : (stored[0] ??
              "This Tally session has no plan stating its company and period, so it cannot be applied. Preview the file again."),
          code: reason ?? "TALLY_MANIFEST_MISSING",
          problems: stored,
        },
        { status: 409 },
      )
    }
    if (!isManifestLike(manifest)) {
      return NextResponse.json(
        {
          error: resuming
            ? "This import was already running, but its saved plan could not be read, so it cannot be resumed. Nothing was written. Contact support with this session's id rather than starting a new Tally import."
            : "This migration's chunk plan could not be read. Run the preview again before applying.",
          code: "TALLY_MANIFEST_INVALID",
        },
        { status: 409 },
      )
    }
    const check = canApplyManifest(manifest)
    if (!check.ok || stored.length > 0) {
      return NextResponse.json(
        {
          error: resuming
            ? "This import was already running, but its saved plan is no longer complete, so it cannot be resumed. Nothing was written. Contact support with this session's id rather than starting a new Tally import."
            : "This migration has not been read in full, so it cannot be applied. Every part of the period must be exported and complete, and every voucher must fall inside it.",
          code: "TALLY_MANIFEST_INCOMPLETE",
          problems: [...stored, ...check.problems.map((entry) => `${entry.code}: ${entry.message}`)],
        },
        { status: 409 },
      )
    }

    cutoverManifest = manifest as TallyMigrationManifest
    cutoverProblems = stored

    // A session that is already applying is resumed only if it can prove it is
    // the one that started this cut-over: its plan names this session, an
    // execution record was saved, and the tenant's one-shot reservation names
    // this session too. Without all three, resuming would apply a migration
    // nothing ties back to a reviewed plan, so it fails closed with an
    // instruction to contact support instead of stranding or guessing.
    if (row.status === "importing") {
      const resumeProblems: string[] = []
      if (manifest.sessionId !== id) {
        resumeProblems.push(
          "TALLY_RESUME_SESSION_MISMATCH: the stored plan belongs to a different import session.",
        )
      }
      if (!isApplyProgressLike(mapping.progress)) {
        resumeProblems.push(
          "TALLY_RESUME_PROGRESS_MISSING: no execution record was saved when this import started.",
        )
      }
      let owner: string | null
      try {
        owner = await findTallyCutoverOwner(tenantId)
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "The cut-over reservation could not be read, so this resume cannot be validated.",
            code: "TALLY_CUTOVER_LOCK_UNAVAILABLE",
          },
          { status: 503 },
        )
      }
      if (owner !== id) {
        resumeProblems.push(
          "TALLY_RESUME_OWNER_MISMATCH: the cut-over reservation does not name this session.",
        )
      }
      if (resumeProblems.length > 0) {
        return NextResponse.json(
          {
            error:
              "This import was already running, but its evidence does not match the session that started it, so it will not be resumed. Nothing was written. Contact support with this session's id rather than starting a new Tally import.",
            code: resumeProblems[0]!.split(":")[0],
            problems: resumeProblems,
          },
          { status: 409 },
        )
      }
    }

    // Coverage that no independent count confirms is the operator's decision to
    // take, not something to assume. The decision is recorded against the exact
    // preview it was shown, so re-previewing asks again; the underlying
    // coverage is never relabelled.
    const unverified = check.unverified.length > 0
    if (unverified) {
      const saved = mapping.unverifiedAcknowledgement
      const savedMatches =
        typeof saved === "object" &&
        saved !== null &&
        (saved as Record<string, unknown>).coverage === "unverified" &&
        (saved as Record<string, unknown>).manifestUpdatedAt === manifest.updatedAt

      if (!acknowledgedInRequest && !savedMatches) {
        return NextResponse.json(
          {
            error:
              "This migration has not been independently verified: no source count confirms that every record was read. Review the evidence and acknowledge it before applying.",
            code: "TALLY_UNVERIFIED_NOT_ACKNOWLEDGED",
            coverage: "unverified",
            evidence: mapping.manifestEvidence ?? null,
          },
          { status: 409 },
        )
      }

      acknowledgement = savedMatches
        ? (saved as UnverifiedAcknowledgement)
        : {
            coverage: "unverified",
            acknowledgedAt: new Date().toISOString(),
            acknowledgedBy: actorId,
            manifestUpdatedAt: manifest.updatedAt,
          }
    }
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

  // The preflight the review screen shows and the route enforces is one list.
  // It runs only for a fresh apply: an import already running is resumed, and
  // refusing it here would strand a partial write that only resume can finish.
  if (row.status !== "importing" && cutoverManifest) {
    const preflight = buildCutoverPreflight({
      sessionStatus: row.status,
      capabilities: ["inventory.adjust", "reports.financial"],
      summary: summary as TallyPlanSummary,
      manifest: cutoverManifest,
      manifestProblems: cutoverProblems,
      flaggedRows: blocking,
    })
    if (!preflight.canApply) {
      const refusal = preflight.checks.find(
        (entry) => entry.blocksApply && entry.status !== "pass",
      )
      return NextResponse.json(
        {
          error: refusal?.detail ?? "The cut-over preflight did not pass.",
          code: "TALLY_PREFLIGHT_BLOCKED",
          state: preflight.state,
          checks: preflight.checks,
        },
        { status: 409 },
      )
    }
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

  // Everything above ran against the row as it was before the lease. A request
  // that waited out a concurrent apply holds state that has since moved: it
  // could re-run a finished cut-over, or overwrite an interrupted one's
  // checkpoint with an empty progress. Re-read under the lease and act on what
  // is true now.
  const { data: fresh, error: freshError } = await db()
    .from("pharmacy_import_sessions")
    .select("status, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (freshError || !fresh) {
    const releaseFailure = await releaseLease(tenantId, id, lease.token)
    if (releaseFailure) return releaseFailure
    return freshError
      ? NextResponse.json(
          {
            error: "The import session could not be re-read under the cut-over lock.",
            code: "TALLY_CUTOVER_STATUS_UNAVAILABLE",
          },
          { status: 503 },
        )
      : NextResponse.json({ error: "Import session not found." }, { status: 404 })
  }

  const freshMapping = (fresh.ai_mapping ?? {}) as Record<string, unknown>

  if (fresh.status === "complete") {
    const releaseFailure = await releaseLease(tenantId, id, lease.token)
    if (releaseFailure) return releaseFailure
    return NextResponse.json({
      done: true,
      alreadyComplete: true,
      progress: (freshMapping.progress as TallyApplyProgress | undefined) ?? emptyProgress(),
      reconcile: freshMapping.reconcile ?? null,
    })
  }

  // The plan this request validated must still be the plan on the session. A
  // re-preview between the read and the lock replaces the manifest; applying
  // the old one would write a migration nothing at the screen asked for.
  const freshManifest =
    freshMapping.manifest !== undefined && isManifestLike(freshMapping.manifest)
      ? (freshMapping.manifest as TallyMigrationManifest)
      : null
  const planChanged =
    cutoverManifest !== null && freshManifest?.updatedAt !== cutoverManifest.updatedAt

  if (fresh.status !== row.status || planChanged) {
    const releaseFailure = await releaseLease(tenantId, id, lease.token)
    if (releaseFailure) return releaseFailure
    return NextResponse.json(
      {
        error:
          "This import changed while apply waited for the cut-over lock, so it was not started. Retry apply to resume from its saved position.",
        code: "TALLY_STATE_CHANGED",
      },
      { status: 409 },
    )
  }

  // The execution record is written before the first unit of work, not after
  // it: a crash between reserving the session and writing anything would
  // otherwise leave an `importing` session no resume can ever validate.
  const effectiveMapping = acknowledgement
    ? { ...freshMapping, unverifiedAcknowledgement: acknowledgement }
    : freshMapping
  const startMapping = {
    ...effectiveMapping,
    progress: isApplyProgressLike(effectiveMapping.progress)
      ? effectiveMapping.progress
      : emptyProgress(),
  }

  const { error: startError } = await db()
    .from("pharmacy_import_sessions")
    .update({ status: "importing", ai_mapping: startMapping })
    .eq("id", id)
    .eq("tenant_id", tenantId)

  if (startError) {
    const releaseFailure = await releaseLease(tenantId, id, lease.token)
    if (releaseFailure) return releaseFailure
    return NextResponse.json(
      { error: "The session could not be reserved for apply.", code: "TALLY_CHECKPOINT_SAVE_FAILED" },
      { status: 500 },
    )
  }

  let response: NextResponse
  try {
    response = await applySessionStep({ id, tenantId, actorId, mapping: startMapping })
  } catch (error) {
    // Only reachable when the step's own recovery threw, so say so explicitly:
    // this one may leave no checkpoint behind.
    logTallyFailure("tally.apply.request_failed", { sessionId: id, tenantId }, error)
    response = tallyErrorResponse(
      error,
      "Apply stopped before this step finished. Check this session's error before retrying.",
    )
  }

  const releaseFailure = await releaseLease(tenantId, id, lease.token)
  if (releaseFailure) return releaseFailure

  return response
}
