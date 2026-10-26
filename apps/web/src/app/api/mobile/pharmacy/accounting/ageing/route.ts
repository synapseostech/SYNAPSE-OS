import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  AGEING_BUCKETS,
  applySettlements,
  summariseAgeing,
  type AgeingSummary,
  type OpenInvoice,
} from '@synapse/db/accounting-ageing'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ROWS = 20_000
const DETAIL_LIMIT = 200

type CreditRow = {
  id: string
  customer_id: string | null
  transaction_id: string | null
  amount: number | string
  type: 'credit' | 'repayment'
  due_date: string | null
  created_at: string
  customer: { name: string } | null
}

type PurchaseRow = {
  id: string
  purchase_no: string | null
  purchase_date: string | null
  balance: number | string | null
  currency: string | null
  supplier: { name: string | null } | null
}

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function isoDay(timestamp: string): string {
  return timestamp.slice(0, 10)
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

/** The app renders the bands by label, so the definitions travel with the numbers. */
function summarise(summary: AgeingSummary) {
  return {
    total: summary.total,
    buckets: summary.buckets,
    rowCount: summary.rows.length,
    truncated: summary.rows.length > DETAIL_LIMIT,
    rows: summary.rows.slice(0, DETAIL_LIMIT),
  }
}

/**
 * Receivable and payable ageing for the pharmacy app, bucketed by the same
 * shared rules as the portal. A repayment carries no invoice link, so it
 * settles the oldest open invoice first; that is an estimate and the screen
 * says so.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json(
      { error: 'Outstanding balances require a financial reports permission' },
      { status: 403 },
    )
  }

  const params = new URL(req.url).searchParams
  const asOf = params.get('asOf')?.trim() || new Date().toISOString().slice(0, 10)
  if (!isIsoDate(asOf)) {
    return NextResponse.json(
      { error: 'Use a valid as-of date in YYYY-MM-DD format.' },
      { status: 400 },
    )
  }

  const side = params.get('side')?.trim() || 'all'
  if (!['all', 'receivable', 'payable'].includes(side)) {
    return NextResponse.json(
      { error: 'Side must be all, receivable or payable.' },
      { status: 400 },
    )
  }

  try {
    const { data: settings, error: settingsError } = await db()
      .from('pharmacy_settings')
      .select('currency')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle()
    if (settingsError) throw settingsError
    const currency = String(settings?.currency ?? 'UGX')

    let receivable:
      | (ReturnType<typeof summarise> & { currency: string; customerCount: number })
      | undefined

    if (side !== 'payable') {
      const { data, error } = await db()
        .from('pharmacy_credit_ledger')
        .select(
          'id, customer_id, transaction_id, amount, type, due_date, created_at, customer:pharmacy_customers(name)',
        )
        .eq('tenant_id', auth.tenantId)
        .lte('created_at', `${asOf}T23:59:59.999Z`)
        .order('created_at', { ascending: true })
        .limit(MAX_ROWS)
      if (error) throw error

      type Group = {
        name: string
        invoices: OpenInvoice[]
        invoiceDates: Map<string, string>
        references: Map<string, string>
        settled: number
      }
      const groups = new Map<string, Group>()
      for (const row of (data ?? []) as CreditRow[]) {
        const key = row.customer_id ?? 'walk-in'
        const group: Group =
          groups.get(key) ?? {
            name: row.customer?.name?.trim() || 'Walk-in customer',
            invoices: [],
            invoiceDates: new Map(),
            references: new Map(),
            settled: 0,
          }
        if (row.type === 'repayment') {
          group.settled += money(row.amount)
        } else {
          group.invoices.push({
            id: row.id,
            amount: money(row.amount),
            dueDate: row.due_date ?? isoDay(row.created_at),
          })
          group.invoiceDates.set(row.id, isoDay(row.created_at))
          group.references.set(
            row.id,
            row.transaction_id ? `TXN-${row.transaction_id.slice(0, 8)}` : `CR-${row.id.slice(0, 8)}`,
          )
        }
        groups.set(key, group)
      }

      const rows = [...groups.values()].flatMap((group) =>
        applySettlements(group.invoices, group.settled).map((invoice) => ({
          partyName: group.name,
          reference: group.references.get(invoice.id) ?? invoice.id.slice(0, 8),
          date: group.invoiceDates.get(invoice.id) ?? invoice.dueDate,
          dueDate: invoice.dueDate,
          amount: invoice.outstanding,
          asOf,
        })),
      )

      receivable = { ...summarise(summariseAgeing(rows)), currency, customerCount: groups.size }
    }

    let payable:
      | Array<ReturnType<typeof summarise> & { currency: string; supplierCount: number }>
      | undefined

    if (side !== 'receivable') {
      const { data, error } = await db()
        .from('pharmacy_purchases')
        .select('id, purchase_no, purchase_date, balance, currency, supplier:pharmacy_suppliers(name)')
        .eq('tenant_id', auth.tenantId)
        .gt('balance', 0)
        .lte('purchase_date', asOf)
        .order('purchase_date', { ascending: true })
        .limit(MAX_ROWS)
      if (error) throw error

      const byCurrency = new Map<
        string,
        {
          rows: Array<{
            partyName: string
            reference: string
            date: string
            dueDate: string
            amount: number
            asOf: string
          }>
          suppliers: Set<string>
        }
      >()

      for (const row of (data ?? []) as PurchaseRow[]) {
        const rowCurrency = String(row.currency ?? currency)
        const group = byCurrency.get(rowCurrency) ?? { rows: [], suppliers: new Set<string>() }
        group.rows.push({
          partyName: row.supplier?.name?.trim() || 'Unknown supplier',
          reference: String(row.purchase_no ?? ''),
          date: row.purchase_date ?? '',
          // Purchases carry no due date, so the bill ages from its purchase date.
          dueDate: row.purchase_date ?? '',
          amount: money(row.balance),
          asOf,
        })
        if (row.supplier?.name) group.suppliers.add(String(row.supplier.name))
        byCurrency.set(rowCurrency, group)
      }

      payable = [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rowCurrency, group]) => ({
          ...summarise(summariseAgeing(group.rows)),
          currency: rowCurrency,
          supplierCount: group.suppliers.size,
        }))
    }

    return NextResponse.json({
      asOf,
      allocation: 'oldest-first',
      bucketDefinitions: AGEING_BUCKETS.map((bucket) => ({ id: bucket.id, label: bucket.label })),
      ...(receivable ? { receivable } : {}),
      ...(payable ? { payable } : {}),
    })
  } catch (error) {
    console.error('[mobile/pharmacy/accounting/ageing]', error)
    return NextResponse.json({ error: 'Failed to load outstanding balances' }, { status: 500 })
  }
}
