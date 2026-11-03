import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCompletedCutover } from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import { readTallySource, type TallyStorageClient } from "@/lib/tally/storage"
import { readTallyDocument } from "@/lib/tally/source"
import { writeTallyPlan } from "@/lib/tally/plan"
import { buildManifestEvidence, buildSourceManifest } from "@/lib/tally/manifest"
import { parseTallyIsoDate, type TallyDateRange } from "@/lib/tally/chunks"
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
  mode?: "opening" | "closing"
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
  edition?: unknown
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

  if (await findCompletedCutover(tenantId)) {
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

  let body: { conversionDate?: string; mode?: unknown; period?: unknown; edition?: unknown } = {}
  try {
    const text = await request.text()
    if (text.trim()) {
      body = JSON.parse(text) as {
        conversionDate?: string
        mode?: unknown
        period?: unknown
        edition?: unknown
      }
    }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (body.mode !== undefined && body.mode !== "opening" && body.mode !== "closing") {
    return NextResponse.json(
      { error: "mode must be either \"opening\" or \"closing\"" },
      { status: 400 },
    )
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
  // An upload carries no edition of its own; the portal passes the one the
  // bridge reported, and anything it cannot place is recorded as unknown.
  const edition = normaliseTallyEdition(body.edition ?? mapping.edition)
  const path = mapping.path ?? session.file_url
  if (!path) {
    return NextResponse.json({ error: "Upload the file before previewing it." }, { status: 409 })
  }

  try {
    const bytes = await readTallySource(storage(), path)
    const { format, document } = readTallyDocument(bytes, session.file_name ?? undefined)

    const plan = normaliseTallyDocument(document, {
      conversionDate: body.conversionDate ?? mapping.conversionDate,
      mode: body.mode ?? mapping.mode,
      currency: document.currency,
      accountOverrides: mapping.accountOverrides,
      productSkuOverrides: mapping.productSkuOverrides,
    })

    const summary = await writeTallyPlan(storage(), tenantId, id, plan, format)
    const manifest = buildSourceManifest(document, {
      sessionId: id,
      mode: plan.mode ?? body.mode ?? mapping.mode ?? "opening",
      now: summary.preparedAt,
      requestedPeriod,
    })

    // What the review has to show before Apply. `coverage` is derived from the
    // manifest's own chunk evidence, never from the period the file stated.
    const evidence = manifest.manifest
      ? buildManifestEvidence(manifest.manifest, {
          requestedPeriod,
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
