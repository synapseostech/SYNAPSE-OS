import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function errorResponse(error: unknown, fallback: string) {
  const message = String((error as { message?: unknown } | null)?.message ?? "")
  if (message.includes("BANK_MATCH_AMOUNT_MISMATCH")) {
    return NextResponse.json({ error: "The selected bank entry does not match this statement line's amount or currency." }, { status: 400 })
  }
  if (message.includes("BANK_STATEMENT_LINE_NOT_FOUND") || message.includes("BANK_JOURNAL_LINE_NOT_FOUND")) {
    return NextResponse.json({ error: "The statement or journal line was not found." }, { status: 404 })
  }
  if (message.includes("BANK_STATEMENT_LINE_ALREADY_MATCHED") || message.includes("duplicate key")) {
    return NextResponse.json({ error: "This statement line or journal line has already been matched." }, { status: 409 })
  }
  if (message.includes("BANK_IMPORT_")) {
    if (message.includes("BANK_IMPORT_IDEMPOTENCY_CONFLICT")) {
      return NextResponse.json({ error: "This idempotency key was already used for a different bank statement." }, { status: 409 })
    }
    return NextResponse.json({ error: "The statement contains invalid or inconsistent rows." }, { status: 400 })
  }
  console.error("Pharmacy bank reconciliation error:", error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response
    const pageText = request.nextUrl.searchParams.get("page") ?? "1"
    const page = /^\d+$/.test(pageText) ? Number(pageText) : 0
    if (!Number.isInteger(page) || page < 1 || page > 100000) {
      return NextResponse.json({ error: "Page must be a positive integer." }, { status: 400 })
    }
    const pageSize = 300
    const db = supabaseAdmin as any
    const { error: seedError } = await db.rpc("seed_pharmacy_accounting_accounts", {
      p_tenant_id: auth.tenantId,
    })
    if (seedError) throw seedError

    const [importsResult, linesResult, candidatesResult] = await Promise.all([
      db
        .from("pharmacy_bank_statement_imports")
        .select("id, file_name, currency, imported_at")
        .eq("tenant_id", auth.tenantId)
        .order("imported_at", { ascending: false })
        .limit(30),
      db
        .from("pharmacy_bank_statement_lines")
        .select(`
          id, import_id, line_number, statement_date, description, reference, currency, amount,
          matched_journal_line_id, matched_at,
          import:pharmacy_bank_statement_imports!pharmacy_bank_statement_lines_import_id_fkey(file_name)
        `, { count: "exact" })
        .eq("tenant_id", auth.tenantId)
        .order("statement_date", { ascending: false })
        .order("line_number", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1),
      db.rpc("pharmacy_accounting_bank_match_candidates", { p_tenant_id: auth.tenantId }),
    ])
    for (const result of [importsResult, linesResult, candidatesResult]) {
      if (result.error) throw result.error
    }
    return NextResponse.json({
      imports: importsResult.data ?? [],
      lines: linesResult.data ?? [],
      totalLines: linesResult.count ?? 0,
      page,
      candidates: candidatesResult.data ?? [],
    })
  } catch (error) {
    return errorResponse(error, "Failed to load bank reconciliation records.")
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "A parsed bank statement is required." }, { status: 400 })
    }

    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : ""
    const currency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : ""
    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() ||
      (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "")
    const rows = Array.isArray(body.rows) ? body.rows : []
    if (!fileName || fileName.length > 255 || !/^[A-Z]{3}$/.test(currency)) {
      return NextResponse.json({ error: "A file name and valid three-letter currency are required." }, { status: 400 })
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return NextResponse.json({ error: "A valid idempotency key is required." }, { status: 400 })
    }
    if (rows.length < 1 || rows.length > 5000) {
      return NextResponse.json({ error: "Import between 1 and 5,000 statement rows at a time." }, { status: 400 })
    }
    if (rows.some((row: unknown) => !row || typeof row !== "object" || Array.isArray(row))) {
      return NextResponse.json({ error: "Statement rows must be structured objects." }, { status: 400 })
    }
    const normalizedRows = rows.map((row: Record<string, unknown>) => ({
      lineNumber: Number(row.lineNumber),
      date: typeof row.date === "string" ? row.date : "",
      description: typeof row.description === "string" ? row.description.trim() : "",
      reference: typeof row.reference === "string" ? row.reference.trim() : null,
      amount: Number(row.amount),
      currency: typeof row.currency === "string" ? row.currency.trim().toUpperCase() : currency,
    }))
    if (normalizedRows.some((row: {
      lineNumber: number
      date: string
      description: string
      amount: number
      currency: string
    }) =>
      !Number.isInteger(row.lineNumber) || row.lineNumber < 1 || !isIsoDate(row.date) ||
      !row.description || row.description.length > 500 ||
      !Number.isFinite(row.amount) || row.amount === 0 ||
      Math.abs(row.amount * 100 - Math.round(row.amount * 100)) > 0.000001 ||
      row.currency !== currency
    )) {
      return NextResponse.json({ error: "Statement rows need valid dates, descriptions, non-zero amounts and one currency." }, { status: 400 })
    }

    const { data, error } = await (supabaseAdmin as any).rpc("import_pharmacy_bank_statement", {
      p_tenant_id: auth.tenantId,
      p_file_name: fileName,
      p_currency: currency,
      p_imported_by: auth.session.user.id,
      p_idempotency_key: idempotencyKey,
      p_rows: normalizedRows,
    })
    if (error) throw error
    return NextResponse.json({ ok: true, import: data }, { status: data?.replayed ? 200 : 201 })
  } catch (error) {
    return errorResponse(error, "Failed to import the bank statement.")
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response
    const body = await request.json().catch(() => null)
    const statementLineId = typeof body?.statementLineId === "string" ? body.statementLineId : ""
    const journalLineId = typeof body?.journalLineId === "string" ? body.journalLineId : ""
    if (!UUID_RE.test(statementLineId) || !UUID_RE.test(journalLineId)) {
      return NextResponse.json({ error: "Select a valid statement line and bank journal line." }, { status: 400 })
    }

    const { data, error } = await (supabaseAdmin as any).rpc("match_pharmacy_bank_statement_line", {
      p_tenant_id: auth.tenantId,
      p_statement_line_id: statementLineId,
      p_journal_line_id: journalLineId,
      p_matched_by: auth.session.user.id,
    })
    if (error) throw error
    return NextResponse.json({ ok: true, match: data }, { status: data?.replayed ? 200 : 201 })
  } catch (error) {
    return errorResponse(error, "Failed to match bank statement line.")
  }
}
