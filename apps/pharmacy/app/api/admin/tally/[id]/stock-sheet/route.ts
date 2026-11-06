import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCompletedCutover } from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { isManifestLike } from "@/lib/tally/chunks"
import { readStoredDocument } from "@/lib/tally/consolidate-session"
import { buildTallyStockSheet, readTallyStockSheet } from "@/lib/tally/stock-sheet"
import {
  readTallySource,
  tallyStagedSourcePath,
  tallyStockSheetPath,
  writeTallySourceBytes,
  TALLY_BUCKET,
  type TallySourceExtension,
  type TallyStorageClient,
} from "@/lib/tally/storage"
import { tallyErrorResponse } from "@/lib/tally/http"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

const SHEET_EXTENSIONS: Record<string, TallySourceExtension> = { xlsx: "xlsx", xls: "xls" }
const SHEET_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

type MappingState = {
  mode?: "opening" | "closing"
  manifest?: unknown
  stockSheet?: { path?: string; fileName?: string; rows?: number; stagedAt?: string }
}

/**
 * GET /api/admin/tally/[id]/stock-sheet
 * Downloads the stock sheet for this cut-over, pre-filled from the staged
 * masters: every item that opens with stock, and the quantity it opens with.
 * The operator adds the batch and expiry columns.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (session.ai_mapping ?? {}) as MappingState
  const manifest = isManifestLike(mapping.manifest) ? mapping.manifest : undefined
  if (!manifest || !manifest.chunks.some((chunk) => chunk.kind === "masters")) {
    return NextResponse.json(
      {
        error: "Add the masters file first — the stock sheet lists the items it holds.",
        code: "TALLY_STOCK_SHEET_NO_MASTERS",
      },
      { status: 409 },
    )
  }

  try {
    const consolidation = await readStoredDocument(storage(), {
      tenantId,
      sessionId: id,
      manifest,
    })
    const workbook = buildTallyStockSheet(consolidation.document, mapping.mode ?? manifest.mode)
    return new NextResponse(new Uint8Array(workbook), {
      headers: {
        "Content-Type": SHEET_MIME,
        "Content-Disposition": 'attachment; filename="tally-stock-sheet.xlsx"',
        "Cache-Control": "no-store",
      },
    })
  } catch (sheetError) {
    return tallyErrorResponse(sheetError, "The stock sheet could not be built.")
  }
}

/**
 * POST /api/admin/tally/[id]/stock-sheet
 * Adopts the sheet the operator filled and uploaded to a staging path. Its
 * rows are merged into the masters at preview; they never count as a chunk.
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

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "This import has already been applied and cannot take more files." },
      { status: 409 },
    )
  }

  let body: { uploadId?: unknown; fileName?: unknown } = {}
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
  const extension = SHEET_EXTENSIONS[fileName.toLowerCase().split(".").pop() ?? ""]
  if (!extension) {
    return NextResponse.json(
      { error: "The stock sheet must be the .xlsx file you downloaded and filled." },
      { status: 415 },
    )
  }

  const mapping = (session.ai_mapping ?? {}) as MappingState
  const now = new Date().toISOString()

  try {
    const stagedPath = tallyStagedSourcePath(tenantId, id, uploadId, extension)
    const bytes = await readTallySource(storage(), stagedPath)
    const sheet = readTallyStockSheet(bytes)

    const path = tallyStockSheetPath(tenantId, id)
    await writeTallySourceBytes(storage(), path, bytes, SHEET_MIME)

    const stockSheet = { path, fileName, rows: sheet.rows.length, stagedAt: now }
    const patch: Record<string, unknown> = {
      ai_mapping: { ...mapping, stockSheet },
      error_message: null,
    }
    // A sheet changes what preview would produce, so an existing review is
    // stale until it is read again.
    if (session.status === "review") patch.status = "pending"

    const { error: writeError } = await db()
      .from("pharmacy_import_sessions")
      .update(patch)
      .eq("id", id)
      .eq("tenant_id", tenantId)
    if (writeError) throw new Error(`TALLY_SESSION_WRITE_FAILED: ${writeError.message}`)

    return NextResponse.json({ stockSheet, problems: sheet.problems, problemsOmitted: sheet.problemsOmitted })
  } catch (sheetError) {
    return tallyErrorResponse(sheetError, "The stock sheet could not be read.")
  }
}

/** DELETE /api/admin/tally/[id]/stock-sheet — detaches the sheet from the cut-over. */
export async function DELETE(
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

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "This import has already been applied." },
      { status: 409 },
    )
  }

  const mapping = (session.ai_mapping ?? {}) as MappingState
  const path = mapping.stockSheet?.path
  if (path) {
    // A missing object is already the state the operator asked for.
    await db().storage.from(TALLY_BUCKET).remove([path])
  }
  const rest: MappingState = { ...mapping }
  delete rest.stockSheet
  const patch: Record<string, unknown> = { ai_mapping: rest }
  if (session.status === "review") patch.status = "pending"

  const { error: writeError } = await db()
    .from("pharmacy_import_sessions")
    .update(patch)
    .eq("id", id)
    .eq("tenant_id", tenantId)
  if (writeError) {
    return NextResponse.json(
      { error: "The stock sheet could not be detached." },
      { status: 500 },
    )
  }

  return NextResponse.json({ removed: true })
}
