import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import type { StockTakeScope, StockTakeStatus } from '@synapse/db/stock-take'
import { mobileHasPharmacyCapability, type MobileAuth } from './mobile-pharmacy-auth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stockTakeDb = () => supabaseAdmin as any

export const STOCK_TAKE_COLUMNS =
  'id, tenant_id, reference, title, scope_type, scope_categories, blind, status, notes, opened_by, opened_at, closed_by, closed_at, posted_by, posted_at, cancelled_by, cancelled_at, posting_summary'

export type StockTakeRow = {
  id: string
  tenant_id: string
  reference: string
  title: string
  scope_type: StockTakeScope
  scope_categories: string[] | null
  blind: boolean
  status: StockTakeStatus
  notes: string | null
  opened_by: string
  opened_at: string
  closed_by: string | null
  closed_at: string | null
  posted_by: string | null
  posted_at: string | null
  cancelled_by: string | null
  cancelled_at: string | null
  posting_summary: Record<string, unknown> | null
}

/** Every pharmacy role may count. */
export function canCountStock(auth: MobileAuth): boolean {
  return mobileHasPharmacyCapability(auth, 'inventory.read')
}

/** Opening, closing, recounting and posting change the book: inventory.adjust. */
export function canManageStockTake(auth: MobileAuth): boolean {
  return mobileHasPharmacyCapability(auth, 'inventory.adjust')
}

export function forbidden(message: string) {
  return NextResponse.json({ error: message, code: 'FORBIDDEN' }, { status: 403 })
}

export function toStockTakeView(row: StockTakeRow, auth: MobileAuth) {
  const manager = canManageStockTake(auth)
  return {
    id: row.id,
    reference: row.reference,
    title: row.title,
    scope: row.scope_type,
    categories: row.scope_categories ?? [],
    blind: row.blind,
    status: row.status,
    notes: row.notes,
    openedBy: row.opened_by,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    postedAt: row.posted_at,
    postedBy: row.posted_by,
    cancelledAt: row.cancelled_at,
    postingSummary: row.posting_summary,
    /** Counters see book quantities only when the count is not blind. */
    showBook: manager || !row.blind,
    canManage: manager,
  }
}

export async function loadStockTake(
  tenantId: string,
  id: string,
): Promise<{ row: StockTakeRow } | { error: NextResponse }> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return { error: NextResponse.json({ error: 'Stock take not found' }, { status: 404 }) }
  }
  const { data, error } = await stockTakeDb()
    .from('pharmacy_stock_takes')
    .select(STOCK_TAKE_COLUMNS)
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle()
  if (error) {
    return { error: NextResponse.json({ error: 'Unable to load stock take' }, { status: 503 }) }
  }
  if (!data) {
    return { error: NextResponse.json({ error: 'Stock take not found' }, { status: 404 }) }
  }
  return { row: data as StockTakeRow }
}

const PAGE = 1000

/**
 * PostgREST caps a response at 1,000 rows; a pharmacy imported from Tally has
 * two thousand products. Read every page.
 */
export async function selectAll<T>(
  build: () => {
    range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>
  },
  limit = 50_000,
): Promise<{ rows: T[] } | { error: unknown }> {
  const rows: T[] = []
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1)
    if (error) return { error }
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE) break
  }
  return { rows }
}

export type ScopeProductRow = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  category: string | null
  quantity: number | null
  cost_price: number | null
  unit_of_measure: string | null
  updated_at: string | null
}

export type ScopeBatchRow = {
  id: string
  product_id: string
  batch_number: string
  quantity: number | null
  expiry_date: string | null
  status: string | null
  cost_price: number | null
}

export async function loadScopeProducts(
  take: StockTakeRow,
): Promise<{ rows: ScopeProductRow[] } | { error: unknown }> {
  return selectAll<ScopeProductRow>(() => {
    let query = stockTakeDb()
      .from('pharmacy_products')
      .select('id, name, sku, barcode, category, quantity, cost_price, unit_of_measure, updated_at')
      .eq('tenant_id', take.tenant_id)
      .eq('is_active', true)
    if (take.scope_type === 'category' && (take.scope_categories ?? []).length > 0) {
      query = query.in('category', take.scope_categories)
    }
    return query.order('name', { ascending: true }).order('id', { ascending: true })
  })
}

export async function loadBatchesForProducts(
  tenantId: string,
  productIds: string[],
): Promise<{ rows: ScopeBatchRow[] } | { error: unknown }> {
  const rows: ScopeBatchRow[] = []
  // Keep the IN list well under URL limits.
  for (let i = 0; i < productIds.length; i += 150) {
    const chunk = productIds.slice(i, i + 150)
    const result = await selectAll<ScopeBatchRow>(() =>
      stockTakeDb()
        .from('pharmacy_product_batches')
        .select('id, product_id, batch_number, quantity, expiry_date, status, cost_price')
        .eq('tenant_id', tenantId)
        .in('product_id', chunk)
        .order('expiry_date', { ascending: true })
        .order('id', { ascending: true }),
    )
    if ('error' in result) return result
    rows.push(...result.rows)
  }
  return { rows }
}

/** Map a Postgres exception raised by the stock-take functions to an HTTP answer. */
export function stockTakeRpcError(error: { message?: string } | null | undefined) {
  const message = String(error?.message ?? '')
  const code = message.split(':')[0]?.trim() ?? ''
  const status =
    code === 'STOCK_TAKE_NOT_FOUND' || code === 'PRODUCT_NOT_FOUND'
      ? 404
      : code === 'STOCK_TAKE_CLOSED' || code === 'STOCK_TAKE_NOT_IN_REVIEW'
        ? 409
        : code === 'PERMISSION'
          ? 403
          : code === 'INVALID_QUANTITY'
            ? 400
            : 503
  const known = status !== 503
  return NextResponse.json(
    {
      error: known ? message.slice(code.length + 1).trim() || message : 'Stock take could not be saved',
      code: known ? code : 'STOCK_TAKE_FAILED',
    },
    { status },
  )
}
