import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin, tallyReplayEnabled } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCutoverBlockingSession } from "@/lib/tally/cutover"
import { evaluateContinuation } from "@/lib/tally/continuation"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import type { TallyImportMode } from "@/lib/tally/types"
import { readTallySource, type TallyStorageClient } from "@/lib/tally/storage"
import { readTallyDocument } from "@/lib/tally/source"
import {
  applyTallyStockSheet,
  readTallyStockSheet,
  type TallyStockSheet,
  type TallyStockSheetMerge,
} from "@/lib/tally/stock-sheet"
import { writeTallyPlan } from "@/lib/tally/plan"
import {
  buildManifestEvidence,
  buildSourceManifest,
  isMultiFileSession,
  type TallyManifestBuild,
} from "@/lib/tally/manifest"
import { consolidateStoredChunks } from "@/lib/tally/consolidate-session"
import {
  canApplyManifest,
  isManifestLike,
  parseTallyIsoDate,
  type TallyDateRange,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import { buildTallyPreview } from "@/lib/tally/preview"
import { editionDisclosure, editionProblems, normaliseTallyEdition } from "@/lib/tally/editions"
import { tallyErrorResponse } from "@/lib/tally/http"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

type MappingState = {
  format?: "xml" | "xlsx" | "xls" | "csv"
  path?: string
  bucket?: string
  conversionDate?: string
  mode?: TallyImportMode
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
  edition?: unknown
  manifest?: unknown
  sources?: unknown
  stockSheet?: { path?: string; fileName?: string; rows?: number }
}

/**
 * POST /api/admin/tally/[id]/preview
 * Parses the uploaded file, normalises it, persists the plan, and returns the
 * review payload. Nothing is written to the ledger here.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  if (await findCutoverBlockingSession(tenantId, id)) {
    return NextResponse.json(CUTOVER_ALREADY_COMPLETE, { status: 409 })
  }

  const { data: session, error: loadError } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, file_name, file_url, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (loadError || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "This import has already been applied and cannot be re-previewed." },
      { status: 409 },
    )
  }

  let body: {
    conversionDate?: string
    mode?: unknown
    period?: unknown
    edition?: unknown
    company?: unknown
    batchExpiry?: unknown
  } = {}
  try {
    const text = await request.text()
    if (text.trim()) {
      body = JSON.parse(text) as {
        conversionDate?: string
        mode?: unknown
        period?: unknown
        edition?: unknown
        company?: unknown
        batchExpiry?: unknown
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (
    body.batchExpiry !== undefined &&
    body.batchExpiry !== "source" &&
    body.batchExpiry !== "not-supplied"
  ) {
    return NextResponse.json(
      { error: "batchExpiry must be \"source\" or \"not-supplied\"", code: "TALLY_BATCH_EXPIRY_INVALID" },
      { status: 400 },
    )
  }
  const batchExpiry = body.batchExpiry === "not-supplied" ? "not-supplied" : "source"
  // The company the operator entered, used only when the file names none.
  const bodyCompany = typeof body.company === "string" ? body.company.trim() : ""
  if (body.company !== undefined && typeof body.company !== "string") {
    return NextResponse.json(
      { error: "company must be a string", code: "TALLY_COMPANY_BODY_INVALID" },
      { status: 400 },
    )
  }
  if (body.mode !== undefined && body.mode !== "opening" && body.mode !== "closing") {
    if (body.mode === "replay" && !tallyReplayEnabled()) {
      return NextResponse.json(
        {
          error: "The historical replay mode is disabled in this environment.",
          code: "TALLY_REPLAY_DISABLED",
        },
        { status: 400 },
      )
    }
    if (body.mode !== "replay") {
      return NextResponse.json(
        {
          error: tallyReplayEnabled()
            ? "mode must be \"opening\", \"closing\" or \"replay\""
            : "mode must be either \"opening\" or \"closing\"",
        },
        { status: 400 },
      )
    }
  }

  // The period the operator asked Tally for. Used only when the file itself
  // does not state a period; a malformed one is refused rather than ignored,
  // because silently dropping it would build a manifest over a guessed range.
  let requestedPeriod: TallyDateRange | undefined
  if (body.period !== undefined) {
    const candidate = body.period as { from?: unknown; to?: unknown }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.from !== "string" ||
      typeof candidate.to !== "string"
    ) {
      return NextResponse.json(
        { error: "period must be an object with from and to dates", code: "TALLY_PERIOD_BODY_INVALID" },
        { status: 400 },
      )
    }
    try {
      if (parseTallyIsoDate(candidate.to) < parseTallyIsoDate(candidate.from)) {
        throw new Error("TALLY_PERIOD_INVALID")
      }
    } catch {
      return NextResponse.json(
        {
          error: "period must be two real calendar days in YYYY-MM-DD form, ending on or after the start.",
          code: "TALLY_PERIOD_BODY_INVALID",
        },
        { status: 400 },
      )
    }
    requestedPeriod = { from: candidate.from, to: candidate.to }
  }

  const mapping = (session.ai_mapping ?? {}) as MappingState
  // A re-preview of the same session keeps the company the first one was given,
  // so changing the cut-over date does not ask for it again.
  const statedCompany =
    bodyCompany || (isManifestLike(mapping.manifest) ? mapping.manifest.company.trim() : "")
  // An upload carries no edition of its own; the portal passes the one the
  // bridge reported, and anything it cannot place is recorded as unknown.
  const edition = normaliseTallyEdition(body.edition ?? mapping.edition)
  const path = mapping.path ?? session.file_url
  if (!path) {
    return NextResponse.json({ error: "Upload the file before previewing it." }, { status: 409 })
  }

  try {
    // A session whose files were staged one by one is previewed once, over
    // every stored chunk at the end. Its manifest is what the sources route
    // accumulated, not one rebuilt from a single document.
    const staged = isMultiFileSession(mapping)
    let document: TallyXmlDocument | undefined
    let format: "xml" | "xlsx" | "xls" | "csv"
    let plan
    let stagedManifest: TallyMigrationManifest | undefined
    let stockSheet: TallyStockSheet | undefined
    let stockSheetMerge: TallyStockSheetMerge | undefined

    if (mapping.stockSheet?.path) {
      stockSheet = readTallyStockSheet(await readTallySource(storage(), mapping.stockSheet.path))
    }

    if (staged) {
      const stored = isManifestLike(mapping.manifest) ? mapping.manifest : undefined
      if (!stored) {
        return NextResponse.json(
          { error: "Add at least one file before previewing.", code: "TALLY_SOURCES_EMPTY" },
          { status: 409 },
        )
      }
      const prepared: TallyMigrationManifest = { ...stored, mode: body.mode ?? stored.mode }
      const gate = canApplyManifest(prepared)
      if (gate.problems.length > 0) {
        return NextResponse.json(
          {
            error:
              "The files staged so far do not cover the migration period exactly once, end to end.",
            code: "TALLY_SOURCES_INCOMPLETE",
            problems: gate.problems.map((entry) => `${entry.code}: ${entry.message}`),
          },
          { status: 422 },
        )
      }
      const consolidated = await consolidateStoredChunks(storage(), {
        tenantId,
        sessionId: id,
        manifest: prepared,
        conversionDate: body.conversionDate ?? mapping.conversionDate,
        accountOverrides: mapping.accountOverrides,
        productSkuOverrides: mapping.productSkuOverrides,
        batchExpiry,
        ...(stockSheet ? { stockSheet } : {}),
      })
      plan = consolidated.plan
      stockSheetMerge = consolidated.stockSheet
      format = "xml"
      stagedManifest = prepared
      mapping.manifest = prepared
    } else {
      const bytes = await readTallySource(storage(), path)
      const read = readTallyDocument(bytes, session.file_name ?? undefined)
      document = read.document
      format = read.format
      // A file that names no company is planned under the one the operator
      // entered, so the plan, the preflight and the manifest state one name.
      // The manifest itself is built from the parsed file, which still says
      // the company came from the form rather than from the export.
      const planDocument =
        !document.company?.trim() && statedCompany
          ? { ...document, company: statedCompany }
          : document
      let sheetDocument = planDocument
      if (stockSheet) {
        stockSheetMerge = applyTallyStockSheet(planDocument, stockSheet)
        sheetDocument = stockSheetMerge.document
      }
      plan = normaliseTallyDocument(sheetDocument, {
        conversionDate: body.conversionDate ?? mapping.conversionDate,
        mode: body.mode ?? mapping.mode,
        currency: document.currency,
        accountOverrides: mapping.accountOverrides,
        productSkuOverrides: mapping.productSkuOverrides,
        batchExpiry,
      })
    }

    // A session that declares a continuation is held to the checkpoint it names
    // before any plan artifact is written, so a refused continuation leaves
    // nothing behind for apply to pick up.
    const continuation = await evaluateContinuation({
      tenantId,
      mapping: mapping as Record<string, unknown>,
      companyKey: plan.companyKey,
      conversionDate: plan.conversionDate,
      mode: plan.mode,
      client: db(),
    })
    if (continuation.kind === "invalid") {
      return NextResponse.json(
        {
          error: continuation.message,
          code: continuation.code,
          continueFrom: continuation.continueFrom ?? null,
        },
        { status: 409 },
      )
    }

    const summary = await writeTallyPlan(storage(), tenantId, id, plan, format)

    let manifest: TallyManifestBuild
    if (document) {
      manifest = buildSourceManifest(document, {
        sessionId: id,
        mode: plan.mode ?? body.mode ?? mapping.mode ?? "opening",
        now: summary.preparedAt,
        requestedPeriod,
        company: statedCompany,
      })
    } else if (stagedManifest) {
      const gate = canApplyManifest(stagedManifest)
      manifest = {
        manifest: stagedManifest,
        problems: [],
        coverage: gate.unverified.length > 0 ? "unverified" : "verified",
      }
    } else {
      throw new Error("TALLY_PREVIEW_UNSTAGED")
    }

    // What the review has to show before Apply. `coverage` is derived from the
    // manifest's own chunk evidence, never from the period the file stated.
    const evidence = manifest.manifest
      ? buildManifestEvidence(manifest.manifest, {
          requestedPeriod: staged ? manifest.manifest.period : requestedPeriod,
          staged: {
            accounts: plan.accounts.length,
            parties: plan.parties.length,
            products: plan.stockItems.length,
            vouchers: plan.vouchers.length,
          },
        })
      : undefined

    await db()
      .from("pharmacy_import_sessions")
      .update({
        status: "review",
        total_rows: plan.counts.vouchers,
        flagged_rows: plan.exceptions.filter((entry) => entry.severity === "blocking").length,
        ai_summary: summary.exceptions[0]?.message?.slice(0, 500) ?? null,
        ai_mapping: {
          ...mapping,
          format,
          path,
          conversionDate: plan.conversionDate,
          mode: plan.mode,
          summary,
          preparedAt: summary.preparedAt,
          edition,
          editionProblems: editionProblems(edition),
          ...(manifest.manifest
            ? {
                manifest: manifest.manifest,
                manifestProblems: manifest.problems,
                manifestCoverage: manifest.coverage,
                manifestEvidence: evidence,
              }
            : { manifestProblems: manifest.problems, manifestReason: manifest.reason }),
        },
        error_message: null,
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)

    return NextResponse.json({
      summary,
      edition: editionDisclosure(edition),
      editionProblems: editionProblems(edition),
      stock: plan.stock,
      // What Apply will check against. `coverage` is never "verified" here
      // unless an independent source count confirmed the chunks.
      manifest: manifest.manifest
        ? {
            period: manifest.manifest.period,
            periodSource: manifest.manifest.periodSource,
            declaredPeriod: manifest.manifest.declaredPeriod ?? null,
            coverage: manifest.coverage,
            problems: manifest.problems,
            evidence: evidence ?? null,
            manifestUpdatedAt: manifest.manifest.updatedAt,
          }
        : { period: null, reason: manifest.reason, problems: manifest.problems },
      preview: buildTallyPreview(plan),
      // What the attached stock sheet contributed, so the review can say
      // whether every item got its batch.
      stockSheet: mapping.stockSheet
        ? {
            attached: true,
            fileName: mapping.stockSheet.fileName ?? null,
            rows: mapping.stockSheet.rows ?? null,
            applied: stockSheetMerge?.applied ?? 0,
            unmatched: stockSheetMerge?.unmatched.slice(0, 20) ?? [],
            unmatchedCount: stockSheetMerge?.unmatched.length ?? 0,
            withoutExpiry: stockSheetMerge?.withoutExpiry ?? 0,
            problems: stockSheet?.problems ?? [],
            problemsOmitted: stockSheet?.problemsOmitted ?? 0,
          }
        : { attached: false },
    })
  } catch (error) {
    const response = tallyErrorResponse(error)
    if (response.status >= 400 && response.status < 500) {
      await db()
        .from("pharmacy_import_sessions")
        .update({
          status: "failed",
          error_message:
            error instanceof Error ? error.message.slice(0, 500) : "Preview failed",
        })
        .eq("id", id)
        .eq("tenant_id", tenantId)
    }
    return response
  }
}
