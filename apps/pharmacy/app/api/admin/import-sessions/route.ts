import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { adapterFor } from "@synapse/db"
import Papa from "papaparse"
import * as XLSX from "xlsx"
import {
  assertCsvRowCap,
  assertRowCap,
  checkImportFile,
  importErrorResponse,
  ImportRejected,
  MAX_IMPORT_ROWS,
  neutralizeFormula,
  neutralizeRow,
  parseJsonSafely,
  SAFE_XLSX_READ_OPTS,
} from "@/lib/import-guard"

const FIELD_PATTERNS: Record<string, RegExp[]> = {
  name: [/^name$/i, /drug/i, /medicine/i, /product/i, /item/i, /stock.?item/i],
  generic_name: [/generic/i, /ingredient/i],
  category: [/category/i, /class/i, /^group$/i, /^under$/i],
  sku: [/sku/i, /code/i, /item.?no/i],
  barcode: [/barcode/i, /ean/i],
  quantity: [/qty/i, /quantity/i, /stock/i, /units/i, /closing.?stock/i],
  price: [/selling/i, /sale/i, /retail/i, /^price$/i, /^mrp$/i, /^rate$/i],
  cost_price: [/cost/i, /buying/i, /purchase/i, /wholesale/i],
  strength: [/^strength$/i, /dosage.?strength/i],
  dosage_form: [/dosage.?form/i, /^form$/i, /presentation/i],
  expiry_date: [/exp/i, /expiry/i, /expire/i, /best.?before/i],
  batch_number: [/batch/i, /lot/i],
  manufacturer: [/manufacturer/i, /maker/i, /brand/i],
  unit_of_measure: [/unit/i, /uom/i, /pack/i],
}

function mapHeaders(headers: string[]) {
  return headers.map((header) => {
    const normalized = header.trim()
    let bestField = ""
    let confidence = 0

    for (const [field, patterns] of Object.entries(FIELD_PATTERNS)) {
      const score = patterns.some((pattern) => pattern.test(normalized)) ? 0.9 : 0
      if (score > confidence) {
        bestField = field
        confidence = score
      }
    }

    return {
      source: normalized,
      target: bestField || "unmapped",
      confidence: bestField ? confidence : 0.2,
      status: bestField ? "mapped" : "needs_review",
    }
  })
}

function headersFromRows(rows: Record<string, unknown>[]): string[] {
  if (rows.length === 0) return []
  return Object.keys(rows[0] ?? {})
}

async function parseUpload(file: File): Promise<{
  headers: string[]
  sampleRows: string[][]
  totalRows: number
  discoverySummary: string
}> {
  const fileName = file.name
  // Size, extension, MIME and magic-byte checks happen before any parser runs.
  const { kind, bytes } = await checkImportFile(file, ["csv", "xlsx", "xls", "json"])
  let rows: Record<string, unknown>[] = []

  if (kind === "xlsx" || kind === "xls") {
    const workbook = XLSX.read(bytes, SAFE_XLSX_READ_OPTS)
    const sheetName = workbook.SheetNames[0]
    if (!sheetName) throw new ImportRejected("No sheets found in Excel file", 400)
    const worksheet = workbook.Sheets[sheetName]
    rows = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false }) as Record<string, unknown>[]
  } else if (kind === "json") {
    const value = parseJsonSafely(new TextDecoder().decode(bytes)) as Record<string, unknown> | unknown[]
    const data = Array.isArray(value)
      ? value
      : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).data)
        ? ((value as Record<string, unknown>).data as unknown[])
        : value && typeof value === "object" && Array.isArray((value as Record<string, unknown>).rows)
          ? ((value as Record<string, unknown>).rows as unknown[])
          : []
    rows = data.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r))
  } else {
    const text = new TextDecoder().decode(bytes)
    assertCsvRowCap(text)
    const results = Papa.parse<Record<string, unknown>>(text, {
      header: true,
      skipEmptyLines: true,
    })
    rows = results.data
  }
  assertRowCap(rows.length)
  rows = rows.map((row) => neutralizeRow(row))

  const headers = headersFromRows(rows)
  const sampleRows = rows.map((row) => headers.map((h) => String(row[h] ?? "")))

  let discoverySummary = `Detected ${rows.length} data row(s) and ${headers.length} column(s).`
  try {
    const discovery = adapterFor(fileName, file.type).analyse(bytes, fileName, file.type)
    const warningText = discovery.warnings.length ? ` Warnings: ${discovery.warnings.join(", ")}.` : ""
    discoverySummary = `Format ${discovery.format}${discovery.company ? ` · ${discovery.company}` : ""} · ${
      discovery.counts.rows ?? rows.length
    } rows.${warningText}`
  } catch {
    // Keep spreadsheet discovery summary when adapter rejects (e.g. xlsx-only path).
  }

  return { headers, sampleRows, totalRows: rows.length, discoverySummary }
}

export async function GET() {
  try {
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const { data, error } = await (supabaseAdmin as any)
      .from("pharmacy_import_sessions")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(20)

    if (error) throw error
    return NextResponse.json(data ?? [])
  } catch (error) {
    console.error("Import sessions GET error:", error)
    return NextResponse.json({ error: "Failed to fetch import sessions" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const contentType = request.headers.get("content-type") ?? ""
    let sourceSystem = "Unknown"
    let fileName = "Manual mapping session"
    let headers: string[] = []
    let sampleRows: string[][] = []
    let totalRows = 0
    let discoverySummary = ""

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData()
      const file = form.get("file")
      sourceSystem = String(form.get("sourceSystem") ?? "Tally")
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "File is required" }, { status: 400 })
      }
      fileName = file.name
      const parsed = await parseUpload(file)
      headers = parsed.headers
      sampleRows = parsed.sampleRows
      totalRows = parsed.totalRows
      discoverySummary = parsed.discoverySummary
    } else {
      const body = await request.json()
      sourceSystem = body.sourceSystem || "Unknown"
      fileName = body.fileName || "Manual mapping session"
      headers = Array.isArray(body.headers) ? body.headers.slice(0, 200).map((h: unknown) => neutralizeFormula(String(h))).filter(Boolean) : []
      sampleRows = Array.isArray(body.sampleRows)
        ? body.sampleRows.slice(0, 20).map((r: unknown) => (Array.isArray(r) ? r.slice(0, 200).map((c) => neutralizeFormula(String(c ?? ""))) : []))
        : []
      totalRows = Math.min(Math.max(0, Number(body.totalRows ?? sampleRows.length) || 0), MAX_IMPORT_ROWS)
    }

    if (headers.length === 0) {
      return NextResponse.json({ error: "At least one header is required" }, { status: 400 })
    }

    const mapping = mapHeaders(headers)
    const flaggedRows = mapping.filter((item) => item.status === "needs_review").length
    const matchedRows = mapping.length - flaggedRows
    const summary =
      flaggedRows === 0
        ? "All supplied columns were mapped with high confidence."
        : `${flaggedRows} column${flaggedRows === 1 ? "" : "s"} need review before import.`

    const { data, error } = await supabaseAdmin
      .from("pharmacy_import_sessions")
      .insert({
        tenant_id: tenantId,
        source_system: sourceSystem,
        file_name: fileName,
        status: "review",
        total_rows: totalRows,
        matched_rows: matchedRows,
        flagged_rows: flaggedRows,
        duplicate_rows: 0,
        ai_mapping: { mapping, sampleRows, engine: "heuristic_mapper_v1", discoverySummary },
        ai_summary: summary,
        created_by: session.user.id,
      })
      .select()
      .single()

    if (error) throw error

    return NextResponse.json(
      { session: data, mapping, summary, headers, discoverySummary, sampleRows },
      { status: 201 },
    )
  } catch (error) {
    const rejected = importErrorResponse(error)
    if (rejected) return NextResponse.json(rejected.body, { status: rejected.status })
    console.error("Import sessions POST error:", error)
    // Never echo raw parser / database errors to the client.
    return NextResponse.json({ error: "Failed to analyse import file" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const body = await request.json().catch(() => ({}))
    const status = typeof body.status === "string" ? body.status : "applied"
    const fileName = typeof body.fileName === "string" ? body.fileName : null
    const summary =
      body.importedCount != null ? `Applied: ${body.importedCount} row(s) imported.` : undefined

    const { data: latest } = await (supabaseAdmin as any)
      .from("pharmacy_import_sessions")
      .select("id")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    // Prefer matching file name when provided
    let sessionId = latest?.id as string | undefined
    if (fileName) {
      const { data: byName } = await (supabaseAdmin as any)
        .from("pharmacy_import_sessions")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("file_name", fileName)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (byName?.id) sessionId = byName.id
    }

    if (!sessionId) return NextResponse.json({ success: true, updated: false })

    const { error } = await (supabaseAdmin as any)
      .from("pharmacy_import_sessions")
      .update({ status, ...(summary ? { ai_summary: summary } : {}) })
      .eq("id", sessionId)
      .eq("tenant_id", tenantId)

    if (error) throw error
    return NextResponse.json({ success: true, updated: true })
  } catch (error) {
    console.error("Import sessions PATCH error:", error)
    return NextResponse.json({ error: "Failed to update import session" }, { status: 500 })
  }
}
