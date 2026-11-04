import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCompletedCutover } from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import {
  createTallyChunkUploadTarget,
  readTallySource,
  tallyChunkSourcePath,
  type TallyStorageClient,
} from "@/lib/tally/storage"
import { readTallyDocument } from "@/lib/tally/source"
import { writeTallyPlan } from "@/lib/tally/plan"
import { buildManifestEvidence } from "@/lib/tally/manifest"
import {
  canApplyManifest,
  createManifest,
  dateSpan,
  isManifestLike,
  manifestProblems,
  parseTallyIsoDate,
  recordChunkResult,
  splitChunk,
  summariseExtraction,
  type TallyDateRange,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import { TallyConsolidationError } from "@/lib/tally/consolidate"
import { consolidateStoredChunks } from "@/lib/tally/consolidate-session"
import {
  editionDisclosure,
  editionProblems,
  normaliseTallyEdition,
} from "@/lib/tally/editions"
import { buildTallyPreview } from "@/lib/tally/preview"
import { logTallyEvent, logTallyFailure, tallyErrorResponse } from "@/lib/tally/http"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/** One chunk's own ceiling. The bucket is wider; this is what the parser can take. */
const CHUNK_LIMIT = 20 * 1024 * 1024
const MAX_PARTS = 240

type MappingState = {
  format?: "xml" | "xlsx" | "xls" | "csv"
  path?: string
  bucket?: string
  conversionDate?: string
  mode?: "opening" | "closing"
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
  manifest?: unknown
  manifestProblems?: unknown
  manifestCoverage?: "verified" | "unverified"
  manifestEvidence?: unknown
  manifestReason?: string
  edition?: unknown
  consolidation?: unknown
  extraction?: unknown
}

type ExtractBody = {
  action?: unknown
  company?: unknown
  mode?: unknown
  period?: unknown
  parts?: unknown
  restart?: unknown
  edition?: unknown
  chunkId?: unknown
  path?: unknown
  error?: unknown
  ranges?: unknown
}

function badRequest(error: string, code?: string) {
  return NextResponse.json(code ? { error, code } : { error }, { status: 400 })
}

function conflict(error: string, code: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json({ error, code, ...extra }, { status: 409 })
}

function readPeriod(value: unknown): TallyDateRange | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const candidate = value as { from?: unknown; to?: unknown }
  if (typeof candidate.from !== "string" || typeof candidate.to !== "string") return undefined
  try {
    if (parseTallyIsoDate(candidate.to) < parseTallyIsoDate(candidate.from)) return undefined
  } catch {
    return undefined
  }
  return { from: candidate.from, to: candidate.to }
}

/** One voucher range per month, which the bridge reads without splitting. */
function defaultParts(period: TallyDateRange): number {
  const start = parseTallyIsoDate(period.from)
  const end = parseTallyIsoDate(period.to)
  const days = Math.round((end - start) / 86_400_000) + 1
  return Math.max(1, Math.min(MAX_PARTS, Math.ceil(days / 31)))
}

function manifestOf(mapping: MappingState, sessionId: string): TallyMigrationManifest | undefined {
  if (!isManifestLike(mapping.manifest)) return undefined
  // The manifest belongs to the session it was written on. One copied from
  // another session is refused rather than resumed against the wrong books.
  return mapping.manifest.sessionId === sessionId ? mapping.manifest : undefined
}

function payload(manifest: TallyMigrationManifest, extra: Record<string, unknown> = {}) {
  // The edition is carried with every response so the review cannot show the
  // numbers without also showing what produced them and what is unproven.
  const edition = manifest.edition ?? "unknown"
  return {
    manifest,
    summary: summariseExtraction(manifest),
    edition: editionDisclosure(edition),
    editionProblems: editionProblems(edition),
    ...extra,
  }
}

async function saveManifest(
  tenantId: string,
  id: string,
  mapping: MappingState,
  manifest: TallyMigrationManifest,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db()
    .from("pharmacy_import_sessions")
    .update({
      ai_mapping: {
        ...mapping,
        manifest,
        extraction: summariseExtraction(manifest),
        // A chunked extraction supersedes whatever evidence the session held:
        // the chunks are now the only record of what was read.
        manifestProblems: [],
        manifestReason: null,
        ...extra,
      },
      error_message: null,
    })
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (error) throw new Error(`TALLY_MANIFEST_WRITE_FAILED: ${error.message}`)
}

async function failChunk(
  tenantId: string,
  id: string,
  mapping: MappingState,
  manifest: TallyMigrationManifest,
  chunkId: string,
  message: string,
) {
  const next = recordChunkResult(manifest, chunkId, { status: "failed", error: message })
  await saveManifest(tenantId, id, mapping, next)
  // The browser saw this failure as a toast and nothing else; this line is the
  // only server-side record that the chunk was refused and why.
  logTallyFailure(
    "tally.extract.chunk_failed",
    { sessionId: id, tenantId, chunkId },
    message,
  )
  return NextResponse.json(payload(next, { result: { status: "failed", error: message } }))
}

/**
 * POST /api/admin/tally/[id]/extract
 *
 * The portal server's half of the extraction loop. The browser read the chunks
 * from the local bridge but cannot be trusted to say what it read, so every
 * chunk is parsed here: it is only recorded complete once this server has read
 * it, matched its company, and found every voucher inside the range that was
 * asked for. Nothing reaches the ledger here — `finish` stages the plan and
 * leaves Apply to post it.
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
    return conflict(
      "This import has already been applied and cannot be extracted again.",
      "TALLY_SESSION_APPLIED",
    )
  }

  let body: ExtractBody
  try {
    const text = await request.text()
    if (text.length > 64 * 1024) return badRequest("The extraction request is too large.")
    body = text.trim() ? (JSON.parse(text) as ExtractBody) : {}
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const mapping = (session.ai_mapping ?? {}) as MappingState
  const action = typeof body.action === "string" ? body.action : ""

  try {
    if (action === "begin") {
      if (body.mode !== undefined && body.mode !== "opening" && body.mode !== "closing") {
        return badRequest("mode must be either \"opening\" or \"closing\"")
      }
      const mode = (body.mode as "opening" | "closing" | undefined) ?? mapping.mode ?? "opening"
      if (mode === "closing") {
        return badRequest(
          "A balances-only cut-over reads no vouchers, so there is nothing to extract in chunks. Use the closing cut-over instead.",
          "TALLY_EXTRACTION_MODE_UNSUPPORTED",
        )
      }
      const period = readPeriod(body.period)
      if (!period) {
        return badRequest(
          "period must be two real calendar days in YYYY-MM-DD form, ending on or after the start.",
          "TALLY_PERIOD_BODY_INVALID",
        )
      }
      const company = typeof body.company === "string" ? body.company.trim() : ""
      if (!company) {
        return badRequest(
          "company is required: extraction is pinned to one Tally company.",
          "TALLY_COMPANY_MISSING",
        )
      }
      if (
        body.parts !== undefined &&
        body.parts !== null &&
        (typeof body.parts !== "number" ||
          !Number.isInteger(body.parts) ||
          body.parts < 1 ||
          body.parts > MAX_PARTS)
      ) {
        return badRequest(`parts must be a whole number between 1 and ${MAX_PARTS}.`)
      }

      const existing = manifestOf(mapping, id)
      if (isManifestLike(mapping.manifest) && !existing) {
        return conflict(
          "The saved extraction belongs to a different session. Start a new import.",
          "TALLY_EXTRACTION_MISMATCH",
        )
      }
      if (existing && body.restart !== true) {
        const sameRequest =
          existing.company.toLowerCase() === company.toLowerCase() &&
          existing.period.from === period.from &&
          existing.period.to === period.to &&
          existing.mode === mode
        if (!sameRequest) {
          return conflict(
            "This session is already extracting a different company, period or mode. Restart the extraction to replace it.",
            "TALLY_EXTRACTION_MISMATCH",
          )
        }
        // The same request again is a resume, not a new extraction: completed
        // chunks stay complete and no range is read twice.
        return NextResponse.json(payload(existing))
      }
      if (
        existing &&
        body.restart === true &&
        existing.chunks.some((chunk) => chunk.status === "complete")
      ) {
        return conflict(
          "This extraction has already read chunks. Apply it, or start a new import to extract again.",
          "TALLY_EXTRACTION_HAS_PROGRESS",
        )
      }

      const parts = typeof body.parts === "number" ? body.parts : defaultParts(period)
      const manifest = createManifest({
        sessionId: id,
        company,
        mode,
        period,
        parts,
        edition: normaliseTallyEdition(body.edition),
        updatedAt: new Date().toISOString(),
      })
      await saveManifest(tenantId, id, mapping, manifest, {
        consolidation: null,
        manifestCoverage: "unverified",
        manifestEvidence: null,
      })
      // The status column only allows pending|mapping|review|importing|complete|
      // failed, so progress lives in `ai_mapping.extraction` and the session sits
      // in `mapping` until `finish` moves it to review.
      const { error } = await db()
        .from("pharmacy_import_sessions")
        .update({ status: "mapping", total_rows: 0, flagged_rows: 0 })
        .eq("id", id)
        .eq("tenant_id", tenantId)
      if (error) throw new Error(`TALLY_SESSION_WRITE_FAILED: ${error.message}`)
      logTallyEvent("tally.extract.begin", {
        sessionId: id,
        tenantId,
        mode,
        from: period.from,
        to: period.to,
        parts,
      })
      return NextResponse.json(payload(manifest))
    }

    const manifest = manifestOf(mapping, id)
    if (!manifest) {
      return conflict(
        "Start the extraction before sending chunks.",
        "TALLY_EXTRACTION_NOT_STARTED",
      )
    }

    if (action === "status") return NextResponse.json(payload(manifest))

    if (action === "finish") {
      const summary = summariseExtraction(manifest)
      const problems = manifestProblems(manifest)
      if (!summary.completeAll || problems.length > 0) {
        return conflict(
          "Every chunk must be read before this extraction can be reviewed.",
          "TALLY_EXTRACTION_INCOMPLETE",
          { summary, problems },
        )
      }

      const { plan, consolidation } = await consolidateStoredChunks(storage(), {
        tenantId,
        sessionId: id,
        manifest,
        conversionDate: mapping.conversionDate,
        accountOverrides: mapping.accountOverrides,
        productSkuOverrides: mapping.productSkuOverrides,
      })
      const planSummary = await writeTallyPlan(storage(), tenantId, id, plan, "xml")

      const evidence = buildManifestEvidence(manifest, {
        requestedPeriod: manifest.period,
        staged: {
          accounts: plan.accounts.length,
          parties: plan.parties.length,
          products: plan.stockItems.length,
          vouchers: plan.vouchers.length,
        },
      })
      const gate = canApplyManifest(manifest)
      const coverage = gate.unverified.length > 0 ? "unverified" : "verified"

      const { error: writeError } = await db()
        .from("pharmacy_import_sessions")
        .update({
          status: "review",
          total_rows: plan.counts.vouchers,
          flagged_rows: plan.exceptions.filter((entry) => entry.severity === "blocking").length,
          ai_summary: planSummary.exceptions[0]?.message?.slice(0, 500) ?? null,
          ai_mapping: {
            ...mapping,
            format: "xml",
            path: null,
            conversionDate: plan.conversionDate,
            mode: plan.mode,
            summary: planSummary,
            preparedAt: planSummary.preparedAt,
            manifest,
            extraction: summary,
            manifestProblems: gate.problems,
            manifestCoverage: coverage,
            manifestEvidence: evidence,
            // Recorded on the session as well as inside the manifest, so the
            // apply evidence states the edition without walking the manifest.
            edition: manifest.edition ?? "unknown",
            editionProblems: editionProblems(manifest.edition ?? "unknown"),
            consolidation: consolidation.report,
          },
          error_message: null,
        })
        .eq("id", id)
        .eq("tenant_id", tenantId)
      if (writeError) throw new Error(`TALLY_SESSION_WRITE_FAILED: ${writeError.message}`)

      logTallyEvent("tally.extract.finished", {
        sessionId: id,
        tenantId,
        chunks: summary.totalChunks,
        documents: plan.counts.vouchers,
        gaps: summary.gaps.length,
        coverage,
      })

      return NextResponse.json({
        summary: planSummary,
        extraction: summary,
        consolidation: consolidation.report,
        evidence,
        coverage,
        manifestProblems: gate.problems,
        edition: editionDisclosure(manifest.edition ?? "unknown"),
        editionProblems: editionProblems(manifest.edition ?? "unknown"),
        stock: plan.stock,
        preview: buildTallyPreview(plan),
        // The same block Preview returns, so the review renders one shape
        // whichever way the plan was staged.
        manifest: {
          period: manifest.period,
          periodSource: manifest.periodSource,
          declaredPeriod: manifest.declaredPeriod ?? null,
          coverage,
          problems: gate.problems.map((entry) => `${entry.code}: ${entry.message}`),
          evidence,
          manifestUpdatedAt: manifest.updatedAt,
        },
      })
    }

    const chunkId = typeof body.chunkId === "string" ? body.chunkId : ""
    const chunk = manifest.chunks.find((entry) => entry.id === chunkId)
    if (!chunk) {
      return NextResponse.json(
        { error: "Unknown chunk.", code: "TALLY_CHUNK_UNKNOWN" },
        { status: 404 },
      )
    }

    if (action === "target") {
      // A signed URL the browser uploads this chunk's XML to, so a 20 MB
      // payload never travels through a body the host caps near 4.5 MB.
      return NextResponse.json(
        await createTallyChunkUploadTarget(storage(), { tenantId, sessionId: id, chunkId }),
      )
    }

    if (action === "start" || action === "fail" || action === "split") {
      // A completed chunk is final: a late tab, a retry or a duplicate report
      // cannot reopen a range the manifest has already accounted for.
      if (chunk.status === "complete") return NextResponse.json(payload(manifest))

      if (action === "start") {
        const next = recordChunkResult(manifest, chunkId, { status: "running" })
        await saveManifest(tenantId, id, mapping, next)
        return NextResponse.json(payload(next))
      }

      if (action === "fail") {
        return failChunk(
          tenantId,
          id,
          mapping,
          manifest,
          chunkId,
          typeof body.error === "string" && body.error.trim()
            ? body.error.trim().slice(0, 300)
            : "TALLY_CHUNK_FAILED",
        )
      }

      const ranges = Array.isArray(body.ranges) ? body.ranges.map(readPeriod) : []
      if (ranges.length < 2 || ranges.some((range) => range === undefined)) {
        return badRequest(
          "ranges must be at least two valid date ranges.",
          "TALLY_CHUNK_SPLIT_TOO_SMALL",
        )
      }
      const next = splitChunk(manifest, chunkId, ranges as TallyDateRange[])
      await saveManifest(tenantId, id, mapping, next)
      logTallyEvent("tally.extract.split", {
        sessionId: id,
        tenantId,
        chunkId,
        ranges: (ranges as TallyDateRange[]).map((range) => `${range.from}..${range.to}`),
      })
      return NextResponse.json(payload(next))
    }

    if (action === "chunk") {
      // A duplicate delivery of a chunk already recorded changes nothing: the
      // first parse is what the manifest was built from.
      if (chunk.status === "complete") {
        return NextResponse.json(payload(manifest, { result: { status: "complete" } }))
      }
      const path = typeof body.path === "string" ? body.path : ""
      if (path !== tallyChunkSourcePath(tenantId, id, chunkId)) {
        return badRequest(
          "This chunk was not uploaded to its own storage path.",
          "TALLY_CHUNK_PATH_INVALID",
        )
      }

      let bytes: Uint8Array
      let parsed: ReturnType<typeof readTallyDocument>
      try {
        bytes = await readTallySource(storage(), path, CHUNK_LIMIT)
        parsed = readTallyDocument(bytes, `${chunkId}.xml`)
      } catch (error) {
        // An unreadable or oversized response fails this chunk rather than being
        // recorded anyway: re-reading the same range would change nothing.
        return failChunk(
          tenantId,
          id,
          mapping,
          manifest,
          chunkId,
          error instanceof Error ? error.message.slice(0, 300) : "TALLY_CHUNK_UNREADABLE",
        )
      }
      if (parsed.format !== "xml") {
        return failChunk(tenantId, id, mapping, manifest, chunkId, "TALLY_CHUNK_NOT_XML")
      }

      const document = parsed.document
      const company = (document.company ?? "").trim()
      if (!company || company.toLowerCase() !== manifest.company.toLowerCase()) {
        return failChunk(
          tenantId,
          id,
          mapping,
          manifest,
          chunkId,
          company ? "TALLY_BRIDGE_COMPANY_MISMATCH" : "TALLY_BRIDGE_COMPANY_UNVERIFIED",
        )
      }
      if (document.truncated) {
        return failChunk(tenantId, id, mapping, manifest, chunkId, "SOURCE_TRUNCATED")
      }

      // A voucher dated outside the range that was asked for means the range was
      // not honoured, so this payload cannot stand in for it.
      const outside = document.vouchers.filter((voucher) => {
        if (!voucher.date) return false
        try {
          const at = parseTallyIsoDate(voucher.date)
          return at < parseTallyIsoDate(chunk.range.from) || at > parseTallyIsoDate(chunk.range.to)
        } catch {
          // An unreadable date is the normaliser's problem and blocks Apply
          // there; it does not make the range wrong.
          return false
        }
      })
      if (outside.length > 0) {
        return failChunk(
          tenantId,
          id,
          mapping,
          manifest,
          chunkId,
          `TALLY_CHUNK_DATES_OUTSIDE: ${outside.length} voucher${outside.length === 1 ? "" : "s"} fall outside ${chunk.range.from} to ${chunk.range.to}.`,
        )
      }

      const masterRecords =
        document.groups.length +
        document.ledgers.length +
        document.stockGroups.length +
        document.stockItems.length +
        document.units.length +
        document.godowns.length
      const recordsRead = chunk.kind === "masters" ? masterRecords : document.vouchers.length
      const span = dateSpan(document.vouchers.map((voucher) => voucher.date))
      const next = recordChunkResult(manifest, chunkId, {
        status: "complete",
        recordsRead,
        bytes: bytes.byteLength,
        ...(chunk.kind === "vouchers" ? span : {}),
      })
      await saveManifest(tenantId, id, mapping, next)
      logTallyEvent("tally.extract.chunk_complete", {
        sessionId: id,
        tenantId,
        chunkId,
        kind: chunk.kind,
        recordsRead,
        bytes: bytes.byteLength,
      })
      return NextResponse.json(
        payload(next, { result: { status: "complete", recordsRead, ...span } }),
      )
    }

    return badRequest(
      "action must be one of begin, status, target, start, chunk, fail, split, finish.",
    )
  } catch (error) {
    if (error instanceof TallyConsolidationError) {
      return conflict(
        error.code === "TALLY_CONSOLIDATION_COMPANY_MISMATCH"
          ? "The chunks belong to different companies, so they were not combined."
          : "The chunks could not be combined safely.",
        error.code,
      )
    }
    const message = error instanceof Error ? error.message : ""
    if (/^TALLY_CHUNK_(UNKNOWN|DUPLICATE_ID|NOT_SPLITTABLE|SPLIT_TOO_SMALL|RANGE_MINIMAL)/.test(message)) {
      return badRequest(message.replace(/^[A-Z_]+:\s*/, ""), message.split(":")[0])
    }
    return tallyErrorResponse(error)
  }
}

export const dynamic = "force-dynamic"
