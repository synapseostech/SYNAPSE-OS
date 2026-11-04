/**
 * The datasets an admin can export from the portal.
 *
 * Each dataset declares its columns and one or more sources. A source is a
 * paged query: `count` says how many records it holds, `page` returns the rows
 * in [offset, offset + limit). Reading them separately keeps a dataset that
 * spans two tables (POS sales and Till sales) in one file without loading
 * either side into memory.
 *
 * `page` returns `consumed` alongside `rows` because they are not always equal:
 * the products export pages over products and emits one row per batch, so a
 * page of 1000 products can be 4000 rows.
 */

export type ExportContext = {
  db: any
  tenantId: string
  /** Inclusive first day, YYYY-MM-DD. */
  from: string
  /** Inclusive last day, YYYY-MM-DD. */
  to: string
}

export type ExportColumn = { key: string; label: string }
export type ExportRow = Record<string, unknown>

export type ExportPage = { rows: ExportRow[]; consumed: number }

export type ExportSource = {
  count: (ctx: ExportContext) => Promise<number>
  page: (ctx: ExportContext, offset: number, limit: number) => Promise<ExportPage>
}

export type ExportDataset = {
  id: string
  label: string
  group: string
  description: string
  /** False for a snapshot, whose date fields are ignored. */
  dateScoped: boolean
  columns: ExportColumn[]
  sources: ExportSource[]
}

/** Rows per query. Supabase answers at most 1000 per request. */
export const PAGE_SIZE = 1000

// The business day is Africa/Kampala (UTC+3 year-round), the same zone the
// ledger and the sale RPC use, so a sale at 22:00 UTC on 31 January is dated
// 1 February in the export, exactly as it is in the portal.
const DAY_START = "+03:00"

function startOfDay(date: string): string {
  return `${date}T00:00:00${DAY_START}`
}

function endOfDay(date: string): string {
  return `${date}T23:59:59.999${DAY_START}`
}

function money(value: unknown): number {
  return Math.round((Number(value ?? 0) + Number.EPSILON) * 100) / 100
}

/** A money column that keeps "not recorded" distinct from zero. */
function moneyOrNull(value: unknown): number | null {
  return value === null || value === undefined ? null : money(value)
}

function whole(value: unknown): number {
  return Number(value ?? 0)
}

function text(value: unknown): string | null {
  return value === null || value === undefined || value === "" ? null : String(value)
}

function staffName(row: { full_name?: string | null; first_name?: string | null; last_name?: string | null } | null): string | null {
  if (!row) return null
  if (row.full_name) return row.full_name
  const joined = [row.first_name, row.last_name].filter(Boolean).join(" ").trim()
  return joined || null
}

const dateTimeFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
})

/** A timestamp as it reads in the pharmacy: `YYYY-MM-DD HH:mm`, Kampala time. */
function localDateTime(value: unknown): string | null {
  if (!value) return null
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  const parts = dateTimeFormat.formatToParts(date)
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? ""
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`
}

async function countRows(query: any): Promise<number> {
  const { count, error } = await query
  if (error) throw new Error(error.message ?? String(error))
  return count ?? 0
}

async function fetchRows(query: any): Promise<any[]> {
  const { data, error } = await query
  if (error) throw new Error(error.message ?? String(error))
  return data ?? []
}

/** A source over a whole table, for a snapshot export with no date range. */
function listSource(config: {
  table: string
  columns: string
  orderBy: string
  map: (row: any) => ExportRow
}): ExportSource {
  return {
    count: (ctx) =>
      countRows(
        ctx.db.from(config.table).eq("tenant_id", ctx.tenantId).select("id", { head: true, count: "exact" }),
      ),
    page: async (ctx, offset, limit) => {
      const rows = await fetchRows(
        ctx.db
          .from(config.table)
          .eq("tenant_id", ctx.tenantId)
          .select(config.columns)
          .order(config.orderBy, { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      )
      return { rows: rows.map(config.map), consumed: rows.length }
    },
  }
}

/** A source over a single table, filtered by its own date column. */
function tableSource(config: {
  table: string
  columns: string
  dateColumn: string
  orderBy: string
  filter?: (query: any) => any
  map: (row: any, ctx: ExportContext) => Promise<ExportRow[]> | ExportRow[]
}): ExportSource {
  const base = (ctx: ExportContext) => (ctx.db as any).from(config.table)
  const scoped = (ctx: ExportContext) => {
    let query = base(ctx)
      .eq("tenant_id", ctx.tenantId)
      .gte(config.dateColumn, startOfDay(ctx.from))
      .lte(config.dateColumn, endOfDay(ctx.to))
    return config.filter ? config.filter(query) : query
  }

  return {
    count: (ctx) => countRows(scoped(ctx).select("id", { head: true, count: "exact" })),
    page: async (ctx, offset, limit) => {
      const rows = await fetchRows(
        scoped(ctx)
          .select(config.columns)
          .order(config.orderBy, { ascending: true })
          .order("id", { ascending: true })
          .range(offset, offset + limit - 1),
      )
      const mapped: ExportRow[] = []
      for (const row of rows) mapped.push(...(await config.map(row, ctx)))
      return { rows: mapped, consumed: rows.length }
    },
  }
}

// ---------------------------------------------------------------- sales

const SALE_COLUMNS: ExportColumn[] = [
  { key: "source", label: "Source" },
  { key: "receiptNumber", label: "Receipt No" },
  { key: "date", label: "Date" },
  { key: "customer", label: "Customer" },
  { key: "customerPhone", label: "Customer Phone" },
  { key: "paymentMethod", label: "Payment Method" },
  { key: "status", label: "Status" },
  { key: "subtotal", label: "Subtotal (before tax)" },
  { key: "discount", label: "Discount" },
  { key: "tax", label: "Tax" },
  { key: "total", label: "Total" },
  { key: "cashier", label: "Cashier" },
]

// POS sales store only `cashier_id`, and three foreign keys point at profiles,
// so the names are looked up once per page rather than through a join hint.
async function cashierNames(ctx: ExportContext, ids: string[]): Promise<Map<string, string | null>> {
  const names = new Map<string, string | null>()
  if (ids.length === 0) return names
  const rows = await fetchRows(
    ctx.db.from("profiles").select("id, full_name, first_name, last_name").in("id", ids),
  )
  for (const row of rows) names.set(row.id, staffName(row))
  return names
}

const posSales: ExportSource = {
  count: (ctx) =>
    countRows(
      ctx.db
        .from("pharmacy_pos_sales")
        .eq("tenant_id", ctx.tenantId)
        .in("status", ["completed", "voided"])
        .gte("created_at", startOfDay(ctx.from))
        .lte("created_at", endOfDay(ctx.to))
        .select("id", { head: true, count: "exact" }),
    ),
  page: async (ctx, offset, limit) => {
    const rows = await fetchRows(
      ctx.db
        .from("pharmacy_pos_sales")
        .eq("tenant_id", ctx.tenantId)
        .in("status", ["completed", "voided"])
        .gte("created_at", startOfDay(ctx.from))
        .lte("created_at", endOfDay(ctx.to))
        .select(
          "id, receipt_number, status, subtotal, discount_total, tax_amount, total_amount, payment_method, cashier_id, created_at",
        )
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1),
    )

    const ids = [...new Set(rows.map((row) => row.cashier_id).filter(Boolean))] as string[]
    const names = await cashierNames(ctx, ids)

    return {
      rows: rows.map((row) => ({
        source: "POS",
        receiptNumber: text(row.receipt_number),
        date: localDateTime(row.created_at),
        // A POS sale records a clinical patient id, not a customer, so there is
        // no customer contact here to export.
        customer: null,
        customerPhone: null,
        paymentMethod: text(row.payment_method),
        status: text(row.status),
        subtotal: money(row.subtotal),
        discount: money(row.discount_total),
        tax: money(row.tax_amount),
        // `total_amount` is stored tax-inclusive on a POS sale.
        total: money(row.total_amount),
        cashier: row.cashier_id ? (names.get(row.cashier_id) ?? null) : null,
      })),
      consumed: rows.length,
    }
  },
}

const tillSales: ExportSource = tableSource({
  table: "pharmacy_transactions",
  columns:
    "id, transaction_no, status, total_amount, discount, tax, payment_method, client_name, client_phone, cashier_id, created_at",
  dateColumn: "created_at",
  orderBy: "created_at",
  filter: (query) => query.eq("status", "COMPLETED"),
  map: (row) => [
    {
      source: "Till",
      receiptNumber: text(row.transaction_no),
      date: localDateTime(row.created_at),
      customer: text(row.client_name),
      customerPhone: text(row.client_phone),
      paymentMethod: text(row.payment_method),
      status: text(row.status),
      // `total_amount` is the pre-tax line sum on a Till order.
      subtotal: money(row.total_amount),
      discount: money(row.discount),
      tax: money(row.tax),
      total: money(Number(row.total_amount ?? 0) - Number(row.discount ?? 0) + Number(row.tax ?? 0)),
      cashier: null,
    },
  ],
})

// ---------------------------------------------------------------- sale lines

const SALE_LINE_COLUMNS: ExportColumn[] = [
  { key: "source", label: "Source" },
  { key: "receiptNumber", label: "Receipt No" },
  { key: "date", label: "Date" },
  { key: "product", label: "Product" },
  { key: "sku", label: "SKU" },
  { key: "batch", label: "Batch" },
  { key: "quantity", label: "Quantity" },
  { key: "unitPrice", label: "Unit Price" },
  { key: "discount", label: "Discount" },
  { key: "lineTotal", label: "Line Total" },
]

const posSaleLines: ExportSource = tableSource({
  table: "pharmacy_pos_sale_items",
  columns: `id, quantity, unit_price, discount_amount, line_total, created_at,
    sale:pharmacy_pos_sales!inner(receipt_number, status, created_at),
    product:pharmacy_products(name, sku),
    batch:pharmacy_product_batches(batch_number)`,
  dateColumn: "created_at",
  orderBy: "created_at",
  filter: (query) => query.in("sale.status", ["completed", "voided"]),
  map: (row) => [
    {
      source: "POS",
      receiptNumber: text(row.sale?.receipt_number),
      date: localDateTime(row.sale?.created_at ?? row.created_at),
      product: text(row.product?.name),
      sku: text(row.product?.sku),
      batch: text(row.batch?.batch_number),
      quantity: whole(row.quantity),
      unitPrice: money(row.unit_price),
      discount: money(row.discount_amount),
      lineTotal: money(row.line_total),
    },
  ],
})

const tillSaleLines: ExportSource = tableSource({
  table: "pharmacy_transaction_items",
  columns: `id, quantity, unit_price, total_price, created_at,
    sale:pharmacy_transactions!inner(transaction_no, status, created_at),
    product:pharmacy_products(name, sku),
    batch:pharmacy_product_batches(batch_number)`,
  dateColumn: "created_at",
  orderBy: "created_at",
  filter: (query) => query.eq("sale.status", "COMPLETED"),
  map: (row) => [
    {
      source: "Till",
      receiptNumber: text(row.sale?.transaction_no),
      date: localDateTime(row.sale?.created_at ?? row.created_at),
      product: text(row.product?.name),
      sku: text(row.product?.sku),
      batch: text(row.batch?.batch_number),
      quantity: whole(row.quantity),
      unitPrice: money(row.unit_price),
      // A Till line stores no line discount; the discount sits on the order.
      discount: 0,
      lineTotal: money(row.total_price),
    },
  ],
})

// ---------------------------------------------------------------- purchases

const PURCHASE_COLUMNS: ExportColumn[] = [
  { key: "purchaseNo", label: "Purchase No" },
  { key: "purchaseDate", label: "Purchase Date" },
  { key: "supplier", label: "Supplier" },
  { key: "supplierInvoiceNo", label: "Supplier Invoice" },
  { key: "status", label: "Status" },
  { key: "paymentStatus", label: "Payment Status" },
  { key: "currency", label: "Currency" },
  { key: "subtotal", label: "Subtotal" },
  { key: "tax", label: "Tax" },
  { key: "discount", label: "Discount" },
  { key: "otherCost", label: "Other Cost" },
  { key: "total", label: "Total" },
  { key: "amountPaid", label: "Amount Paid" },
  { key: "balance", label: "Balance" },
  { key: "receivedDate", label: "Received Date" },
  { key: "notes", label: "Notes" },
]

// `purchase_date` is a date, not a timestamp, so it is compared against the
// range directly instead of through the Kampala day boundaries.
const purchases: ExportSource = {
  count: (ctx) =>
    countRows(
      ctx.db
        .from("pharmacy_purchases")
        .eq("tenant_id", ctx.tenantId)
        .gte("purchase_date", ctx.from)
        .lte("purchase_date", ctx.to)
        .select("id", { head: true, count: "exact" }),
    ),
  page: async (ctx, offset, limit) => {
    const rows = await fetchRows(
      ctx.db
        .from("pharmacy_purchases")
        .eq("tenant_id", ctx.tenantId)
        .gte("purchase_date", ctx.from)
        .lte("purchase_date", ctx.to)
        .select(
          `id, purchase_no, purchase_date, supplier_invoice_no, payment_status, payment_method,
           currency, subtotal, tax, discount, other_cost, total, amount_paid, balance,
           status, received_date, notes, supplier:pharmacy_suppliers(name)`,
        )
        .order("purchase_date", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1),
    )
    return {
      rows: rows.map((row) => ({
        purchaseNo: text(row.purchase_no),
        purchaseDate: text(row.purchase_date),
        supplier: text(row.supplier?.name),
        supplierInvoiceNo: text(row.supplier_invoice_no),
        status: text(row.status),
        paymentStatus: text(row.payment_status),
        currency: text(row.currency),
        subtotal: money(row.subtotal),
        tax: money(row.tax),
        discount: money(row.discount),
        otherCost: money(row.other_cost),
        total: money(row.total),
        amountPaid: money(row.amount_paid),
        balance: money(row.balance),
        receivedDate: text(row.received_date),
        notes: text(row.notes),
      })),
      consumed: rows.length,
    }
  },
}

// ---------------------------------------------------------------- suppliers

const suppliers = listSource({
  table: "pharmacy_suppliers",
  columns: "id, name, contact_person, phone, email, address, tax_number, is_active, created_at",
  orderBy: "name",
  map: (row) => ({
    name: text(row.name),
    contactPerson: text(row.contact_person),
    phone: text(row.phone),
    email: text(row.email),
    address: text(row.address),
    taxNumber: text(row.tax_number),
    isActive: row.is_active ? "Yes" : "No",
    createdAt: localDateTime(row.created_at),
  }),
})

// ---------------------------------------------------------------- products

const PRODUCT_COLUMNS: ExportColumn[] = [
  { key: "product", label: "Product" },
  { key: "sku", label: "SKU" },
  { key: "barcode", label: "Barcode" },
  { key: "category", label: "Category" },
  { key: "unit", label: "Unit" },
  { key: "strength", label: "Strength" },
  { key: "dosageForm", label: "Dosage Form" },
  { key: "price", label: "Price" },
  { key: "costPrice", label: "Cost Price" },
  { key: "batchNumber", label: "Batch No" },
  { key: "quantity", label: "Quantity" },
  { key: "expiryDate", label: "Expiry Date" },
  { key: "productActive", label: "Product Active" },
  { key: "batchActive", label: "Batch Active" },
]

// One row per batch, so stock is never a single aggregate somebody has to
// unpick later. A product with no batch rows still gets a row of its own,
// carrying the product-level quantity, rather than disappearing from the file.
const products: ExportSource = {
  count: (ctx) =>
    countRows(ctx.db.from("pharmacy_products").eq("tenant_id", ctx.tenantId).select("id", { head: true, count: "exact" })),
  page: async (ctx, offset, limit) => {
    const rows = await fetchRows(
      ctx.db
        .from("pharmacy_products")
        .eq("tenant_id", ctx.tenantId)
        .select(
          `id, name, sku, barcode, category, unit_of_measure, strength, dosage_form,
           price, cost_price, quantity, batch_number, expiry_date, is_active,
           pharmacy_product_batches(batch_number, quantity, expiry_date, cost_price, selling_price, is_active)`,
        )
        .order("name", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1),
    )

    const mapped: ExportRow[] = []
    for (const row of rows) {
      const batches = row.pharmacy_product_batches ?? []
      const shared = {
        product: text(row.name),
        sku: text(row.sku),
        barcode: text(row.barcode),
        category: text(row.category),
        unit: text(row.unit_of_measure),
        strength: text(row.strength),
        dosageForm: text(row.dosage_form),
        productActive: row.is_active ? "Yes" : "No",
      }
      if (batches.length === 0) {
        mapped.push({
          ...shared,
          price: moneyOrNull(row.price),
          costPrice: moneyOrNull(row.cost_price),
          batchNumber: text(row.batch_number),
          quantity: whole(row.quantity),
          expiryDate: text(row.expiry_date),
          batchActive: null,
        })
        continue
      }
      for (const batch of batches) {
        mapped.push({
          ...shared,
          price: moneyOrNull(batch.selling_price ?? row.price),
          costPrice: moneyOrNull(batch.cost_price ?? row.cost_price),
          batchNumber: text(batch.batch_number),
          quantity: whole(batch.quantity),
          expiryDate: text(batch.expiry_date),
          batchActive: batch.is_active ? "Yes" : "No",
        })
      }
    }
    return { rows: mapped, consumed: rows.length }
  },
}

// ---------------------------------------------------------------- stock adjustments

const STOCK_ADJUSTMENT_COLUMNS: ExportColumn[] = [
  { key: "date", label: "Date" },
  { key: "product", label: "Product" },
  { key: "sku", label: "SKU" },
  { key: "type", label: "Type" },
  { key: "quantity", label: "Change" },
  { key: "previousQty", label: "Previous Qty" },
  { key: "newQty", label: "New Qty" },
  { key: "reason", label: "Reason" },
]

const stockAdjustments = tableSource({
  table: "pharmacy_stock_adjustments",
  columns: "id, quantity, type, reason, previous_qty, new_qty, created_at, product:pharmacy_products(name, sku)",
  dateColumn: "created_at",
  orderBy: "created_at",
  map: (row) => [
    {
      date: localDateTime(row.created_at),
      product: text(row.product?.name),
      sku: text(row.product?.sku),
      type: text(row.type),
      quantity: whole(row.quantity),
      previousQty: whole(row.previous_qty),
      newQty: whole(row.new_qty),
      reason: text(row.reason),
    },
  ],
})

// ---------------------------------------------------------------- customers

const CUSTOMER_COLUMNS: ExportColumn[] = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "address", label: "Address" },
  { key: "isActive", label: "Active" },
  { key: "createdAt", label: "Created" },
]

// `password_hash` is deliberately absent: it must never leave the database.
const customers = listSource({
  table: "pharmacy_customers",
  columns: "id, name, phone, email, address, is_active, created_at",
  orderBy: "name",
  map: (row) => ({
    name: text(row.name),
    phone: text(row.phone),
    email: text(row.email),
    address: text(row.address),
    isActive: row.is_active ? "Yes" : "No",
    createdAt: localDateTime(row.created_at),
  }),
})

// ---------------------------------------------------------------- credit ledger

const CREDIT_COLUMNS: ExportColumn[] = [
  { key: "date", label: "Date" },
  { key: "customer", label: "Customer" },
  { key: "type", label: "Type" },
  { key: "amount", label: "Amount" },
  { key: "balanceAfter", label: "Balance After" },
  { key: "dueDate", label: "Due Date" },
  { key: "notes", label: "Notes" },
]

const creditLedger = tableSource({
  table: "pharmacy_credit_ledger",
  columns: "id, type, amount, balance_after, due_date, notes, created_at, customer:pharmacy_customers(name)",
  dateColumn: "created_at",
  orderBy: "created_at",
  map: (row) => [
    {
      date: localDateTime(row.created_at),
      customer: text(row.customer?.name),
      type: text(row.type),
      amount: money(row.amount),
      balanceAfter: money(row.balance_after),
      dueDate: text(row.due_date),
      notes: text(row.notes),
    },
  ],
})

// ---------------------------------------------------------------- registry

export const DATASETS: ExportDataset[] = [
  {
    id: "sales",
    label: "Sales & receipts",
    group: "Sales & receipts",
    description: "One row per sale or Till order, with its totals, payment method and cashier.",
    dateScoped: true,
    columns: SALE_COLUMNS,
    sources: [posSales, tillSales],
  },
  {
    id: "sale-lines",
    label: "Sale items",
    group: "Sales & receipts",
    description: "Every item sold, with the product, batch, price and line total.",
    dateScoped: true,
    columns: SALE_LINE_COLUMNS,
    sources: [posSaleLines, tillSaleLines],
  },
  {
    id: "purchases",
    label: "Purchases",
    group: "Purchases & suppliers",
    description: "One row per purchase order, with its supplier, totals and payment balance.",
    dateScoped: true,
    columns: PURCHASE_COLUMNS,
    sources: [purchases],
  },
  {
    id: "suppliers",
    label: "Suppliers",
    group: "Purchases & suppliers",
    description: "The supplier contact list.",
    dateScoped: false,
    columns: [
      { key: "name", label: "Name" },
      { key: "contactPerson", label: "Contact Person" },
      { key: "phone", label: "Phone" },
      { key: "email", label: "Email" },
      { key: "address", label: "Address" },
      { key: "taxNumber", label: "Tax Number" },
      { key: "isActive", label: "Active" },
      { key: "createdAt", label: "Created" },
    ],
    sources: [suppliers],
  },
  {
    id: "products",
    label: "Products & stock",
    group: "Inventory & stock",
    description: "One row per batch, so quantities, cost and expiry stay per batch. A product with no batches still gets a row.",
    dateScoped: false,
    columns: PRODUCT_COLUMNS,
    sources: [products],
  },
  {
    id: "stock-adjustments",
    label: "Stock adjustments",
    group: "Inventory & stock",
    description: "Every manual stock correction, with the quantity before and after.",
    dateScoped: true,
    columns: STOCK_ADJUSTMENT_COLUMNS,
    sources: [stockAdjustments],
  },
  {
    id: "customers",
    label: "Customers",
    group: "Customers & credit",
    description: "The customer contact list. Password data is never included.",
    dateScoped: false,
    columns: CUSTOMER_COLUMNS,
    sources: [customers],
  },
  {
    id: "credit-ledger",
    label: "Credit ledger",
    group: "Customers & credit",
    description: "Every credit and repayment, with the running balance.",
    dateScoped: true,
    columns: CREDIT_COLUMNS,
    sources: [creditLedger],
  },
]

export function findDataset(id: string): ExportDataset | undefined {
  return DATASETS.find((dataset) => dataset.id === id)
}

/** How many records each source of the dataset holds. */
export async function countDataset(dataset: ExportDataset, ctx: ExportContext): Promise<number[]> {
  const totals: number[] = []
  for (const source of dataset.sources) totals.push(await source.count(ctx))
  return totals
}

/**
 * Rows for [offset, offset + limit) of the dataset, walked across its sources
 * in order. `consumed` is how far to advance the offset: it counts the source
 * records read, which for a flattened dataset is fewer than the rows emitted.
 */
export async function readPage(
  dataset: ExportDataset,
  ctx: ExportContext,
  totals: number[],
  offset: number,
  limit: number,
): Promise<ExportPage> {
  const rows: ExportRow[] = []
  let skip = offset
  let consumed = 0

  for (let index = 0; index < dataset.sources.length && rows.length < limit; index++) {
    const total = totals[index] ?? 0
    if (skip >= total) {
      skip -= total
      continue
    }
    const page = await dataset.sources[index]!.page(ctx, skip, limit - rows.length)
    rows.push(...page.rows)
    consumed += page.consumed
    skip = 0
  }

  return { rows, consumed }
}
