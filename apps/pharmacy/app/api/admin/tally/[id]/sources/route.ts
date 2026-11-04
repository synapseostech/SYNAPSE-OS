import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCompletedCutover } from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import {
  readTallySource,
  tallyChunkSourcePath,
  tallyStagedSourcePath,
  writeTallySourceBytes,
  type TallySourceExtension,
  type TallyStorageClient,
} from "@/lib/tally/storage"
import { readTallyDocument } from "@/lib/tally/source"
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
}

type MappingState = {
  format?: "xml" | "xlsx" | "xls" | "csv"
  path?: string
  mode?: "opening" | "closing"
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

  if (await findCompletedCutover(tenantId)) {
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
  // as a session's only file, through preview's single-file path.
  if (extension !== "xml") {
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
        {
          error: "period must be an object with from and to dates",
          code: "TALLY_PERIOD_BODY_INVALID",
        },
        { status: 400 },
      )
    }
    requestedPeriod = { from: candidate.from, to: candidate.to }
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

  try {
    const bytes = await readTallySource(storage(), stagedPath)
    const { document } = readTallyDocument(bytes, fileName)
    const described = describeStagedDocument(document, { requestedPeriod, kind })
    if (!described.ok) {
      return NextResponse.json(
        { error: described.message, code: described.code },
        { status: 422 },
      )
    }

    const existing = isManifestLike(mapping.manifest) ? mapping.manifest : undefined
    if (existing && existing.company.trim() !== described.company) {
      return NextResponse.json(
        {
          error: `This file belongs to "${described.company}", but the cut-over is for "${existing.company}".`,
          code: "TALLY_COMPANY_MISMATCH",
        },
        { status: 422 },
      )
    }

    let manifest: TallyMigrationManifest =
      existing ??
      createOpenManifest({
        sessionId: id,
        company: described.company,
        mode: mapping.mode ?? "opening",
        period: described.range,
        periodSource: described.periodSource,
        ...(described.declaredPeriod ? { declaredPeriod: described.declaredPeriod } : {}),
        updatedAt: now,
      })

    manifest = widenPeriod(manifest, described.range, now)
    manifest = ensureChunk(
      manifest,
      { kind: described.kind, id: described.chunkId, range: described.range },
      now,
    )

    const target = manifest.chunks.find((chunk) => chunk.id === described.chunkId)
    if (!target) throw new Error("TALLY_CHUNK_UNKNOWN")

    const checksum = await checksumOf(bytes)
    const result = {
      status: "complete" as const,
      recordsRead: described.recordsRead,
      checksum,
      bytes: bytes.byteLength,
      ...(described.firstDate ? { firstDate: described.firstDate } : {}),
      ...(described.lastDate ? { lastDate: described.lastDate } : {}),
    }

    if (target.status === "complete" && !replace) {
      // The same bytes are an idempotent retry; different bytes are a corrected
      // slice, which the operator has to confirm before it replaces what is
      // already staged.
      if (target.checksum === checksum) {
        const existingSources = readStagedSources(mapping.sources)
        return NextResponse.json({
          source: existingSources.find((entry) => entry.chunkId === described.chunkId),
          sources: existingSources,
          duplicate: true,
        })
      }
      return NextResponse.json(
        {
          error: `A file is already staged for ${described.range.from} to ${described.range.to}. Add it again with replace to use this one instead.`,
          code: "TALLY_CHUNK_ALREADY_STAGED",
          chunkId: described.chunkId,
        },
        { status: 409 },
      )
    }

    manifest = replace
      ? replaceChunkResult(manifest, described.chunkId, result, now)
      : recordChunkResult(manifest, described.chunkId, result, now)

    await writeTallySourceBytes(
      storage(),
      tallyChunkSourcePath(tenantId, id, described.chunkId),
      bytes,
    )

    const entry: TallyStagedSource = {
      uploadId,
      fileName,
      kind: described.kind,
      chunkId: described.chunkId,
      range: described.range,
      recordsRead: described.recordsRead,
      bytes: bytes.byteLength,
      stagedAt: now,
    }
    const sources = [
      ...readStagedSources(mapping.sources).filter(
        (staged) => staged.uploadId !== uploadId && staged.chunkId !== described.chunkId,
      ),
      entry,
    ]

    const problems = manifestProblems(manifest).map((entry) => `${entry.code}: ${entry.message}`)

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
      source: entry,
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
