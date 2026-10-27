/**
 * Pharmacy purchases domain.
 *
 * Purchase Orders remain the planned-order document.
 * pharmacy_purchases is the actual financial/receipt event for both
 * walk-in purchases and PO goods receipts.
 *
 * Inventory still enters only through receive_pharmacy_stock.
 */

import { receivePharmacyStock, type PharmacyRpcError } from "./inventory-rpc"

export const PURCHASE_PAYMENT_STATUSES = ["UNPAID", "PARTIAL", "PAID", "CREDIT"] as const
export type PurchasePaymentStatus = (typeof PURCHASE_PAYMENT_STATUSES)[number]

export const PURCHASE_STATUSES = ["DRAFT", "RECEIVED", "PARTIALLY_RECEIVED", "CANCELLED"] as const
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number]

export const PURCHASE_ATTACHMENT_KINDS = ["invoice", "receipt", "delivery_note"] as const
export type PurchaseAttachmentKind = (typeof PURCHASE_ATTACHMENT_KINDS)[number]

export function isPurchasePaymentStatus(value: string): value is PurchasePaymentStatus {
  return (PURCHASE_PAYMENT_STATUSES as readonly string[]).includes(value)
}

export function derivePaymentStatus(input: {
  total: number
  amountPaid: number
  explicit?: string | null
}): PurchasePaymentStatus {
  const explicit = input.explicit?.trim().toUpperCase() ?? ""
  if (explicit === "CREDIT") return "CREDIT"
  if (isPurchasePaymentStatus(explicit) && explicit !== "PARTIAL" && explicit !== "UNPAID" && explicit !== "PAID") {
    return explicit
  }
  const total = Math.max(0, Number(input.total) || 0)
  const paid = Math.max(0, Number(input.amountPaid) || 0)
  if (paid <= 0) return "UNPAID"
  if (total > 0 && paid + 0.0001 >= total) return "PAID"
  return "PARTIAL"
}

export function lineTotal(quantity: number, unitCost: number): number {
  return roundMoney(Math.max(0, Number(quantity) || 0) * Math.max(0, Number(unitCost) || 0))
}

export function roundMoney(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100
}

export function purchaseTotals(input: {
  lines: Array<{ quantity: number; unitCost: number }>
  tax?: number
  discount?: number
  otherCost?: number
}): { subtotal: number; tax: number; discount: number; otherCost: number; grandTotal: number } {
  const subtotal = roundMoney(input.lines.reduce((sum, line) => sum + lineTotal(line.quantity, line.unitCost), 0))
  const tax = roundMoney(Math.max(0, Number(input.tax) || 0))
  const discount = roundMoney(Math.max(0, Number(input.discount) || 0))
  const otherCost = roundMoney(Math.max(0, Number(input.otherCost) || 0))
  return {
    subtotal,
    tax,
    discount,
    otherCost,
    grandTotal: roundMoney(Math.max(0, subtotal + tax + otherCost - discount)),
  }
}

export function purchaseMargin(cost: number, selling: number): {
  cost: number
  selling: number
  profit: number
  marginPct: number | null
  markupPct: number | null
} {
  const c = Number(cost) || 0
  const s = Number(selling) || 0
  const profit = roundMoney(s - c)
  return {
    cost: roundMoney(c),
    selling: roundMoney(s),
    profit,
    marginPct: s > 0 ? roundMoney((profit / s) * 100) : null,
    markupPct: c > 0 ? roundMoney((profit / c) * 100) : null,
  }
}

export function generatePurchaseNo(now = Date.now()): string {
  const timestamp = now.toString(36).toUpperCase()
  const random = Math.random().toString(36).substring(2, 6).toUpperCase()
  return `PUR-${timestamp}-${random}`
}

export function generateProductSku(now = Date.now()): string {
  return `SKU-${now.toString(36).toUpperCase()}`
}

export type CatalogProduct = {
  id: string
  name: string
  sku?: string | null
  barcode?: string | null
  genericName?: string | null
  brandName?: string | null
  strength?: string | null
  dosageForm?: string | null
  manufacturer?: string | null
  price?: number | null
  costPrice?: number | null
  /** Current book stock (may be negative). */
  quantity?: number | null
}

export type ProductMatchQuery = {
  q?: string | null
  barcode?: string | null
  sku?: string | null
  name?: string | null
  genericName?: string | null
  brandName?: string | null
  strength?: string | null
  dosageForm?: string | null
  manufacturer?: string | null
}

function norm(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
}

function tokens(value: string): string[] {
  return value
    .split(/[^a-z0-9]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
}

export function scoreProductMatch(query: ProductMatchQuery, product: CatalogProduct): number {
  const barcode = norm(query.barcode ?? query.q)
  const sku = norm(query.sku ?? query.q)
  const hay = [
    product.name,
    product.genericName,
    product.brandName,
    product.sku,
    product.barcode,
    product.strength,
    product.dosageForm,
    product.manufacturer,
  ]
    .map(norm)
    .filter(Boolean)
    .join(" ")

  let score = 0
  if (barcode && norm(product.barcode) && barcode === norm(product.barcode)) score += 100
  if (sku && norm(product.sku) && sku === norm(product.sku)) score += 90

  const nameQ = norm(query.name ?? query.q)
  if (nameQ && norm(product.name) === nameQ) score += 70
  else if (nameQ && hay.includes(nameQ)) score += 40

  const genericQ = norm(query.genericName ?? query.q)
  if (genericQ && norm(product.genericName) === genericQ) score += 50
  else if (genericQ && hay.includes(genericQ)) score += 25

  const brandQ = norm(query.brandName)
  if (brandQ && (norm(product.brandName) === brandQ || norm(product.name) === brandQ)) score += 35

  const strengthQ = norm(query.strength)
  if (strengthQ && norm(product.strength) === strengthQ) score += 20

  const formQ = norm(query.dosageForm)
  if (formQ && norm(product.dosageForm) === formQ) score += 15

  const mfrQ = norm(query.manufacturer)
  if (mfrQ && norm(product.manufacturer) === mfrQ) score += 10

  const qTokens = tokens(query.q ?? query.name ?? "")
  if (qTokens.length > 0) {
    const hit = qTokens.filter((token) => hay.includes(token)).length
    score += Math.round((hit / qTokens.length) * 30)
  }

  return score
}

export function rankProductMatches(
  query: ProductMatchQuery,
  products: CatalogProduct[],
  limit = 8,
): Array<CatalogProduct & { score: number }> {
  const minScore = query.barcode?.trim() || query.sku?.trim() ? 40 : 25
  return products
    .map((product) => ({ ...product, score: scoreProductMatch(query, product) }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

export const DUPLICATE_PRODUCT_THRESHOLD = 70

export function findDuplicateProducts(
  draft: ProductMatchQuery,
  products: CatalogProduct[],
): Array<CatalogProduct & { score: number }> {
  return rankProductMatches(draft, products, 5).filter((row) => row.score >= DUPLICATE_PRODUCT_THRESHOLD)
}

/** Catalogue writes from Purchase never invent stock. Receipt creates the first batch. */
export function purchaseProductOpeningQuantity(_requested?: unknown): 0 {
  return 0
}

export function catalogProductFromRow(row: Record<string, unknown>): CatalogProduct {
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    sku: (row.sku as string | null) ?? null,
    barcode: (row.barcode as string | null) ?? null,
    genericName: (row.generic_name as string | null) ?? (row.genericName as string | null) ?? null,
    brandName: (row.brand as string | null) ?? (row.brandName as string | null) ?? (row.name as string | null) ?? null,
    strength: (row.strength as string | null) ?? null,
    dosageForm: (row.dosage_form as string | null) ?? (row.dosageForm as string | null) ?? null,
    manufacturer: (row.manufacturer as string | null) ?? null,
    price: row.price != null ? Number(row.price) : row.sellingPrice != null ? Number(row.sellingPrice) : null,
    costPrice: row.cost_price != null ? Number(row.cost_price) : row.costPrice != null ? Number(row.costPrice) : null,
    quantity: row.quantity != null ? Number(row.quantity) : null,
  }
}

export function matchCatalogProducts(
  query: ProductMatchQuery,
  rows: Array<Record<string, unknown>>,
  limit = 12,
): Array<CatalogProduct & { score: number; existing: true }> {
  return rankProductMatches(query, rows.map(catalogProductFromRow), limit).map((row) => ({
    ...row,
    existing: true as const,
  }))
}

/**
 * Import / migration matching: barcode ? SKU ? name.
 * Name matches MUST NOT silently merge clinically distinct products
 * (e.g. Amoxicillin 250 mg vs 500 mg) when strength or dosage form differ.
 */
export type ImportCatalogMatch =
  | { kind: "match"; product: CatalogProduct; via: "barcode" | "sku" | "name" }
  | { kind: "ambiguous_name"; candidates: CatalogProduct[] }
  | { kind: "none" }

function clinicalFieldsCompatible(
  incoming: { strength?: string | null; dosageForm?: string | null },
  existing: CatalogProduct,
): boolean {
  const inStrength = norm(incoming.strength)
  const exStrength = norm(existing.strength)
  if (inStrength && exStrength && inStrength !== exStrength) return false

  const inForm = norm(incoming.dosageForm)
  const exForm = norm(existing.dosageForm)
  if (inForm && exForm && inForm !== exForm) return false

  return true
}

export function resolveImportCatalogMatch(
  values: {
    barcode?: string | null
    sku?: string | null
    name?: string | null
    strength?: string | null
    dosageForm?: string | null
  },
  existingProducts: CatalogProduct[],
): ImportCatalogMatch {
  const barcode = values.barcode?.trim()
  if (barcode) {
    const match = existingProducts.find((p) => norm(p.barcode) === norm(barcode))
    if (match) return { kind: "match", product: match, via: "barcode" }
  }

  const sku = values.sku?.trim()
  if (sku) {
    const match = existingProducts.find((p) => norm(p.sku) === norm(sku))
    if (match) return { kind: "match", product: match, via: "sku" }
  }

  const name = values.name?.trim()
  if (!name) return { kind: "none" }

  const nameMatches = existingProducts.filter((p) => norm(p.name) === norm(name))
  if (nameMatches.length === 0) return { kind: "none" }

  const compatible = nameMatches.filter((p) => clinicalFieldsCompatible(values, p))
  const sole = compatible.length === 1 ? compatible[0] : undefined
  if (sole) {
    return { kind: "match", product: sole, via: "name" }
  }
  if (compatible.length === 0) {
    // Name collided with different strength/form - do not merge.
    return { kind: "ambiguous_name", candidates: nameMatches }
  }
  return { kind: "ambiguous_name", candidates: compatible }
}

/** Import quantity is always a receipt delta via receive_pharmacy_stock - never an absolute stock overwrite. */
export const IMPORT_QUANTITY_SEMANTICS = "STOCK_RECEIPT_DELTA" as const

export function allocatePurchaseIdempotencyKey(existing: string | null, randomUUID: () => string): string {
  const current = existing?.trim()
  return current ? current : randomUUID()
}

export type CreatedPurchaseProduct = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  price: number
  costPrice: number | null
  genericName: string | null
  strength: string | null
  dosageForm: string | null
  manufacturer: string | null
}

export type CreatePurchaseProductInput = {
  tenantId: string
  actorId: string
  name: string
  genericName?: string | null
  brand?: string | null
  strength?: string | null
  dosageForm?: string | null
  unit?: string | null
  barcode?: string | null
  sku?: string | null
  manufacturer?: string | null
  category?: string | null
  sellingPrice?: number | null
  costPrice?: number | null
  reorderLevel?: number | null
  expiryRequired?: boolean
  createAnyway?: boolean
  quantity?: unknown
}

export async function createPurchaseCatalogProduct(
  client: DbClient,
  input: CreatePurchaseProductInput,
): Promise<
  | { ok: true; product: CreatedPurchaseProduct; duplicateOverride: boolean }
  | { ok: false; code: "DUPLICATE_PRODUCT"; error: string; candidates: Array<CatalogProduct & { score: number }> }
  | { ok: false; code: "NAME_REQUIRED" | "SKU_EXISTS" | "BARCODE_EXISTS" | "CATALOG_LOOKUP" | "PRODUCT_CREATE"; error: string }
> {
  const name = String(input.name ?? "").trim()
  if (!name) return { ok: false, code: "NAME_REQUIRED", error: "Product name is required" }

  const catalog = await client
    .from("pharmacy_products")
    .select(
      "id, name, sku, barcode, generic_name, strength, dosage_form, manufacturer, price, cost_price, unit_of_measure, category, reorder_level",
    )
    .eq("tenant_id", input.tenantId)
    .eq("is_active", true)
    .limit(2000)
  if (catalog.error) return { ok: false, code: "CATALOG_LOOKUP", error: catalog.error.message }
  const rows = (catalog.data ?? []) as Array<Record<string, unknown>>
  const products = rows.map(catalogProductFromRow)
  const candidates = findDuplicateProducts(
    {
      q: name,
      name,
      genericName: input.genericName ?? null,
      brandName: input.brand ?? name,
      barcode: input.barcode ?? null,
      sku: input.sku ?? null,
      strength: input.strength ?? null,
      dosageForm: input.dosageForm ?? null,
      manufacturer: input.manufacturer ?? null,
    },
    products,
  )

  if (candidates.length > 0 && input.createAnyway !== true) {
    return {
      ok: false,
      code: "DUPLICATE_PRODUCT",
      error: "A similar product already exists.",
      candidates,
    }
  }

  // A barcode identifies exactly one product per pharmacy; createAnyway may override a
  // fuzzy name match but never an exact barcode match (scanning must be unambiguous).
  const barcodeIn = String(input.barcode ?? "").trim()
  if (barcodeIn && products.some((p) => String(p.barcode ?? "").trim() === barcodeIn)) {
    return { ok: false, code: "BARCODE_EXISTS", error: "A product with this barcode already exists" }
  }

  const sku = String(input.sku ?? "").trim() || generateProductSku()
  const existingSku = await client
    .from("pharmacy_products")
    .select("id")
    .eq("tenant_id", input.tenantId)
    .eq("sku", sku)
    .maybeSingle()
  if (existingSku.data) return { ok: false, code: "SKU_EXISTS", error: "Product with this SKU already exists" }

  const inserted = await client
    .from("pharmacy_products")
    .insert({
      tenant_id: input.tenantId,
      name,
      sku,
      barcode: String(input.barcode ?? "").trim() || null,
      category: String(input.category ?? "General"),
      price: Number(input.sellingPrice ?? 0),
      cost_price: Number(input.costPrice ?? 0),
      quantity: purchaseProductOpeningQuantity(input.quantity),
      reorder_level: Number(input.reorderLevel ?? 10),
      unit_of_measure: String(input.unit ?? "Tablet"),
      manufacturer: String(input.manufacturer ?? "").trim() || null,
      strength: String(input.strength ?? "").trim() || null,
      dosage_form: String(input.dosageForm ?? "").trim() || null,
      generic_name: String(input.genericName ?? "").trim() || null,
      expiry_required: input.expiryRequired === false ? false : true,
    })
    .select()
    .single()

  if (inserted.error || !inserted.data) {
    return { ok: false, code: "PRODUCT_CREATE", error: inserted.error?.message ?? "Failed to create product" }
  }

  const product = inserted.data as Record<string, unknown>
  const duplicateOverride = input.createAnyway === true
  await client.from("pharmacy_audit_logs").insert({
    tenant_id: input.tenantId,
    profile_id: input.actorId,
    action: duplicateOverride ? "product.created_duplicate_override" : "product.created_from_purchase",
    entity: "PRODUCT",
    entity_id: product.id,
    details: JSON.stringify({
      name,
      sku,
      barcode: product.barcode ?? null,
      duplicateOverride,
      candidates: candidates.map((c) => ({ id: c.id, name: c.name, score: c.score })),
    }),
  })

  return {
    ok: true,
    duplicateOverride,
    product: {
      id: String(product.id),
      name: String(product.name ?? name),
      sku: (product.sku as string | null) ?? sku,
      barcode: (product.barcode as string | null) ?? null,
      price: Number(product.price ?? 0),
      costPrice: product.cost_price != null ? Number(product.cost_price) : null,
      genericName: (product.generic_name as string | null) ?? null,
      strength: (product.strength as string | null) ?? null,
      dosageForm: (product.dosage_form as string | null) ?? null,
      manufacturer: (product.manufacturer as string | null) ?? null,
    },
  }
}

export function poStatusFromReceived(ordered: number, received: number): "RECEIVED" | "PARTIALLY_RECEIVED" | "ORDERED" {
  if (received <= 0) return "ORDERED"
  if (received + 0.0001 >= ordered) return "RECEIVED"
  return "PARTIALLY_RECEIVED"
}

export function mapPoStatusToExisting(status: string): string {
  if (status === "ORDERED") return "SENT"
  return status
}

export type ReceivePurchaseLine = {
  clientItemId?: string | null
  productId: string
  productName: string
  quantity: number
  unitCost: number
  purchaseUnit?: string | null
  batchNumber: string
  expiryDate: string
  manufactureDate?: string | null
  sellingPrice?: number | null
  updateSellingPrice?: boolean
  supplierProductRef?: string | null
  purchaseOrderItemId?: string | null
}

export type ReceivePurchaseInput = {
  tenantId: string
  actorId: string
  storeId?: string | null
  supplierId: string
  supplierInvoiceNo?: string | null
  supplierReceiptRef?: string | null
  purchaseDate?: string | null
  receivedDate?: string | null
  paymentStatus?: string | null
  paymentMethod?: string | null
  currency?: string | null
  amountPaid?: number | null
  tax?: number | null
  discount?: number | null
  otherCost?: number | null
  notes?: string | null
  purchaseOrderId?: string | null
  idempotencyKey: string
  receiveNow?: boolean
  lines: ReceivePurchaseLine[]
}

export type ReceivePurchaseResult = {
  ok: true
  replay?: boolean
  purchaseId: string
  purchaseNo: string
  status: PurchaseStatus
  paymentStatus: PurchasePaymentStatus
  grandTotal: number
  amountPaid: number
  balance: number
  received: Array<{ productId: string; batchId: string; quantity: number; purchaseItemId: string }>
}

type DbClient = {
  // Injected client: supabase-js in production, an in-memory PostgREST fake in
  // tests. Row shapes differ per table and are annotated at each call site.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from: (table: string) => any
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

function asError(message: string, code = "INVALID"): { ok: false; error: string; code: string } {
  return { ok: false, error: message, code }
}

export async function receivePharmacyPurchase(
  client: DbClient,
  input: ReceivePurchaseInput,
): Promise<ReceivePurchaseResult | { ok: false; error: string; code: string; detail?: string }> {
  const tenantId = input.tenantId
  const actorId = input.actorId
  const idempotencyKey = input.idempotencyKey.trim()
  if (!idempotencyKey) return asError("Idempotency key is required", "IDEMPOTENCY_KEY_REQUIRED")
  if (!input.supplierId) return asError("Supplier is required", "SUPPLIER_REQUIRED")
  if (!input.lines?.length) return asError("At least one purchase line is required", "LINES_REQUIRED")

  for (const line of input.lines) {
    if (!line.productId) return asError("Each line must match or create a catalog product", "PRODUCT_REQUIRED")
    if (!(Number(line.quantity) > 0)) return asError("Quantity must be greater than 0", "INVALID_QUANTITY")
    if (!line.batchNumber?.trim()) return asError("Batch number is required", "REQUIRES_BATCH")
    if (!line.expiryDate?.trim()) return asError("Expiry date is required", "REQUIRES_EXPIRY")
    if (!(Number(line.unitCost) >= 0)) return asError("Cost price is required", "REQUIRES_COST")
  }

  const prior = await client
    .from("pharmacy_purchase_idempotency")
    .select("purchase_id, response")
    .eq("tenant_id", tenantId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()
  if (prior.error && !String(prior.error.message ?? "").includes("does not exist")) {
    return asError("Unable to check purchase idempotency", "IDEMPOTENCY_LOOKUP")
  }
  const priorResponse = prior.data?.response as ReceivePurchaseResult | { ok?: boolean } | null
  if (prior.data?.purchase_id && priorResponse && "ok" in priorResponse && priorResponse.ok) {
    return { replay: true, ...(priorResponse as ReceivePurchaseResult) }
  }

  const { data: supplier, error: supplierError } = await client
    .from("pharmacy_suppliers")
    .select("id, name")
    .eq("id", input.supplierId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (supplierError) return asError(supplierError.message, "SUPPLIER_LOOKUP")
  if (!supplier) return asError("Supplier not found", "SUPPLIER_NOT_FOUND")

  if (input.purchaseOrderId) {
    const { data: po } = await client
      .from("pharmacy_purchase_orders")
      .select("id, status")
      .eq("id", input.purchaseOrderId)
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (!po) return asError("Purchase order not found", "PO_NOT_FOUND")
    if (po.status === "CANCELLED") return asError("Cannot receive a cancelled purchase order", "PO_CANCELLED")
  }

  const totals = purchaseTotals({
    lines: input.lines.map((line) => ({ quantity: line.quantity, unitCost: line.unitCost })),
    tax: Number(input.tax ?? 0),
    discount: Number(input.discount ?? 0),
    otherCost: Number(input.otherCost ?? 0),
  })
  const amountPaid = roundMoney(Math.max(0, Number(input.amountPaid) || 0))
  const paymentStatus = derivePaymentStatus({
    total: totals.grandTotal,
    amountPaid,
    explicit: input.paymentStatus,
  })
  const purchaseNo = generatePurchaseNo()
  const receiveNow = input.receiveNow !== false

  let purchase: { id: string; purchase_no: string } | null = null
  let insertedItems: Array<{
    id: string
    product_id: string
    quantity: number
    received_quantity?: number
    unit_cost: number
    batch_number: string
    expiry_date: string
    selling_price: number | null
    receipt_idempotency_key: string | null
    purchase_order_item_id: string | null
  }> | null = null

  if (prior.data?.purchase_id) {
    const existing = await client
      .from("pharmacy_purchases")
      .select("id, purchase_no, status")
      .eq("id", prior.data.purchase_id)
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (existing.data?.id) {
      purchase = { id: existing.data.id, purchase_no: existing.data.purchase_no }
      const existingItems = await client
        .from("pharmacy_purchase_items")
        .select(
          "id, product_id, quantity, received_quantity, unit_cost, batch_number, expiry_date, selling_price, receipt_idempotency_key, purchase_order_item_id",
        )
        .eq("purchase_id", existing.data.id)
        .eq("tenant_id", tenantId)
      insertedItems = existingItems.data ?? []
    }
  }

  if (!purchase) {
    const created = await client
      .from("pharmacy_purchases")
      .insert({
        tenant_id: tenantId,
        purchase_no: purchaseNo,
        supplier_id: input.supplierId,
        purchase_order_id: input.purchaseOrderId ?? null,
        store_id: input.storeId ?? null,
        supplier_invoice_no: input.supplierInvoiceNo?.trim() || null,
        supplier_receipt_ref: input.supplierReceiptRef?.trim() || null,
        purchase_date: (input.purchaseDate || new Date().toISOString()).slice(0, 10),
        received_date: receiveNow
          ? (input.receivedDate || new Date().toISOString()).slice(0, 10)
          : input.receivedDate?.slice(0, 10) ?? null,
        payment_status: paymentStatus,
        payment_method: input.paymentMethod?.trim() || null,
        currency: input.currency?.trim() || "UGX",
        subtotal: totals.subtotal,
        tax: totals.tax,
        discount: totals.discount,
        other_cost: totals.otherCost,
        total: totals.grandTotal,
        amount_paid: amountPaid,
        balance: roundMoney(Math.max(0, totals.grandTotal - amountPaid)),
        notes: input.notes?.trim() || null,
        status: "DRAFT",
        created_by: actorId,
        received_by: receiveNow ? actorId : null,
      })
      .select("id, purchase_no")
      .single()

    if (created.error || !created.data) {
      return asError(created.error?.message ?? "Failed to create purchase", "PURCHASE_CREATE")
    }
    const createdPurchase = created.data
    purchase = createdPurchase

    await client.from("pharmacy_purchase_idempotency").upsert(
      {
        tenant_id: tenantId,
        idempotency_key: idempotencyKey,
        purchase_id: createdPurchase.id,
        response: { ok: false, purchaseId: createdPurchase.id, purchaseNo: createdPurchase.purchase_no },
      },
      { onConflict: "tenant_id,idempotency_key" },
    )
  }

  if (!purchase) return asError("Failed to create purchase", "PURCHASE_CREATE")
  const purchaseRow = purchase

  const itemRows = input.lines.map((line) => ({
    tenant_id: tenantId,
    purchase_id: purchaseRow.id,
    purchase_order_item_id: line.purchaseOrderItemId ?? null,
    product_id: line.productId,
    product_name: line.productName,
    quantity: Math.trunc(Number(line.quantity)),
    received_quantity: 0,
    purchase_unit: line.purchaseUnit?.trim() || null,
    unit_cost: line.unitCost,
    line_total: lineTotal(line.quantity, line.unitCost),
    batch_number: line.batchNumber.trim(),
    expiry_date: line.expiryDate.slice(0, 10),
    manufacture_date: line.manufactureDate?.slice(0, 10) || null,
    selling_price: line.sellingPrice ?? null,
    supplier_product_ref: line.supplierProductRef?.trim() || null,
    receipt_idempotency_key: `${idempotencyKey}:${line.clientItemId ?? line.productId}:${line.batchNumber.trim()}`,
  }))

  if (!insertedItems?.length) {
    const inserted = await client
      .from("pharmacy_purchase_items")
      .insert(itemRows)
      .select(
        "id, product_id, quantity, received_quantity, unit_cost, batch_number, expiry_date, selling_price, receipt_idempotency_key, purchase_order_item_id",
      )

    if (inserted.error || !inserted.data) {
      const conflict = String(inserted.error?.message ?? "").toLowerCase().includes("duplicate")
      if (conflict) {
        const existingItems = await client
          .from("pharmacy_purchase_items")
          .select(
            "id, product_id, quantity, received_quantity, unit_cost, batch_number, expiry_date, selling_price, receipt_idempotency_key, purchase_order_item_id",
          )
          .eq("purchase_id", purchaseRow.id)
          .eq("tenant_id", tenantId)
        insertedItems = existingItems.data ?? []
      } else {
        await client.from("pharmacy_purchases").delete().eq("id", purchaseRow.id).eq("tenant_id", tenantId)
        return asError(inserted.error?.message ?? "Failed to create purchase items", "PURCHASE_ITEMS")
      }
    } else {
      insertedItems = inserted.data
    }
  }

  if (!insertedItems) return asError("Failed to create purchase items", "PURCHASE_ITEMS")

  const received: ReceivePurchaseResult["received"] = []
  if (receiveNow) {
    for (let i = 0; i < insertedItems.length; i += 1) {
      const item = insertedItems[i]!
      const line = input.lines[i] ?? input.lines.find((candidate) => candidate.productId === item.product_id)
      if (!line) continue
      if (Number(item.received_quantity ?? 0) >= Number(item.quantity)) {
        received.push({
          productId: item.product_id,
          batchId: "",
          quantity: item.quantity,
          purchaseItemId: item.id,
        })
        continue
      }
      const existingBatch = await client
        .from("pharmacy_product_batches")
        .select("id, cost_price")
        .eq("tenant_id", tenantId)
        .eq("product_id", item.product_id)
        .eq("batch_number", item.batch_number)
        .eq("expiry_date", item.expiry_date)
        .maybeSingle()

      const preserveHistoricalCost =
        existingBatch.data?.id &&
        existingBatch.data.cost_price != null &&
        Number(line.unitCost) !== Number(existingBatch.data.cost_price)

      const { data, error } = await receivePharmacyStock(client, {
        tenantId,
        productId: item.product_id,
        batchNumber: item.batch_number,
        quantity: item.quantity,
        expiryDate: item.expiry_date,
        costPrice: preserveHistoricalCost ? null : line.unitCost,
        sellingPrice: line.updateSellingPrice ? line.sellingPrice ?? null : null,
        receivedBy: actorId,
        supplierId: input.supplierId,
        supplierRef: input.supplierInvoiceNo || purchase.purchase_no,
        purchaseOrderId: input.purchaseOrderId ?? null,
        storeId: input.storeId ?? null,
        reason: `Purchase ${purchase.purchase_no}`,
      })
      if (error) {
        await markPurchaseStatus(client, tenantId, purchase.id, received.length > 0 ? "PARTIALLY_RECEIVED" : "DRAFT")
        return {
          ok: false,
          error: error.humanMessage,
          code: error.code,
          detail: error.message,
        }
      }
      await client
        .from("pharmacy_purchase_items")
        .update({
          received_quantity: item.quantity,
          batch_id: data?.batchId ?? existingBatch.data?.id ?? null,
        })
        .eq("id", item.id)
        .eq("tenant_id", tenantId)

      if (item.purchase_order_item_id) {
        await incrementPoItemReceived(client, tenantId, item.purchase_order_item_id, item.quantity)
      }

      received.push({
        productId: item.product_id,
        batchId: data?.batchId ?? "",
        quantity: item.quantity,
        purchaseItemId: item.id,
      })
    }

    await markPurchaseStatus(client, tenantId, purchase.id, "RECEIVED", actorId)
    if (input.purchaseOrderId) {
      await refreshPurchaseOrderStatus(client, tenantId, input.purchaseOrderId)
    }
  }

  const result: ReceivePurchaseResult = {
    ok: true,
    purchaseId: purchase.id,
    purchaseNo: purchase.purchase_no,
    status: receiveNow ? "RECEIVED" : "DRAFT",
    paymentStatus,
    grandTotal: totals.grandTotal,
    amountPaid,
    balance: roundMoney(Math.max(0, totals.grandTotal - amountPaid)),
    received,
  }

  await client.from("pharmacy_purchase_idempotency").upsert(
    {
      tenant_id: tenantId,
      idempotency_key: idempotencyKey,
      purchase_id: purchase.id,
      response: result,
    },
    { onConflict: "tenant_id,idempotency_key" },
  )

  await client.from("pharmacy_audit_logs").insert({
    tenant_id: tenantId,
    profile_id: actorId,
    action: receiveNow ? "purchase.received" : "purchase.created",
    entity: "PURCHASE",
    entity_id: purchase.id,
    details: JSON.stringify({
      purchase_no: purchase.purchase_no,
      supplier_id: input.supplierId,
      invoice: input.supplierInvoiceNo ?? null,
      items: input.lines.length,
      total: totals.grandTotal,
      payment_status: paymentStatus,
    }),
  })

  return result
}

async function markPurchaseStatus(
  client: DbClient,
  tenantId: string,
  purchaseId: string,
  status: PurchaseStatus,
  receivedBy?: string,
) {
  await client
    .from("pharmacy_purchases")
    .update({
      status,
      ...(receivedBy
        ? { received_by: receivedBy, received_date: new Date().toISOString().slice(0, 10) }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("id", purchaseId)
    .eq("tenant_id", tenantId)
}

async function incrementPoItemReceived(
  client: DbClient,
  tenantId: string,
  poItemId: string,
  quantity: number,
) {
  const { data: item } = await client
    .from("pharmacy_purchase_order_items")
    .select("id, received_quantity")
    .eq("id", poItemId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (!item) return
  await client
    .from("pharmacy_purchase_order_items")
    .update({ received_quantity: Number(item.received_quantity ?? 0) + quantity })
    .eq("id", poItemId)
    .eq("tenant_id", tenantId)
}

async function refreshPurchaseOrderStatus(client: DbClient, tenantId: string, purchaseOrderId: string) {
  const { data: items } = await client
    .from("pharmacy_purchase_order_items")
    .select("quantity, received_quantity")
    .eq("purchase_order_id", purchaseOrderId)
    .eq("tenant_id", tenantId)
  const ordered = (items ?? []).reduce((sum: number, row: { quantity?: number }) => sum + Number(row.quantity ?? 0), 0)
  const received = (items ?? []).reduce(
    (sum: number, row: { received_quantity?: number }) => sum + Number(row.received_quantity ?? 0),
    0,
  )
  const mapped = mapPoStatusToExisting(poStatusFromReceived(ordered, received))
  await client
    .from("pharmacy_purchase_orders")
    .update({ status: mapped, updated_at: new Date().toISOString() })
    .eq("id", purchaseOrderId)
    .eq("tenant_id", tenantId)
}

export type { PharmacyRpcError }
