import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCutoverBlockingSession } from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import type { TallyImportMode } from "@/lib/tally/types"
import {
  readTallySource,
  tallyChunkSourcePath,
  tallyStagedSourcePath,
  writeTallySourceBytes,
  type TallySourceExtension,
  type TallyStorageClient,
} from "@/lib/tally/storage"
import { readTallyDocument } from "@/lib/tally/source"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import {
  readTallyArchive,
  readTallyPackageCompany,
  TallyArchiveError,
  type TallyArchiveReport,
} from "@synapse/db/tally-archive"
import {
  describeStagedDocument,
  readStagedSources,
  type TallyStagedSource,
} from "@/lib/tally/manifest"
import {
  createOpenManifest,
  ensureChunk,
  isManifestLike,
  manifestProblems,
  recordChunkResult,
  replaceChunkResult,
  widenPeriod,
  type TallyDateRange,
  type TallyMigrationManifest,
} from "@/lib/tally/chunks"
import { tallyErrorResponse } from "@/lib/tally/http"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

const EXTENSIONS: Record<string, TallySourceExtension> = {
  xml: "xml",
  xlsx: "xlsx",
  xls: "xls",
  csv: "csv",
  zip: "zip",
}

type MappingState = {
  format?: "xml" | "xlsx" | "xls" | "csv"
  path?: string
  mode?: TallyImportMode
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
  manifest?: unknown
  sources?: unknown
}

/** Hex SHA-256, so re-uploading the same bytes is recognised rather than refused. */
async function checksumOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/**
 * POST /api/admin/tally/[id]/sources
 * Adopts one file the browser already uploaded to a staging path: parses it,
 * gives it the chunk id its own company and period imply, copies it to that
 * chunk's canonical path, and merges the chunk into the session's manifest.
 *
 * An incomplete set of ranges is expected while files are still arriving, so
 * the manifest's coverage problems are returned as advice, not as a refusal.
 * Preview gates on them once; Apply still requires a complete tiling.
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
    .select("id, status, file_name, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (loadError || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "This import has already been applied and cannot take more files." },
      { status: 409 },
    )
  }

  let body: {
    uploadId?: unknown
    fileName?: unknown
    kind?: unknown
    period?: unknown
    fallbackPeriod?: unknown
    company?: unknown
    replace?: unknown
  } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text) as typeof body
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const uploadId = typeof body.uploadId === "string" ? body.uploadId.trim() : ""
  if (!uploadId) {
    return NextResponse.json(
      { error: "uploadId is required", code: "TALLY_UPLOAD_ID_MISSING" },
      { status: 400 },
    )
  }

  const fileName = typeof body.fileName === "string" ? body.fileName.trim() : ""
  const extension = EXTENSIONS[fileName.toLowerCase().split(".").pop() ?? ""]
  if (!extension) {
    return NextResponse.json(
      { error: "Choose a Tally XML export, an .xlsx/.xls workbook, or a .csv template file." },
      { status: 415 },
    )
  }
  // A session's chunks are read back as XML when the migration is consolidated,
  // so a workbook or CSV cannot stand as one of them. One of those still goes in
  // as a session's only file, through preview's single-file path. A package is
  // expanded into the XML exports it holds, so it stages as well as they do.
  if (extension !== "xml" && extension !== "zip") {
    return NextResponse.json(
      {
        error: "A cut-over built from several files takes Tally XML exports. Use one workbook or CSV on its own instead.",
        code: "TALLY_FILE_TYPE_UNSUPPORTED",
      },
      { status: 415 },
    )
  }

  const kind =
    body.kind === "masters" || body.kind === "vouchers" ? body.kind : undefined

  const readPeriod = (value: unknown): TallyDateRange | undefined => {
    const candidate = value as { from?: unknown; to?: unknown }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      typeof candidate.from !== "string" ||
      typeof candidate.to !== "string"
    ) {
      return undefined
    }
    return { from: candidate.from, to: candidate.to }
  }

  const periodInvalid = () =>
    NextResponse.json(
      {
        error: "period must be an object with from and to dates",
        code: "TALLY_PERIOD_BODY_INVALID",
      },
      { status: 400 },
    )

  let requestedPeriod: TallyDateRange | undefined
  if (body.period !== undefined) {
    requestedPeriod = readPeriod(body.period)
    if (!requestedPeriod) return periodInvalid()
  }

  // The period entered for the whole cut-over, used only for a file that names
  // no period of its own. It ranks below the file's own statement so one set of
  // dates cannot make every slice claim the whole range.
  let fallbackPeriod: TallyDateRange | undefined
  if (body.fallbackPeriod !== undefined) {
    fallbackPeriod = readPeriod(body.fallbackPeriod)
    if (!fallbackPeriod) return periodInvalid()
  }

  const company = typeof body.company === "string" ? body.company.trim() : ""
  if (body.company !== undefined && typeof body.company !== "string") {
    return NextResponse.json(
      { error: "company must be a string", code: "TALLY_COMPANY_BODY_INVALID" },
      { status: 400 },
    )
  }

  const replace = body.replace === true
  const mapping = (session.ai_mapping ?? {}) as MappingState
  const now = new Date().toISOString()

  let stagedPath: string
  try {
    stagedPath = tallyStagedSourcePath(tenantId, id, uploadId, extension)
  } catch {
    return NextResponse.json(
      { error: "uploadId is not a valid upload reference", code: "TALLY_UPLOAD_ID_INVALID" },
      { status: 400 },
    )
  }

  const existing = isManifestLike(mapping.manifest) ? mapping.manifest : undefined
  let manifest: TallyMigrationManifest | undefined = existing
  let sources = readStagedSources(mapping.sources)

  type StageResult =
    | { ok: true; entry: TallyStagedSource; duplicate: boolean }
    | { ok: false; response: NextResponse }

  /**
   * Stages one export under the chunk its own company and period imply. Shared
   * by a file uploaded on its own and by every entry of a package, so both
   * follow the same company, overlap and idempotency rules.
   */
  const stageParsed = async (
    fileBytes: Uint8Array,
    entryName: string,
    entryCompany: string,
    parsed?: TallyXmlDocument,
  ): Promise<StageResult> => {
    const document = parsed ?? readTallyDocument(fileBytes, entryName).document
    const described = describeStagedDocument(document, {
      requestedPeriod,
      fallbackPeriod,
      company: entryCompany,
      kind,
    })
    if (!described.ok) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: described.message, code: described.code, file: entryName },
          { status: 422 },
        ),
      }
    }

    if (manifest && manifest.company.trim() !== described.company) {
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `This file belongs to "${described.company}", but the cut-over is for "${manifest.company}".`,
            code: "TALLY_COMPANY_MISMATCH",
            file: entryName,
          },
          { status: 422 },
        ),
      }
    }

    let next: TallyMigrationManifest =
      manifest ??
      createOpenManifest({
        sessionId: id,
        company: described.company,
        companySource: described.companySource,
        mode: mapping.mode ?? "opening",
        period: described.range,
        periodSource: described.periodSource,
        ...(described.declaredPeriod ? { declaredPeriod: described.declaredPeriod } : {}),
        updatedAt: now,
      })

    // A file that names the company is better evidence than the operator's
    // word, so the record upgrades rather than keeps claiming it was entered.
    if (manifest && described.companySource === "file" && manifest.companySource !== "file") {
      next = { ...next, companySource: "file", updatedAt: now }
    }

    // The chunk is added first: the period is the union of the day books staged
    // so far, so the one being added has to be one of them.
    next = ensureChunk(
      next,
      { kind: described.kind, id: described.chunkId, range: described.range },
      now,
    )
    next = widenPeriod(next, described.range, now, described.kind)

    const target = next.chunks.find((chunk) => chunk.id === described.chunkId)
    if (!target) throw new Error("TALLY_CHUNK_UNKNOWN")

    const checksum = await checksumOf(fileBytes)
    const result = {
      status: "complete" as const,
      recordsRead: described.recordsRead,
      checksum,
      bytes: fileBytes.byteLength,
      ...(described.firstDate ? { firstDate: described.firstDate } : {}),
      ...(described.lastDate ? { lastDate: described.lastDate } : {}),
    }

    if (target.status === "complete" && !replace) {
      // The same bytes are an idempotent retry; different bytes are a corrected
      // slice, which the operator has to confirm before it replaces what is
      // already staged.
      if (target.checksum === checksum) {
        const known = sources.find((entry) => entry.chunkId === described.chunkId)
        return {
          ok: true,
          duplicate: true,
          entry:
            known ?? {
              uploadId,
              fileName: entryName,
              kind: described.kind,
              chunkId: described.chunkId,
              range: described.range,
              recordsRead: described.recordsRead,
              bytes: fileBytes.byteLength,
              stagedAt: now,
            },
        }
      }
      return {
        ok: false,
        response: NextResponse.json(
          {
            error: `A file is already staged for ${described.range.from} to ${described.range.to}. Add it again with replace to use this one instead.`,
            code: "TALLY_CHUNK_ALREADY_STAGED",
            chunkId: described.chunkId,
            file: entryName,
          },
          { status: 409 },
        ),
      }
    }

    next = replace
      ? replaceChunkResult(next, described.chunkId, result, now)
      : recordChunkResult(next, described.chunkId, result, now)

    await writeTallySourceBytes(
      storage(),
      tallyChunkSourcePath(tenantId, id, described.chunkId),
      fileBytes,
    )

    const entry: TallyStagedSource = {
      uploadId,
      fileName: entryName,
      kind: described.kind,
      chunkId: described.chunkId,
      range: described.range,
      recordsRead: described.recordsRead,
      bytes: fileBytes.byteLength,
      stagedAt: now,
    }
    // One upload can hold many entries (a package), so the chunk id is what
    // identifies an entry being replaced — not the upload that carried it.
    sources = [...sources.filter((staged) => staged.chunkId !== described.chunkId), entry]
    manifest = next
    return { ok: true, entry, duplicate: false }
  }

  try {
    const bytes = await readTallySource(storage(), stagedPath)

    if (extension === "zip") {
      const packageCompany = company || readTallyPackageCompany(bytes)?.name || ""
      const stop = Symbol("stop")
      // Held on an object so the callback's assignment survives the closure.
      const halted: { refusal: NextResponse | null } = { refusal: null }
      let duplicates = 0
      let report: TallyArchiveReport

      try {
        report = await readTallyArchive(bytes, {
          onDocument: async (document, file, extracted) => {
            const outcome = await stageParsed(extracted, file.name, packageCompany, document)
            if (!outcome.ok) {
              halted.refusal = outcome.response
              throw stop
            }
            if (outcome.duplicate) duplicates += 1
          },
        })
      } catch (error) {
        if (error === stop) {
          return (
            halted.refusal ?? NextResponse.json({ error: "The package could not be staged." }, { status: 500 })
          )
        }
        if (error instanceof TallyArchiveError) {
          return NextResponse.json({ error: error.message, code: error.code }, { status: 422 })
        }
        throw error
      }

      // An entry that could not be read leaves a month missing from the
      // package. Staging the rest would import a gap while looking complete,
      // so the whole package is refused until it is re-exported.
      if (report.reconciliation.status === "failed") {
        return NextResponse.json(
          {
            error:
              "At least one file in the package could not be read, so the package is incomplete. Re-export the failed month and upload the package again.",
            code: "TALLY_ARCHIVE_FAILED",
            problems: report.reconciliation.problems,
          },
          { status: 422 },
        )
      }

      if (!manifest) {
        return NextResponse.json(
          {
            error: "The package holds no Tally export that could be staged.",
            code: "TALLY_ARCHIVE_NO_EXPORTS",
            problems: report.reconciliation.problems,
          },
          { status: 422 },
        )
      }

      const problems = [
        ...manifestProblems(manifest).map((entry) => `${entry.code}: ${entry.message}`),
        ...report.reconciliation.problems.map((problem) => `TALLY_ARCHIVE: ${problem}`),
      ]

      const archive = {
        company: report.company,
        reconciliation: report.reconciliation,
        ignored: report.ignored,
        files: report.files.map((file) => ({
          name: file.name,
          role: file.role,
          bytes: file.bytes,
          sha256: file.sha256,
          vouchers: file.vouchers,
          inventoryLines: file.inventoryLines,
          batchAllocations: file.batchAllocations,
          firstDate: file.firstDate,
          lastDate: file.lastDate,
          controlCharactersStripped: file.controlCharactersStripped,
          failure: file.failure,
          discrepancies: file.discrepancies,
        })),
      }

      const patch: Record<string, unknown> = {
        ai_mapping: {
          ...mapping,
          // The package's chunks are XML exports, so the session is an XML
          // cut-over from here on and must keep being recognised as one.
          format: "xml",
          manifest,
          sources,
          manifestProblems: problems,
          archive,
        },
        error_message: null,
      }
      // Adding a file invalidates a preview already run over fewer chunks.
      if (session.status === "review") patch.status = "pending"

      const { error: writeError } = await db()
        .from("pharmacy_import_sessions")
        .update(patch)
        .eq("id", id)
        .eq("tenant_id", tenantId)
      if (writeError) throw new Error(`TALLY_SESSION_WRITE_FAILED: ${writeError.message}`)

      return NextResponse.json({
        sources,
        manifest: {
          period: manifest.period,
          periodSource: manifest.periodSource,
          problems,
        },
        archive,
        duplicates,
        staged: sources.length,
      })
    }

    const outcome = await stageParsed(bytes, fileName, company)
    if (!outcome.ok) return outcome.response

    if (!manifest) throw new Error("TALLY_MANIFEST_UNKNOWN")
    const problems = manifestProblems(manifest).map((entry) => `${entry.code}: ${entry.message}`)

    if (outcome.duplicate) {
      return NextResponse.json({
        source: outcome.entry,
        sources,
        duplicate: true,
      })
    }

    const patch: Record<string, unknown> = {
      ai_mapping: {
        ...mapping,
        format: mapping.format ?? extension,
        manifest,
        sources,
        manifestProblems: problems,
      },
      error_message: null,
    }
    // Adding a file invalidates a preview already run over fewer chunks.
    if (session.status === "review") patch.status = "pending"

    const { error: writeError } = await db()
      .from("pharmacy_import_sessions")
      .update(patch)
      .eq("id", id)
      .eq("tenant_id", tenantId)
    if (writeError) throw new Error(`TALLY_SESSION_WRITE_FAILED: ${writeError.message}`)

    return NextResponse.json({
      source: outcome.entry,
      sources,
      manifest: {
        period: manifest.period,
        periodSource: manifest.periodSource,
        problems,
      },
      duplicate: false,
    })
  } catch (error) {
    return tallyErrorResponse(error)
  }
}
