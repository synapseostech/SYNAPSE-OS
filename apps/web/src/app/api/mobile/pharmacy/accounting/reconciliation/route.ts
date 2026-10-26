import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  exactBankCandidates,
  mapBankStatementRecords,
} from '@synapse/db/accounting-bank-statement'
import { parseCsv } from '../../../../../../lib/import/csv'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE = 300
const MAX_PAGE = 100_000
const MAX_CSV_CHARS = 1_000_000
const MAX_ROWS = 5_000

type ImportRow = {
  id: string
  file_name: string | null
  currency: string | null
  imported_at: string | null
}

type LineRow = {
  id: string
  import_id: string | null
  line_number: number | null
  statement_date: string | null
  description: string | null
  reference: string | null
  currency: string
  amount: number | string
  matched_journal_line_id: string | null
  matched_at: string | null
  import: { file_name: string | null } | null
}

type CandidateRow = {
  journal_line_id: string
  journal_entry_id: string
  entry_no: string | null
  entry_date: string | null
  description: string | null
  currency: string
  amount: number | string
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

function errorResponse(error: unknown, fallback: string) {
  const message = String((error as { message?: unknown } | null)?.message ?? '')
  if (message.includes('BANK_MATCH_AMOUNT_MISMATCH')) {
    return NextResponse.json(
      { error: "The selected bank entry does not match this statement line's amount or currency." },
      { status: 400 },
    )
  }
  if (
    message.includes('BANK_STATEMENT_LINE_NOT_FOUND') ||
    message.includes('BANK_JOURNAL_LINE_NOT_FOUND')
  ) {
    return NextResponse.json({ error: 'The statement or journal line was not found.' }, { status: 404 })
  }
  if (message.includes('BANK_STATEMENT_LINE_ALREADY_MATCHED') || message.includes('duplicate key')) {
    return NextResponse.json(
      { error: 'This statement line or journal line has already been matched.' },
      { status: 409 },
    )
  }
  if (message.includes('BANK_IMPORT_')) {
    if (message.includes('BANK_IMPORT_IDEMPOTENCY_CONFLICT')) {
      return NextResponse.json(
        { error: 'This idempotency key was already used for a different bank statement.' },
        { status: 409 },
      )
    }
    return NextResponse.json(
      { error: 'The statement contains invalid or inconsistent rows.' },
      { status: 400 },
    )
  }
  console.error('[mobile/pharmacy/accounting/reconciliation]', error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}

/**
 * Bank statement lines and the bank journal entries that can settle them.
 * Each line carries only the exact amount-and-currency candidates the server
 * would accept, so the app never offers a match that would be refused.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json(
      { error: 'Bank reconciliation requires a financial reports permission' },
      { status: 403 },
    )
  }

  const pageText = new URL(req.url).searchParams.get('page') ?? '1'
  const page = /^\d+$/.test(pageText) ? Number(pageText) : 0
  if (!Number.isInteger(page) || page < 1 || page > MAX_PAGE) {
    return NextResponse.json({ error: 'Page must be a positive integer.' }, { status: 400 })
  }

  try {
    const [importsResult, linesResult, candidatesResult] = await Promise.all([
      db()
        .from('pharmacy_bank_statement_imports')
        .select('id, file_name, currency, imported_at')
        .eq('tenant_id', auth.tenantId)
        .order('imported_at', { ascending: false })
        .limit(30),
      db()
        .from('pharmacy_bank_statement_lines')
        .select(
          `
            id, import_id, line_number, statement_date, description, reference, currency, amount,
            matched_journal_line_id, matched_at,
            import:pharmacy_bank_statement_imports!pharmacy_bank_statement_lines_import_id_fkey(file_name)
          `,
          { count: 'exact' },
        )
        .eq('tenant_id', auth.tenantId)
        .order('statement_date', { ascending: false })
        .order('line_number', { ascending: false })
        .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
      db().rpc('pharmacy_accounting_bank_match_candidates', { p_tenant_id: auth.tenantId }),
    ])
    for (const result of [importsResult, linesResult, candidatesResult]) {
      if (result.error) throw result.error
    }

    const candidates = (candidatesResult.data ?? []) as CandidateRow[]
    const lineRows = (linesResult.data ?? []) as LineRow[]

    const lines = lineRows.map((line) => {
      const amount = money(line.amount)
      return {
        id: String(line.id),
        importId: line.import_id ?? null,
        fileName: line.import?.file_name ?? '',
        lineNumber: Number(line.line_number ?? 0),
        date: line.statement_date ?? '',
        description: line.description ?? '',
        reference: line.reference ?? null,
        currency: line.currency,
        amount,
        matched: Boolean(line.matched_journal_line_id),
        matchedJournalLineId: line.matched_journal_line_id ?? null,
        matchedAt: line.matched_at ?? null,
        candidates: line.matched_journal_line_id
          ? []
          : exactBankCandidates({ currency: line.currency, amount }, candidates).map((candidate) => ({
              journalLineId: String(candidate.journal_line_id),
              journalEntryId: String(candidate.journal_entry_id),
              entryNo: candidate.entry_no ?? '',
              entryDate: candidate.entry_date ?? '',
              description: candidate.description ?? '',
              currency: candidate.currency,
              amount: money(candidate.amount),
            })),
      }
    })

    return NextResponse.json({
      page,
      pageSize: PAGE_SIZE,
      totalLines: linesResult.count ?? lines.length,
      matchedOnPage: lines.filter((line) => line.matched).length,
      unmatchedOnPage: lines.filter((line) => !line.matched).length,
      imports: ((importsResult.data ?? []) as ImportRow[]).map((row) => ({
        id: String(row.id),
        fileName: row.file_name ?? '',
        currency: row.currency ?? '',
        importedAt: row.imported_at ?? '',
      })),
      lines,
    })
  } catch (error) {
    return errorResponse(error, 'Failed to load bank reconciliation records.')
  }
}

/**
 * Import a bank statement from CSV text the user pasted. The portal reads the
 * file in the browser; here the server reads the same text with the workspace
 * CSV reader and the shared column mapping decides what every row means.
 */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json(
      { error: 'Bank reconciliation requires a financial reports permission' },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'A bank statement is required.' }, { status: 400 })
  }

  const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
  const currency = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : ''
  const csv = typeof body.csv === 'string' ? body.csv : ''
  const idempotencyKey =
    req.headers.get('idempotency-key')?.trim() ||
    (typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '')

  if (!fileName || fileName.length > 255 || !/^[A-Z]{3}$/.test(currency)) {
    return NextResponse.json(
      { error: 'A file name and valid three-letter currency are required.' },
      { status: 400 },
    )
  }
  if (!idempotencyKey || idempotencyKey.length > 128) {
    return NextResponse.json({ error: 'A valid idempotency key is required.' }, { status: 400 })
  }
  if (!csv.trim()) {
    return NextResponse.json({ error: 'Paste the statement CSV before importing.' }, { status: 400 })
  }
  if (csv.length > MAX_CSV_CHARS) {
    return NextResponse.json(
      { error: 'Bank statement CSV files must be 1 MB or smaller.' },
      { status: 400 },
    )
  }

  let rows
  try {
    const parsed = parseCsv(csv)
    const malformed = parsed.malformed[0]
    if (malformed) {
      throw new Error(`CSV row ${malformed.line} has the wrong number of columns.`)
    }
    rows = mapBankStatementRecords(
      parsed.header,
      parsed.rows.map((row) => ({ lineNumber: row.line, values: row.values })),
      currency,
    )
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Could not read the statement CSV.' },
      { status: 400 },
    )
  }

  if (rows.length < 1 || rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: 'Import between 1 and 5,000 statement rows at a time.' },
      { status: 400 },
    )
  }
  if (rows.some((row) => row.currency !== currency)) {
    return NextResponse.json(
      { error: `Every statement row must use ${currency}; a row names another currency.` },
      { status: 400 },
    )
  }

  try {
    const { data, error } = await db().rpc('import_pharmacy_bank_statement', {
      p_tenant_id: auth.tenantId,
      p_file_name: fileName,
      p_currency: currency,
      p_imported_by: auth.userId,
      p_idempotency_key: idempotencyKey,
      p_rows: rows,
    })
    if (error) throw error
    return NextResponse.json(
      { ok: true, importId: data?.id ?? null, replayed: Boolean(data?.replayed), rowCount: rows.length },
      { status: data?.replayed ? 200 : 201 },
    )
  } catch (error) {
    return errorResponse(error, 'Failed to import the bank statement.')
  }
}

/** Link one statement line to the bank journal line that settled it. */
export async function PATCH(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json(
      { error: 'Bank reconciliation requires a financial reports permission' },
      { status: 403 },
    )
  }

  const body = await req.json().catch(() => null)
  const statementLineId = typeof body?.statementLineId === 'string' ? body.statementLineId : ''
  const journalLineId = typeof body?.journalLineId === 'string' ? body.journalLineId : ''
  if (!UUID_RE.test(statementLineId) || !UUID_RE.test(journalLineId)) {
    return NextResponse.json(
      { error: 'Select a valid statement line and bank journal line.' },
      { status: 400 },
    )
  }

  try {
    const { data, error } = await db().rpc('match_pharmacy_bank_statement_line', {
      p_tenant_id: auth.tenantId,
      p_statement_line_id: statementLineId,
      p_journal_line_id: journalLineId,
      p_matched_by: auth.userId,
    })
    if (error) throw error
    return NextResponse.json(
      { ok: true, match: data },
      { status: data?.replayed ? 200 : 201 },
    )
  } catch (error) {
    return errorResponse(error, 'Failed to match bank statement line.')
  }
}
