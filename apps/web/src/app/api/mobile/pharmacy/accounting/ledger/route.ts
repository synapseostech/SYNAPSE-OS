import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
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
const MAX_LINES = 500

type BalanceRow = {
  currency: string | null
  account_id: string
  balance: number | string | null
}

type LedgerLineRow = {
  id: string
  debit: number | string | null
  credit: number | string | null
  description: string | null
  entry: {
    id: string
    entry_no: string | null
    entry_date: string | null
    source_type: string | null
    source_id: string | null
    description: string | null
    currency: string | null
  } | null
}

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function previousDay(isoDate: string): string {
  const parsed = new Date(`${isoDate}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() - 1)
  return parsed.toISOString().slice(0, 10)
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

/**
 * General ledger for one account: opening balance through the day before the
 * range, every posting inside it, and the running balance on the account's
 * normal side. Same computation as the portal's ledger tab.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json({ error: 'The ledger requires a financial reports permission' }, { status: 403 })
  }

  const params = new URL(req.url).searchParams
  const accountId = params.get('accountId')?.trim() ?? ''
  if (!UUID_RE.test(accountId)) {
    return NextResponse.json({ error: 'Choose an account to open its ledger.' }, { status: 400 })
  }

  const today = new Date().toISOString().slice(0, 10)
  const from = params.get('from') ?? `${today.slice(0, 4)}-01-01`
  const to = params.get('to') ?? today
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
    return NextResponse.json(
      { error: 'Use valid dates in YYYY-MM-DD format, with from no later than to.' },
      { status: 400 },
    )
  }

  try {
    const [{ data: account, error: accountError }, { data: settings, error: settingsError }] =
      await Promise.all([
        db()
          .from('pharmacy_accounting_accounts')
          .select('id, code, name, account_type, normal_balance')
          .eq('tenant_id', auth.tenantId)
          .eq('id', accountId)
          .maybeSingle(),
        db().from('pharmacy_settings').select('currency').eq('tenant_id', auth.tenantId).maybeSingle(),
      ])
    if (accountError) throw accountError
    if (settingsError) throw settingsError
    if (!account) {
      return NextResponse.json(
        { error: "That account is not in this pharmacy's chart of accounts." },
        { status: 404 },
      )
    }

    const [openingResult, closingResult, linesResult] = await Promise.all([
      db().rpc('pharmacy_accounting_trial_balance', {
        p_tenant_id: auth.tenantId,
        p_from: null,
        p_to: previousDay(from),
      }),
      db().rpc('pharmacy_accounting_trial_balance', {
        p_tenant_id: auth.tenantId,
        p_from: null,
        p_to: to,
      }),
      db()
        .from('pharmacy_accounting_journal_lines')
        .select(
          `
            id, debit, credit, description,
            entry:pharmacy_accounting_journal_entries!inner(
              id, entry_no, entry_date, source_type, source_id, description, currency
            )
          `,
        )
        .eq('tenant_id', auth.tenantId)
        .eq('account_id', accountId)
        .gte('entry.entry_date', from)
        .lte('entry.entry_date', to)
        .order('entry_date', { ascending: true, referencedTable: 'pharmacy_accounting_journal_entries' })
        .order('created_at', { ascending: true, referencedTable: 'pharmacy_accounting_journal_entries' })
        .limit(MAX_LINES + 1),
    ])

    for (const result of [openingResult, closingResult, linesResult]) {
      if (result.error) throw result.error
    }

    const openingRows = (openingResult.data ?? []) as BalanceRow[]
    const closingRows = (closingResult.data ?? []) as BalanceRow[]
    const currencies = [
      ...new Set([
        ...openingRows.map((row) => String(row.currency)),
        ...closingRows.map((row) => String(row.currency)),
      ]),
    ].sort()
    const requested = params.get('currency')?.trim() || String(settings?.currency ?? 'UGX')
    const currency = currencies.includes(requested) ? requested : (currencies[0] ?? requested)

    const pick = (rows: BalanceRow[]) =>
      rows.find((row) => row.account_id === accountId && String(row.currency) === currency) ?? null

    const openingBalance = money(pick(openingRows)?.balance)
    const closingBalance = money(pick(closingRows)?.balance)
    const debitSide = account.normal_balance === 'debit'

    const lineRows = (linesResult.data ?? []) as LedgerLineRow[]
    const visible = lineRows
      .filter((line) => String(line.entry?.currency ?? '') === currency)
      .slice(0, MAX_LINES)

    let running = openingBalance
    const lines = visible.map((line) => {
      const debit = money(line.debit)
      const credit = money(line.credit)
      running = Math.round((running + (debitSide ? debit - credit : credit - debit)) * 100) / 100
      return {
        id: line.id,
        entryId: line.entry?.id ?? null,
        entryNo: line.entry?.entry_no ?? '',
        date: line.entry?.entry_date ?? '',
        sourceType: line.entry?.source_type ?? '',
        sourceId: line.entry?.source_id ?? '',
        entryDescription: line.entry?.description ?? '',
        description: line.description ?? '',
        debit,
        credit,
        balance: running,
      }
    })

    return NextResponse.json({
      account: {
        id: account.id,
        code: account.code,
        name: account.name,
        accountType: account.account_type,
        normalBalance: account.normal_balance,
      },
      currency,
      currencies,
      from,
      to,
      openingBalance,
      closingBalance,
      totalDebit: Math.round(lines.reduce((total, line) => total + line.debit, 0) * 100) / 100,
      totalCredit: Math.round(lines.reduce((total, line) => total + line.credit, 0) * 100) / 100,
      lines,
      truncated:
        lineRows.filter((line) => String(line.entry?.currency ?? '') === currency).length > MAX_LINES,
    })
  } catch (error) {
    console.error('[mobile/pharmacy/accounting/ledger]', error)
    return NextResponse.json({ error: 'Failed to load the account ledger' }, { status: 500 })
  }
}
