import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

type RawProduct = {
  id: string
  name: string | null
  sku: string | null
  cost_price?: number | string | null
}

type RawBatch = {
  batch_number: string | null
  expiry_date: string | null
  cost_price?: number | string | null
}

type RawItem = {
  id: string
  quantity?: number | string | null
  unit_price?: number | string | null
  cost_price?: number | string | null
  total_price?: number | string | null
  line_total?: number | string | null
  discount_amount?: number | string | null
  product?: RawProduct | null
  batch?: RawBatch | null
}

type RawSale = {
  id: string
  receipt_number?: string | null
  transaction_no?: string | null
  status?: string | null
  subtotal?: number | string | null
  total_amount?: number | string | null
  net_amount?: number | string | null
  discount_total?: number | string | null
  discount?: number | string | null
  tax_amount?: number | string | null
  tax?: number | string | null
  payment_method?: string | null
  cashier_id?: string | null
  cashier?: { full_name: string | null } | null
  client_name?: string | null
  created_at: string
  items?: RawItem[] | null
}

type SaleRow = {
  id: string
  source: 'pos' | 'order'
  status: 'COMPLETED' | 'REFUNDED'
  receiptNumber: string
  totalAmount: number
  netAmount: number
  discount: number
  tax: number
  paymentMethod: string | null
  cashierName: string | null
  clientName: string | null
  createdAt: string
  items: Array<{
    id: string
    name: string
    sku: string | null
    quantity: number
    unitPrice: number
    totalPrice: number
    batchNumber: string | null
    expiryDate: string | null
  }>
  profit: number
}

function itemCost(item: RawItem): number {
  const fromBatch = item.batch?.cost_price
  const fromItem = item.cost_price
  const fromProduct = item.product?.cost_price
  const raw = fromBatch ?? fromItem ?? fromProduct
  return raw == null ? 0 : Number(raw)
}

function mapItems(items: RawItem[] | null | undefined, source: 'pos' | 'order') {
  return (items ?? []).map((item) => {
    const quantity = Number(item.quantity ?? 0)
    const unitPrice = Number(item.unit_price ?? 0)
    const totalPrice =
      source === 'pos'
        ? Number(
            item.line_total ??
              quantity * unitPrice - Number(item.discount_amount ?? 0),
          )
        : Number(item.total_price ?? 0)
    return {
      id: item.id,
      name: item.product?.name ?? 'Unknown product',
      sku: item.product?.sku ?? null,
      quantity,
      unitPrice,
      totalPrice,
      batchNumber: item.batch?.batch_number ?? null,
      expiryDate: item.batch?.expiry_date ?? null,
    }
  })
}

function mapPosSale(sale: RawSale, cashierName: string | null): SaleRow {
  const items = mapItems(sale.items, 'pos')
  return {
    id: sale.id,
    source: 'pos',
    status: String(sale.status ?? '').toUpperCase() === 'VOIDED' ? 'REFUNDED' : 'COMPLETED',
    receiptNumber: sale.receipt_number ?? '',
    totalAmount: Number(sale.subtotal ?? 0),
    netAmount: Number(sale.total_amount ?? 0),
    discount: Number(sale.discount_total ?? 0),
    tax: Number(sale.tax_amount ?? 0),
    paymentMethod: sale.payment_method ?? null,
    cashierName,
    clientName: null,
    createdAt: sale.created_at,
    items,
    profit: (sale.items ?? []).reduce((sum, item) => {
      const cost = itemCost(item)
      return sum + (Number(item.unit_price ?? 0) - cost) * Math.abs(Number(item.quantity ?? 0))
    }, 0),
  }
}

function mapOrderSale(sale: RawSale): SaleRow {
  const items = mapItems(sale.items, 'order')
  return {
    id: sale.id,
    source: 'order',
    status: 'COMPLETED',
    receiptNumber: sale.transaction_no ?? '',
    totalAmount: Number(sale.total_amount ?? 0),
    netAmount: Number(sale.net_amount ?? 0),
    discount: Number(sale.discount ?? 0),
    tax: Number(sale.tax ?? 0),
    paymentMethod: sale.payment_method ?? null,
    cashierName: sale.cashier?.full_name ?? null,
    clientName: sale.client_name ?? null,
    createdAt: sale.created_at,
    items,
    profit: (sale.items ?? []).reduce((sum, item) => {
      const cost = itemCost(item)
      return sum + (Number(item.unit_price ?? 0) - cost) * Math.abs(Number(item.quantity ?? 0))
    }, 0),
  }
}

/** Completed POS sales plus legacy order sales, newest first. Read-only. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (
    !mobileHasPharmacyCapability(auth, 'pos.sell') &&
    !mobileHasPharmacyCapability(auth, 'reports.operational')
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const limitParam = Number(new URL(req.url).searchParams.get('limit') ?? '50')
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 100)

  const [posResult, orderResult, settingsResult] = await Promise.all([
    db()
      .from('pharmacy_pos_sales')
      .select(
        `id, receipt_number, status, subtotal, discount_total, tax_amount, total_amount,
         payment_method, cashier_id, created_at,
         items:pharmacy_pos_sale_items (
           id, quantity, unit_price, discount_amount, line_total,
           product:pharmacy_products ( id, name, sku, cost_price ),
           batch:pharmacy_product_batches ( batch_number, expiry_date, cost_price )
         )`,
      )
      .eq('tenant_id', auth.tenantId)
      .in('status', ['completed', 'voided'])
      .order('created_at', { ascending: false })
      .limit(limit),
    db()
      .from('pharmacy_transactions')
      .select(
        `id, transaction_no, status, total_amount, discount, tax, net_amount,
         payment_method, cashier_id, created_at, client_name,
         cashier:profiles!pharmacy_transactions_cashier_id_fkey ( full_name ),
         items:pharmacy_transaction_items (
           id, quantity, unit_price, cost_price, total_price,
           product:pharmacy_products ( id, name, sku, cost_price ),
           batch:pharmacy_product_batches ( batch_number, expiry_date )
         )`,
      )
      .eq('tenant_id', auth.tenantId)
      .eq('status', 'COMPLETED')
      .order('created_at', { ascending: false })
      .limit(limit),
    db()
      .from('pharmacy_settings')
      .select('currency')
      .eq('tenant_id', auth.tenantId)
      .maybeSingle(),
  ])

  if (posResult.error) {
    console.error('[mobile/pharmacy/transactions] pos', posResult.error.message)
    return NextResponse.json({ error: 'Failed to load transactions' }, { status: 500 })
  }
  if (orderResult.error) {
    console.error('[mobile/pharmacy/transactions] orders', orderResult.error.message)
  }

  const cashierIds = [
    ...new Set(
      (posResult.data ?? [])
        .map((sale: RawSale) => sale.cashier_id)
        .filter(Boolean),
    ),
  ] as string[]
  const cashierNames = new Map<string, string>()
  if (cashierIds.length) {
    const { data: profiles } = await db()
      .from('profiles')
      .select('id, full_name')
      .in('id', cashierIds)
    for (const profile of profiles ?? []) {
      cashierNames.set(profile.id, profile.full_name ?? '')
    }
  }

  const rows: SaleRow[] = [
    ...(posResult.data ?? []).map((sale: RawSale) =>
      mapPosSale(
        sale,
        sale.cashier_id ? cashierNames.get(sale.cashier_id) ?? null : null,
      ),
    ),
    ...(orderResult.data ?? []).map((sale: RawSale) => mapOrderSale(sale)),
  ]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const weekAgo = new Date()
  weekAgo.setDate(weekAgo.getDate() - 7)
  const monthAgo = new Date()
  monthAgo.setMonth(monthAgo.getMonth() - 1)

  const { data: revenueRows } = await db()
    .from('pharmacy_pos_sales')
    .select('total_amount, created_at')
    .eq('tenant_id', auth.tenantId)
    .eq('status', 'completed')
    .gte('created_at', monthAgo.toISOString())

  const revenueSince = (from: Date) =>
    (revenueRows ?? []).reduce(
      (sum: number, row: { total_amount: number | string | null; created_at: string }) =>
        Date.parse(row.created_at) >= from.getTime()
          ? sum + Number(row.total_amount ?? 0)
          : sum,
      0,
    )

  const inPeriod = (iso: string, from: Date) => Date.parse(iso) >= from.getTime()
  const profitFor = (from: Date) =>
    rows
      .filter((row) => row.status === 'COMPLETED' && inPeriod(row.createdAt, from))
      .reduce((sum, row) => sum + row.profit, 0)

  const canSeeProfit = mobileHasPharmacyCapability(auth, 'reports.financial')

  return NextResponse.json({
    currency: settingsResult?.data?.currency ?? 'UGX',
    transactions: rows.map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      receiptNumber: row.receiptNumber,
      totalAmount: row.totalAmount,
      netAmount: row.netAmount,
      discount: row.discount,
      tax: row.tax,
      paymentMethod: row.paymentMethod,
      cashierName: row.cashierName,
      clientName: row.clientName,
      createdAt: row.createdAt,
      items: row.items,
    })),
    stats: {
      today: revenueSince(today),
      week: revenueSince(weekAgo),
      month: revenueSince(monthAgo),
      count: rows.length,
      ...(canSeeProfit
        ? {
            todayProfit: profitFor(today),
            weekProfit: profitFor(weekAgo),
            monthProfit: profitFor(monthAgo),
          }
        : {}),
    },
  })
}
