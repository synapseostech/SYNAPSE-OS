/**
 * Canonical pharmacy sale ledger helpers.
 * POS truth = pharmacy_pos_sales / pharmacy_pos_sale_items.
 * pharmacy_transactions remains order/legacy until migrated.
 */
import { supabaseAdmin } from "@/lib/supabase/admin"

export type LedgerSaleRow = {
  id: string
  source: "pos" | "order"
  transactionNo: string
  status: string
  netAmount: number
  subtotal: number
  discount: number
  tax: number
  paymentMethod: string | null
  /** POS only: the settlement tag, so callers can separate cash paid from balance due. */
  paymentRef?: string | null
  cashierId: string | null
  cashierName: string | null
  createdAt: string
  clientName: string | null
  notes: string | null
  /** POS only: the cashier recorded that the receipt did not print. */
  printFailed: boolean
  items: Array<{
    id: string
    quantity: number
    unitPrice: number
    costPrice: number | null
    totalPrice: number
    product: {
      id: string
      name: string
      sku: string | null
      cost_price?: number | null
      category?: string | null
    } | null
    batch: { batch_number: string | null; expiry_date: string | null } | null
  }>
}

type Db = ReturnType<typeof admin>

function admin() {
  return supabaseAdmin as any
}

/** Sum completed POS sale totals (+ optional legacy order COMPLETED txs). */
export async function sumCompletedRevenue(params: {
  tenantId: string
  cashierId?: string
  fromIso?: string
  includeOrderTxs?: boolean
}): Promise<{ amount: number; count: number }> {
  const db = admin()
  let posQ = db
    .from("pharmacy_pos_sales")
    .select("total_amount")
    .eq("tenant_id", params.tenantId)
    .eq("status", "completed")
  if (params.cashierId) posQ = posQ.eq("cashier_id", params.cashierId)
  if (params.fromIso) posQ = posQ.gte("created_at", params.fromIso)

  const { data: posRows } = await posQ
  let amount = (posRows ?? []).reduce(
    (s: number, r: { total_amount: number | null }) => s + Number(r.total_amount ?? 0),
    0,
  )
  let count = posRows?.length ?? 0

  // Future financial truth is pharmacy_pos_sales. Legacy order txs are opt-in
  // so reports cannot double-count the same business sale.
  if (params.includeOrderTxs === true) {
    let txQ = db
      .from("pharmacy_transactions")
      .select("net_amount")
      .eq("tenant_id", params.tenantId)
      .eq("status", "COMPLETED")
    if (params.cashierId) txQ = txQ.eq("cashier_id", params.cashierId)
    if (params.fromIso) txQ = txQ.gte("created_at", params.fromIso)
    const { data: txRows } = await txQ
    amount += (txRows ?? []).reduce(
      (s: number, r: { net_amount: number | null }) => s + Number(r.net_amount ?? 0),
      0,
    )
    count += txRows?.length ?? 0
  }

  return { amount, count }
}

/** Recent completed sales for dashboards (POS first, then order txs). */
export async function listRecentLedgerSales(params: {
  tenantId: string
  cashierId?: string
  limit?: number
}): Promise<
  Array<{ id: string; transaction_no: string; net_amount: number; created_at: string; source: string }>
> {
  const db = admin()
  const limit = params.limit ?? 5

  let posQ = db
    .from("pharmacy_pos_sales")
    .select("id, receipt_number, total_amount, created_at")
    .eq("tenant_id", params.tenantId)
    .eq("status", "completed")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (params.cashierId) posQ = posQ.eq("cashier_id", params.cashierId)

  const { data: pos } = await posQ
  const mapped = (pos ?? []).map(
    (r: {
      id: string
      receipt_number: string
      total_amount: number
      created_at: string
    }) => ({
      id: r.id,
      transaction_no: r.receipt_number,
      net_amount: Number(r.total_amount ?? 0),
      created_at: r.created_at,
      source: "pos",
    }),
  )

  if (mapped.length >= limit) return mapped.slice(0, limit)

  let txQ = db
    .from("pharmacy_transactions")
    .select("id, transaction_no, net_amount, created_at")
    .eq("tenant_id", params.tenantId)
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false })
    .limit(limit - mapped.length)
  if (params.cashierId) txQ = txQ.eq("cashier_id", params.cashierId)
  const { data: txs } = await txQ
  return [
    ...mapped,
    ...(txs ?? []).map(
      (r: {
        id: string
        transaction_no: string
        net_amount: number
        created_at: string
      }) => ({
        id: r.id,
        transaction_no: r.transaction_no,
        net_amount: Number(r.net_amount ?? 0),
        created_at: r.created_at,
        source: "order",
      }),
    ),
  ]
}

/** List POS + order sales in a UI-compatible shape for history. */
export async function listLedgerSalesForHistory(params: {
  tenantId: string
  limit?: number
  fromIso?: string
  toIso?: string
  /** Case-insensitive receipt / transaction number fragment. */
  search?: string
}): Promise<LedgerSaleRow[]> {
  const db = admin()
  const limit = params.limit ?? 100
  // Backslash is LIKE's escape character in PostgREST; an unescaped % or _
  // from the search box would widen the filter instead of matching it.
  const pattern = params.search
    ? `%${params.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    : null

  let posQ = db
    .from("pharmacy_pos_sales")
    .select(
      `
      id, receipt_number, status, subtotal, discount_total, tax_amount, total_amount,
      payment_method, payment_ref, cashier_id, created_at, confirmed_at, print_failed,
      items:pharmacy_pos_sale_items (
        id, quantity, unit_price, discount_amount, line_total, batch_id, product_id,
        batch:pharmacy_product_batches ( batch_number, expiry_date, cost_price ),
        product:pharmacy_products ( id, name, sku, cost_price, dosage_form, strength, category )
      )
    `,
    )
    .eq("tenant_id", params.tenantId)
    .in("status", ["completed", "voided"])
    .order("created_at", { ascending: false })
    .limit(limit)
  if (params.fromIso) posQ = posQ.gte("created_at", params.fromIso)
  if (params.toIso) posQ = posQ.lte("created_at", params.toIso)
  if (pattern) posQ = posQ.ilike("receipt_number", pattern)

  const { data: posSales, error: posErr } = await posQ

  if (posErr) {
    console.error("[sale-ledger] pos list failed:", posErr.message)
  }

  const cashierIds = [
    ...new Set((posSales ?? []).map((s: { cashier_id?: string }) => s.cashier_id).filter(Boolean)),
  ] as string[]
  const cashierNames = new Map<string, string>()
  if (cashierIds.length) {
    const { data: profiles } = await db
      .from("profiles")
      .select("id, full_name")
      .in("id", cashierIds)
    for (const p of profiles ?? []) {
      cashierNames.set(p.id, p.full_name ?? "")
    }
  }

  const posMapped: LedgerSaleRow[] = (posSales ?? []).map((s: any) => ({
    id: s.id,
    source: "pos" as const,
    transactionNo: s.receipt_number,
    status: String(s.status ?? "").toUpperCase() === "VOIDED" ? "REFUNDED" : "COMPLETED",
    netAmount: Number(s.total_amount ?? 0),
    subtotal: Number(s.subtotal ?? 0),
    discount: Number(s.discount_total ?? 0),
    tax: Number(s.tax_amount ?? 0),
    paymentMethod: s.payment_method,
    paymentRef: s.payment_ref ?? null,
    cashierId: s.cashier_id,
    cashierName: s.cashier_id ? cashierNames.get(s.cashier_id) ?? null : null,
    createdAt: s.created_at,
    clientName: null,
    notes: null,
    printFailed: s.print_failed === true,
    items: (s.items ?? []).map((i: any) => ({
      id: i.id,
      quantity: Number(i.quantity ?? 0),
      unitPrice: Number(i.unit_price ?? 0),
      costPrice:
        i.batch?.cost_price != null
          ? Number(i.batch.cost_price)
          : i.product?.cost_price != null
            ? Number(i.product.cost_price)
            : null,
      totalPrice: Number(
        i.line_total ?? Number(i.quantity ?? 0) * Number(i.unit_price ?? 0) - Number(i.discount_amount ?? 0),
      ),
      product: i.product
        ? {
            id: i.product.id,
            name: i.product.name,
            sku: i.product.sku,
            cost_price: i.product.cost_price,
          }
        : null,
      batch: i.batch
        ? { batch_number: i.batch.batch_number, expiry_date: i.batch.expiry_date }
        : null,
    })),
  }))

  let orderQ = db
    .from("pharmacy_transactions")
    .select(
      `
      id, transaction_no, status, total_amount, discount, tax, net_amount,
      payment_method, cashier_id, created_at, client_name, notes,
      cashier:profiles!pharmacy_transactions_cashier_id_fkey ( full_name ),
      items:pharmacy_transaction_items (
        id, quantity, unit_price, cost_price, total_price,
        package_name, package_quantity,
        batch:pharmacy_product_batches ( batch_number, expiry_date ),
        product:pharmacy_products ( id, name, sku, cost_price, dosage_form, strength, category )
      )
    `,
    )
    .eq("tenant_id", params.tenantId)
    .eq("status", "COMPLETED")
    .order("created_at", { ascending: false })
    .limit(limit)
  if (params.fromIso) orderQ = orderQ.gte("created_at", params.fromIso)
  if (params.toIso) orderQ = orderQ.lte("created_at", params.toIso)
  if (pattern) orderQ = orderQ.ilike("transaction_no", pattern)

  // pharmacy_transactions has total_amount (pre-discount), not subtotal. Selecting a
  // missing column made PostgREST fail and every order sale vanished from history.
  const { data: orderTxs, error: orderErr } = await orderQ
  if (orderErr) console.error("[sale-ledger] order list failed:", orderErr.message)

  const orderMapped: LedgerSaleRow[] = (orderTxs ?? []).map((s: any) => ({
    id: s.id,
    source: "order" as const,
    transactionNo: s.transaction_no,
    status: "COMPLETED",
    netAmount: Number(s.net_amount ?? 0),
    subtotal: Number(s.total_amount ?? 0),
    discount: Number(s.discount ?? 0),
    tax: Number(s.tax ?? 0),
    paymentMethod: s.payment_method,
    cashierId: s.cashier_id,
    cashierName: s.cashier?.full_name ?? null,
    createdAt: s.created_at,
    clientName: s.client_name ?? null,
    notes: s.notes ?? null,
    printFailed: false,
    items: (s.items ?? []).map((i: any) => ({
      id: i.id,
      quantity: Number(i.quantity ?? 0),
      unitPrice: Number(i.unit_price ?? 0),
      costPrice: i.cost_price != null ? Number(i.cost_price) : null,
      totalPrice: Number(i.total_price ?? 0),
      product: i.product
        ? {
            id: i.product.id,
            name: i.product.name,
            sku: i.product.sku,
            cost_price: i.product.cost_price,
          }
        : null,
      batch: i.batch
        ? { batch_number: i.batch.batch_number, expiry_date: i.batch.expiry_date }
        : null,
    })),
  }))

  return [...posMapped, ...orderMapped]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
}

/** Shape a ledger row like legacy pharmacy_transactions list API objects. */
export function toLegacyTransactionShape(row: LedgerSaleRow) {
  return {
    id: row.id,
    transaction_no: row.transactionNo,
    status: row.status,
    subtotal: row.subtotal,
    discount: row.discount,
    tax: row.tax,
    net_amount: row.netAmount,
    payment_method: row.paymentMethod,
    cashier_id: row.cashierId,
    created_at: row.createdAt,
    client_name: row.clientName,
    notes: row.notes,
    source: row.source,
    cashier: row.cashierName ? { full_name: row.cashierName } : null,
    items: row.items.map((i) => ({
      id: i.id,
      quantity: i.quantity,
      unit_price: i.unitPrice,
      cost_price: i.costPrice,
      total_price: i.totalPrice,
      product: i.product,
      batch: i.batch
        ? { batch_number: i.batch.batch_number, expiry_date: i.batch.expiry_date }
        : null,
    })),
  }
}


