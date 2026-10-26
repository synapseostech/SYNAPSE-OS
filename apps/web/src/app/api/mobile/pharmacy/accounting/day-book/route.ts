import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  DAY_BOOK_KINDS,
  VOUCHER_KIND_LABELS,
  dayBookKindFilter,
  isDayBookKind,
  voucherKindFromSource,
  type DayBookKind,
} from '@synapse/db/accounting-voucher-types'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PAGE_SIZE_DEFAULT = 25
const PAGE_SIZE_MAX = 100

type LineRow = {
  id: string
  debit: number | string | null
  credit: number | string | null
  description: string | null
  account: { id: string; code: string | null; name: string | null } | null
}

type EntryRow = {
  id: string
  entry_no: string | null
  entry_date: string | null
  source_type: string | null
  source_id: string | null
  description: string | null
  currency: string | null
  total_debit: number | string | null
  total_credit: number | string | null
  lines: LineRow[] | null
}

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Day book for the pharmacy app: every entry in the range, newest first, with
 * each side of the posting. The voucher-kind filter is shared with the portal
 * so both surfaces classify and filter a posting the same way.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json({ error: 'The day book requires a financial reports permission' }, { status: 403 })
  }

  const params = new URL(req.url).searchParams
  const today = new Date().toISOString().slice(0, 10)
  const from = params.get('from') ?? `${today.slice(0, 4)}-01-01`
  const to = params.get('to') ?? today
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    return NextResponse.json(
      { error: 'Use valid dates in YYYY-MM-DD format, with from no later than to.' },
      { status: 400 },
    )
  }

  const rawKind = params.get('voucherType')
  if (rawKind && rawKind !== 'all' && !isDayBookKind(rawKind)) {
    return NextResponse.json({ error: 'Unknown voucher type.' }, { status: 400 })
  }
  const kind: DayBookKind | null =
    rawKind && rawKind !== 'all' && isDayBookKind(rawKind) ? rawKind : null

  const accountId = params.get('accountId')?.trim() || null
  if (accountId && !UUID_RE.test(accountId)) {
    return NextResponse.json({ error: 'Use a valid account id.' }, { status: 400 })
  }

  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)
  const pageSize = Math.min(
    PAGE_SIZE_MAX,
    Math.max(
      1,
      Number.parseInt(params.get('pageSize') ?? String(PAGE_SIZE_DEFAULT), 10) || PAGE_SIZE_DEFAULT,
    ),
  )

  try {
    let entryIds: string[] | null = null
    if (accountId) {
      const { data: lineRows, error: lineError } = await db()
        .from('pharmacy_accounting_journal_lines')
        .select('journal_entry_id')
        .eq('tenant_id', auth.tenantId)
        .eq('account_id', accountId)
        .limit(10_000)
      if (lineError) throw lineError
      entryIds = [
        ...new Set(
          ((lineRows ?? []) as Array<{ journal_entry_id: string }>).map(
            (row) => row.journal_entry_id,
          ),
        ),
      ]
      if (entryIds.length === 0) {
        return NextResponse.json({
          from,
          to,
          page,
          pageSize,
          total: 0,
          entries: [],
          kinds: [...DAY_BOOK_KINDS],
        })
      }
    }

    let query = db()
      .from('pharmacy_accounting_journal_entries')
      .select(
        `
          id, entry_no, entry_date, source_type, source_id, description, currency, total_debit, total_credit,
          lines:pharmacy_accounting_journal_lines(
            id, debit, credit, description,
            account:pharmacy_accounting_accounts(id, code, name)
          )
        `,
        { count: 'exact' },
      )
      .eq('tenant_id', auth.tenantId)
      .gte('entry_date', from)
      .lte('entry_date', to)
      .order('entry_date', { ascending: false })
      .order('created_at', { ascending: false })

    if (kind) query = query.or(dayBookKindFilter(kind))
    if (entryIds) query = query.in('id', entryIds)

    const offset = (page - 1) * pageSize
    const { data, error, count } = await query.range(offset, offset + pageSize - 1)
    if (error) throw error

    const entries = ((data ?? []) as EntryRow[]).map((entry) => {
      const entryKind = voucherKindFromSource(String(entry.source_type), String(entry.source_id ?? ''))
      return {
        id: String(entry.id),
        entryNo: entry.entry_no ?? '',
        date: entry.entry_date ?? '',
        sourceType: entry.source_type ?? '',
        voucherType: entryKind,
        voucherLabel: VOUCHER_KIND_LABELS[entryKind],
        description: entry.description ?? '',
        currency: entry.currency ?? '',
        totalDebit: Number(entry.total_debit ?? 0),
        totalCredit: Number(entry.total_credit ?? 0),
        lines: (entry.lines ?? []).map((line) => ({
          id: String(line.id),
          accountId: line.account?.id ?? null,
          accountCode: line.account?.code ?? '',
          accountName: line.account?.name ?? '',
          debit: Number(line.debit ?? 0),
          credit: Number(line.credit ?? 0),
          description: line.description ?? '',
        })),
      }
    })

    return NextResponse.json({
      from,
      to,
      page,
      pageSize,
      total: count ?? entries.length,
      entries,
      kinds: [...DAY_BOOK_KINDS],
    })
  } catch (error) {
    console.error('[mobile/pharmacy/accounting/day-book]', error)
    return NextResponse.json({ error: 'Failed to load the day book' }, { status: 500 })
  }
}
