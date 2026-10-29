/**
 * Resumable Tally cut-over apply.
 *
 * Each call does one bounded unit of work and returns the next checkpoint, so a
 * large export never depends on one long request. Every write is idempotent:
 * journals key on (source_type, source_id), mirrors on their document number,
 * and opening batches are checked before the receiving RPC (which tops up).
 */

import { receivePharmacyStock, parsePharmacyRpcError } from "@synapse/db/inventory-rpc"
import type {
  TallyCutoverPlan,
  TallyCutoverPurchase,
  TallyCutoverSale,
  TallyCutoverVoucher,
} from "@synapse/db/tally-normalise"
import {
  TALLY_APPLY_CHUNK,
  TALLY_MIRROR_NOTE_PREFIX,
  isTallyMirrorNote,
  type TallyApplyDb,
} from "./types"

export type TallyApplyStage =
  | "accounts"
  | "parties"
  | "products"
  | "opening-journal"
  | "opening-stock"
  | "journals"
  | "complete"

export const TALLY_STAGE_ORDER: TallyApplyStage[] = [
  "accounts",
  "parties",
  "products",
  "opening-journal",
  "opening-stock",
  "journals",
  "complete",
]

export type TallyApplyCounts = {
  accounts: number
  parties: number
  products: number
  openingJournal: number
  openingStock: number
  journals: number
  sales: number
  purchases: number
}

export type TallyApplyFailure = {
  stage: TallyApplyStage
  key: string
  code: string
  message: string
}

export type TallyApplyProgress = {
  stage: TallyApplyStage
  offset: number
  counts: TallyApplyCounts
  failures: TallyApplyFailure[]
  startedAt: string
  updatedAt: string
}

export type TallyApplyChunkResult = {
  progress: TallyApplyProgress
  done: boolean
  message?: string
}

const MAX_FAILURES = 200
const INSERT_BATCH = 200

export function emptyProgress(now = new Date().toISOString()): TallyApplyProgress {
  return {
    stage: "accounts",
    offset: 0,
    counts: {
      accounts: 0,
      parties: 0,
      products: 0,
      openingJournal: 0,
      openingStock: 0,
      journals: 0,
      sales: 0,
      purchases: 0,
    },
    failures: [],
    startedAt: now,
    updatedAt: now,
  }
}

class Progress {
  constructor(readonly value: TallyApplyProgress) {}

  fail(stage: TallyApplyStage, key: string, code: string, message: string) {
    if (this.value.failures.length >= MAX_FAILURES) return
    const duplicate = this.value.failures.some(
      (failure) => failure.stage === stage && failure.key === key && failure.code === code,
    )
    if (duplicate) return
    this.value.failures.push({ stage, key, code, message })
  }

  advance(stage: TallyApplyStage, offset = 0) {
    this.value.stage = stage
    this.value.offset = offset
    this.value.updatedAt = new Date().toISOString()
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

// Tally exports calendar dates with no offset but the mirrors land in
// timestamptz columns, so the offset has to be stated. The portal, the sale
// RPC and the ledger all read the business day as Africa/Kampala, which is
// UTC+3 year-round — the same zone the accounting migrations hardcode.
const KAMPALA_UTC_OFFSET = "+03:00"

function isoDateTime(date: string): string {
  return `${date}T00:00:00${KAMPALA_UTC_OFFSET}`
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

type IdMaps = {
  accounts: Map<string, string>
  productsBySku: Map<string, string>
  productsByName: Map<string, string>
  customers: Map<string, string>
  suppliers: Map<string, string>
}

async function loadAccounts(db: TallyApplyDb, tenantId: string): Promise<Map<string, string>> {
  const { data } = await db
    .from("pharmacy_accounting_accounts")
    .select("id, code")
    .eq("tenant_id", tenantId)
  const map = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ id: string; code: string }>) {
    map.set(row.code, row.id)
  }
  return map
}

async function loadProducts(db: TallyApplyDb, tenantId: string): Promise<{ bySku: Map<string, string>; byName: Map<string, string> }> {
  const { data } = await db
    .from("pharmacy_products")
    .select("id, sku, name")
    .eq("tenant_id", tenantId)
  const bySku = new Map<string, string>()
  const byName = new Map<string, string>()
  for (const row of (data ?? []) as Array<{ id: string; sku: string; name: string }>) {
    bySku.set(row.sku.toLowerCase(), row.id)
    byName.set(row.name.trim().toLowerCase(), row.id)
  }
  return { bySku, byName }
}

async function loadParties(db: TallyApplyDb, tenantId: string): Promise<{ customers: Map<string, string>; suppliers: Map<string, string> }> {
  const [customers, suppliers] = await Promise.all([
    db.from("pharmacy_customers").select("id, name").eq("tenant_id", tenantId),
    db.from("pharmacy_suppliers").select("id, name").eq("tenant_id", tenantId),
  ])
  const toMap = (rows: unknown) => {
    const map = new Map<string, string>()
    for (const row of (rows ?? []) as Array<{ id: string; name: string }>) {
      map.set(row.name.trim().toLowerCase(), row.id)
    }
    return map
  }
  return { customers: toMap(customers.data), suppliers: toMap(suppliers.data) }
}

async function findByName(
  db: TallyApplyDb,
  table: "pharmacy_customers" | "pharmacy_suppliers" | "pharmacy_products",
  tenantId: string,
  name: string,
): Promise<string | null> {
  const { data } = await db
    .from(table)
    .select("id")
    .eq("tenant_id", tenantId)
    .ilike("name", escapeLike(name.trim()))
    .limit(1)
  return ((data ?? []) as Array<{ id: string }>)[0]?.id ?? null
}

async function insertIgnore(
  db: TallyApplyDb,
  table: string,
  rows: Array<Record<string, unknown>>,
  onConflict: string,
): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return []
  const { data, error } = await db
    .from(table)
    .upsert(rows, { onConflict, ignoreDuplicates: true })
    .select()
  if (error) throw new Error(error.message)
  return (data ?? []) as Array<Record<string, unknown>>
}

async function findRow(
  db: TallyApplyDb,
  table: string,
  filters: Record<string, string>,
): Promise<{ id: string; notes?: string | null } | null> {
  let query = db.from(table).select("id, notes")
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
  const { data } = await query.limit(1)
  return ((data ?? []) as Array<{ id: string; notes?: string | null }>)[0] ?? null
}

async function childRowsExist(
  db: TallyApplyDb,
  table: string,
  column: string,
  id: string,
): Promise<{ exists: boolean; error?: string }> {
  const { data, error } = await db.from(table).select("id").eq(column, id).limit(1)
  if (error) return { exists: false, error: error.message }
  return { exists: ((data ?? []) as unknown[]).length > 0 }
}

async function postJournal(
  db: TallyApplyDb,
  input: {
    tenantId: string
    sourceType: string
    sourceId: string
    date: string
    description: string
    currency: string
    actorId: string
    lines: Array<{ accountCode: string; debit: number; credit: number; description?: string }>
    accounts: Map<string, string>
    stage: TallyApplyStage
    progress: Progress
  },
): Promise<boolean> {
  const lines = input.lines
    .filter((line) => line.debit > 0 || line.credit > 0)
    .map((line) => {
      const accountId = input.accounts.get(line.accountCode)
      return accountId
        ? {
            account_id: accountId,
            debit: money(line.debit),
            credit: money(line.credit),
            description: line.description ?? null,
          }
        : null
    })
  if (lines.some((line) => line === null) || lines.length < 2) {
    input.progress.fail(
      input.stage,
      input.sourceId,
      "ACCOUNT_NOT_MAPPED",
      "A journal line uses an account code that is not in this pharmacy's chart of accounts.",
    )
    return false
  }

  const debit = lines.reduce((total, line) => total + (line?.debit ?? 0), 0)
  const credit = lines.reduce((total, line) => total + (line?.credit ?? 0), 0)
  if (Math.round(debit * 100) !== Math.round(credit * 100) || debit <= 0) {
    input.progress.fail(
      input.stage,
      input.sourceId,
      "ACCOUNTING_UNBALANCED",
      `Journal does not balance (debit ${money(debit)}, credit ${money(credit)}).`,
    )
    return false
  }

  const { error } = await db.rpc("post_pharmacy_accounting_journal", {
    p_tenant_id: input.tenantId,
    p_source_type: input.sourceType,
    p_source_id: input.sourceId,
    p_entry_date: input.date,
    p_description: input.description,
    p_currency: input.currency,
    p_created_by: input.actorId,
    p_lines: lines,
  })
  if (error) {
    const parsed = parsePharmacyRpcError(error.message)
    input.progress.fail(input.stage, input.sourceId, parsed.code, parsed.humanMessage)
    return false
  }
  return true
}

async function stageAccounts(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  progress: Progress,
): Promise<void> {
  // Seed the system chart first. A Tally ledger mapped to a system account
  // carries that account's seeded code, so inserting it before the seed would
  // leave a row on `unique (tenant_id, code)` that the seeder's system-key
  // conflict clause cannot absorb — and every later journal post reseeds.
  const seeded = await db.rpc("seed_pharmacy_accounting_accounts", { p_tenant_id: tenantId })
  if (seeded.error) throw new Error(seeded.error.message)

  const accounts = await loadAccounts(db, tenantId)
  const existing = new Set(accounts.keys())
  const missing = plan.accounts.filter((account) => !existing.has(account.code))
  for (let index = 0; index < missing.length; index += INSERT_BATCH) {
    const batch = missing.slice(index, index + INSERT_BATCH).map((account) => ({
      tenant_id: tenantId,
      code: account.code,
      name: account.name,
      account_type: account.accountType,
      normal_balance: account.normalBalance,
      system_key: null,
      is_system: false,
      is_active: true,
    }))
    const { error } = await db.from("pharmacy_accounting_accounts").insert(batch)
    if (error && !/duplicate|unique/i.test(error.message)) {
      throw new Error(error.message)
    }
    progress.value.counts.accounts += batch.length
  }
}

async function stageParties(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  progress: Progress,
): Promise<void> {
  const known = await loadParties(db, tenantId)
  for (const party of plan.parties) {
    const key = party.name.trim().toLowerCase()
    const map = party.kind === "customer" ? known.customers : known.suppliers
    if (map.has(key)) continue
    const table = party.kind === "customer" ? "pharmacy_customers" : "pharmacy_suppliers"
    const existingId = await findByName(db, table, tenantId, party.name)
    if (existingId) {
      map.set(key, existingId)
      continue
    }
    const { data, error } = await db
      .from(table)
      .insert({
        tenant_id: tenantId,
        name: party.name,
        email: party.email ?? null,
        phone: party.phone ?? null,
        address: party.address ?? null,
        is_active: true,
      })
      .select("id")
      .single()
    if (error || !data) {
      progress.fail("parties", party.name, "PARTY_CREATE_FAILED", error?.message ?? "Insert failed")
      continue
    }
    map.set(key, (data as { id: string }).id)
    progress.value.counts.parties += 1
  }
}

async function stageProducts(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  progress: Progress,
): Promise<void> {
  const known = await loadProducts(db, tenantId)
  for (const item of plan.stockItems) {
    const sku = item.sku.trim().toLowerCase()
    if (known.bySku.has(sku)) continue
    const existingId = await findByName(db, "pharmacy_products", tenantId, item.name)
    if (existingId) {
      known.bySku.set(sku, existingId)
      known.byName.set(item.name.trim().toLowerCase(), existingId)
      continue
    }
    // Tally exports cost, never a selling price. Cost is the only honest
    // placeholder; the portal marks these products as needing a price.
    const cost = money(item.rate ?? (item.value !== undefined && item.quantity ? item.value / item.quantity : 0))
    const { data, error } = await db
      .from("pharmacy_products")
      .insert({
        tenant_id: tenantId,
        name: item.name,
        sku: item.sku,
        category: "General",
        price: cost,
        cost_price: cost,
        quantity: 0,
        unit_of_measure: item.unit ?? "Tablet",
        is_active: true,
      })
      .select("id")
      .single()
    if (error || !data) {
      progress.fail("products", item.sku, "PRODUCT_CREATE_FAILED", error?.message ?? "Insert failed")
      continue
    }
    known.bySku.set(sku, (data as { id: string }).id)
    known.byName.set(item.name.trim().toLowerCase(), (data as { id: string }).id)
    progress.value.counts.products += 1
  }
}

async function stageOpeningJournal(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  actorId: string,
  progress: Progress,
): Promise<boolean> {
  if (plan.opening.difference !== 0) {
    progress.fail(
      "opening-journal",
      plan.conversionDate,
      "OPENING_DIFFERENCE",
      `Opening balances differ by ${money(plan.opening.difference)}. Correct the export or mappings; nothing is plugged.`,
    )
    return false
  }
  if (plan.opening.lines.length === 0) return true

  const accounts = await loadAccounts(db, tenantId)
  const posted = await postJournal(db, {
    tenantId,
    sourceType: "tally_opening",
    sourceId: `${plan.companyKey}:opening:${plan.conversionDate}`,
    date: plan.conversionDate,
    description: `Tally opening balances (${plan.company ?? "import"})`,
    currency: plan.currency,
    actorId,
    lines: plan.opening.lines,
    accounts,
    stage: "opening-journal",
    progress,
  })
  if (posted) progress.value.counts.openingJournal = plan.opening.lines.length
  return posted
}

async function stageOpeningStock(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  actorId: string,
  progress: Progress,
): Promise<number> {
  const products = await loadProducts(db, tenantId)
  let received = 0

  for (const item of plan.stockItems) {
    const productId =
      products.bySku.get(item.sku.trim().toLowerCase()) ??
      products.byName.get(item.name.trim().toLowerCase())
    if (!productId) {
      progress.fail("opening-stock", item.sku, "PRODUCT_MISSING", "Product was not created; no stock received.")
      continue
    }
    let batchIndex = 0
    for (const batch of item.batches) {
      if (!batch.receivable) continue
      batchIndex += 1
      const batchNumber =
        batch.batchName?.trim() ||
        `TALLY-OPEN-${item.sku.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase()}-${batchIndex}`
      const expiryDate = batch.expiryDate!
      const quantity = Math.round(batch.quantity ?? 0)
      if (quantity <= 0) continue

      const existing = await db
        .from("pharmacy_product_batches")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("product_id", productId)
        .eq("batch_number", batchNumber)
        .eq("expiry_date", expiryDate)
        .limit(1)
      if (((existing.data ?? []) as unknown[]).length > 0) continue

      const costPrice =
        item.rate ??
        (item.value !== undefined && item.quantity ? item.value / item.quantity : null)
      const { error } = await receivePharmacyStock(db, {
        tenantId,
        productId,
        batchNumber,
        quantity,
        expiryDate,
        costPrice,
        sellingPrice: costPrice,
        receivedBy: actorId,
        supplierRef: `Tally opening ${plan.company ?? ""}`.trim(),
        reason: `Tally cut-over ${plan.conversionDate}`,
      })
      if (error) {
        progress.fail("opening-stock", `${item.sku}/${batchNumber}`, error.code, error.humanMessage)
        continue
      }
      received += 1
      progress.value.counts.openingStock = received
    }
  }
  return received
}

function saleItemsFor(
  sale: TallyCutoverSale,
  products: { byName: Map<string, string> },
): Array<{ stockItemName: string; quantity: number; unitPrice: number; lineTotal: number }> {
  return sale.items.filter((item) => {
    const quantity = Math.round(item.quantity)
    if (quantity <= 0) return false
    return products.byName.has(item.stockItemName.trim().toLowerCase())
  })
}

async function mirrorSale(
  db: TallyApplyDb,
  sale: TallyCutoverSale,
  input: {
    tenantId: string
    actorId: string
    customers: Map<string, string>
    products: { byName: Map<string, string> }
    company?: string
  },
  progress: Progress,
): Promise<void> {
  const missing = sale.items.filter(
    (item) => Math.round(item.quantity) > 0 && !input.products.byName.has(item.stockItemName.trim().toLowerCase()),
  )
  if (missing.length > 0) {
    progress.fail(
      "journals",
      sale.sourceId,
      "PRODUCT_MISSING",
      `Sale ${sale.transactionNumber}: ${missing.length} line${missing.length === 1 ? "" : "s"} could not be linked to a product, so the sale has no items.`,
    )
  }

  const inserted = await insertIgnore(
    db,
    "pharmacy_transactions",
    [
      {
        tenant_id: input.tenantId,
        transaction_no: sale.transactionNumber,
        customer_id: sale.partyName ? input.customers.get(sale.partyName.trim().toLowerCase()) ?? null : null,
        client_name: sale.partyName ?? null,
        cashier_id: input.actorId,
        total_amount: money(sale.total),
        discount: money(sale.discount),
        tax: money(sale.tax),
        net_amount: money(sale.total),
        payment_method: sale.paymentMethod,
        status: "COMPLETED",
        notes: `${TALLY_MIRROR_NOTE_PREFIX} (${input.company ?? "cut-over"}) — read-only`,
        created_at: isoDateTime(sale.date),
      },
    ],
    "tenant_id,transaction_no",
  )
  // A replay can find the parent already there — after an earlier run failed
  // on the items, or after a crash before the checkpoint caught up. Repair the
  // missing items instead of returning early and leaving the sale empty.
  const insertedId = (inserted[0] as { id: string } | undefined)?.id
  const existing = insertedId
    ? null
    : await findRow(db, "pharmacy_transactions", {
        tenant_id: input.tenantId,
        transaction_no: sale.transactionNumber,
      })
  // A different row under the same number was entered in the portal. Attaching
  // the imported items to it would mix the two and leave it editable, so leave
  // it alone and report the collision.
  if (!insertedId && existing && !isTallyMirrorNote(existing.notes)) {
    progress.fail(
      "journals",
      sale.sourceId,
      "SALE_CONFLICT",
      `Sale ${sale.transactionNumber} already exists in the portal and was not imported from Tally, so it was left untouched.`,
    )
    return
  }
  const transactionId = insertedId ?? existing?.id
  if (!transactionId) return

  let mirrored = inserted.length > 0
  const items = saleItemsFor(sale, input.products).map((item) => ({
    tenant_id: input.tenantId,
    transaction_id: transactionId,
    product_id: input.products.byName.get(item.stockItemName.trim().toLowerCase())!,
    quantity: Math.round(item.quantity),
    unit_price: money(item.unitPrice),
    // Tally sales vouchers carry no cost of sale. Copying the selling price
    // here reported zero gross profit on every imported sale; null keeps the
    // cost unknown so the profit report falls back to the product's cost.
    cost_price: null,
    total_price: money(item.lineTotal),
  }))
  if (items.length > 0) {
    const children = await childRowsExist(db, "pharmacy_transaction_items", "transaction_id", transactionId)
    if (children.error) {
      progress.fail("journals", sale.sourceId, "SALE_ITEMS_FAILED", children.error)
      return
    }
    if (!children.exists) {
      const { error } = await db.from("pharmacy_transaction_items").insert(items)
      if (error) {
        progress.fail("journals", sale.sourceId, "SALE_ITEMS_FAILED", error.message)
        return
      }
      mirrored = true
    }
  }
  if (mirrored) progress.value.counts.sales += 1
}

async function mirrorPurchase(
  db: TallyApplyDb,
  purchase: TallyCutoverPurchase,
  input: {
    tenantId: string
    actorId: string
    currency: string
    suppliers: Map<string, string>
    products: { byName: Map<string, string> }
    company?: string
  },
  progress: Progress,
): Promise<void> {
  const supplierId = input.suppliers.get(purchase.partyName.trim().toLowerCase())
  if (!supplierId) {
    progress.fail(
      "journals",
      purchase.sourceId,
      "SUPPLIER_MISSING",
      `Purchase ${purchase.purchaseNumber} was posted to the ledger but has no supplier to attach it to.`,
    )
    return
  }

  const paid = money(purchase.amountPaid)
  const total = money(purchase.total)
  const inserted = await insertIgnore(
    db,
    "pharmacy_purchases",
    [
      {
        tenant_id: input.tenantId,
        purchase_no: purchase.purchaseNumber,
        supplier_id: supplierId,
        purchase_date: purchase.date,
        payment_status: paid >= total ? "PAID" : paid > 0 ? "PARTIAL" : "CREDIT",
        payment_method: purchase.paymentMethod ?? null,
        currency: input.currency,
        subtotal: money(total - purchase.tax),
        tax: money(purchase.tax),
        discount: 0,
        other_cost: 0,
        total,
        amount_paid: paid,
        balance: money(total - paid),
        // DRAFT suppresses the ledger trigger: the journal was already posted
        // from the Tally voucher itself.
        status: "DRAFT",
        notes: `${TALLY_MIRROR_NOTE_PREFIX} (${input.company ?? "cut-over"}) — read-only`,
        created_by: input.actorId,
      },
    ],
    "tenant_id,purchase_no",
  )
  const insertedId = (inserted[0] as { id: string } | undefined)?.id
  const existing = insertedId
    ? null
    : await findRow(db, "pharmacy_purchases", {
        tenant_id: input.tenantId,
        purchase_no: purchase.purchaseNumber,
      })
  // Same collision as a sale: a portal purchase under the same number keeps its
  // own ledger life, so the import must not graft Tally items onto it.
  if (!insertedId && existing && !isTallyMirrorNote(existing.notes)) {
    progress.fail(
      "journals",
      purchase.sourceId,
      "PURCHASE_CONFLICT",
      `Purchase ${purchase.purchaseNumber} already exists in the portal and was not imported from Tally, so it was left untouched.`,
    )
    return
  }
  const purchaseId = insertedId ?? existing?.id
  if (!purchaseId) return

  let mirrored = inserted.length > 0
  const items = purchase.items
    .filter((item) => Math.round(item.quantity) > 0)
    .map((item) => ({
      tenant_id: input.tenantId,
      purchase_id: purchaseId,
      product_id: input.products.byName.get(item.stockItemName.trim().toLowerCase()) ?? null,
      product_name: item.stockItemName,
      quantity: Math.round(item.quantity),
      unit_cost: money(item.unitCost),
      line_total: money(item.lineTotal),
    }))
  if (items.length > 0) {
    const children = await childRowsExist(db, "pharmacy_purchase_items", "purchase_id", purchaseId)
    if (children.error) {
      progress.fail("journals", purchase.sourceId, "PURCHASE_ITEMS_FAILED", children.error)
      return
    }
    if (!children.exists) {
      const { error } = await db.from("pharmacy_purchase_items").insert(items)
      if (error) {
        progress.fail("journals", purchase.sourceId, "PURCHASE_ITEMS_FAILED", error.message)
        return
      }
      mirrored = true
    }
  }
  if (mirrored) progress.value.counts.purchases += 1
}

async function stageVoucherChunk(
  db: TallyApplyDb,
  chunk: { vouchers: TallyCutoverVoucher[]; sales: TallyCutoverSale[]; purchases: TallyCutoverPurchase[] },
  plan: TallyCutoverPlan,
  tenantId: string,
  actorId: string,
  maps: IdMaps,
  progress: Progress,
): Promise<void> {
  for (const voucher of chunk.vouchers) {
    const posted = await postJournal(db, {
      tenantId,
      sourceType: voucher.sourceType,
      sourceId: voucher.sourceId,
      date: voucher.date,
      description: voucher.description,
      currency: voucher.currency,
      actorId,
      lines: voucher.lines,
      accounts: maps.accounts,
      stage: "journals",
      progress,
    })
    if (posted) progress.value.counts.journals += 1
  }

  const products = { byName: maps.productsByName }
  for (const sale of chunk.sales) {
    await mirrorSale(
      db,
      sale,
      { tenantId, actorId, customers: maps.customers, products, company: plan.company },
      progress,
    )
  }
  for (const purchase of chunk.purchases) {
    await mirrorPurchase(
      db,
      purchase,
      {
        tenantId,
        actorId,
        currency: plan.currency,
        suppliers: maps.suppliers,
        products,
        company: plan.company,
      },
      progress,
    )
  }
}

/**
 * Runs one stage or one voucher chunk.
 * `plan` must contain the full plan for opening stages, or the chunk's slice
 * for the journals stage; the caller loads exactly what the stage needs.
 */
export async function applyTallyChunk(
  db: TallyApplyDb,
  input: {
    tenantId: string
    actorId: string
    plan: TallyCutoverPlan
    progress: TallyApplyProgress
    chunk?: { vouchers: TallyCutoverVoucher[]; sales: TallyCutoverSale[]; purchases: TallyCutoverPurchase[] }
    totalChunks?: number
  },
): Promise<TallyApplyChunkResult> {
  const progress = new Progress(input.progress)
  const tenantId = input.tenantId

  switch (input.progress.stage) {
    case "accounts": {
      await stageAccounts(db, input.plan, tenantId, progress)
      progress.advance("parties")
      break
    }
    case "parties": {
      await stageParties(db, input.plan, tenantId, progress)
      progress.advance("products")
      break
    }
    case "products": {
      await stageProducts(db, input.plan, tenantId, progress)
      progress.advance("opening-journal")
      break
    }
    case "opening-journal": {
      const posted = await stageOpeningJournal(db, input.plan, tenantId, input.actorId, progress)
      // History must not post on top of an opening position that never landed.
      if (posted) progress.advance("opening-stock")
      break
    }
    case "opening-stock": {
      await stageOpeningStock(db, input.plan, tenantId, input.actorId, progress)
      progress.advance("journals", 0)
      break
    }
    case "journals": {
      const [accounts, products, parties] = await Promise.all([
        loadAccounts(db, tenantId),
        loadProducts(db, tenantId),
        loadParties(db, tenantId),
      ])
      const maps: IdMaps = {
        accounts,
        productsBySku: products.bySku,
        productsByName: products.byName,
        customers: parties.customers,
        suppliers: parties.suppliers,
      }
      await stageVoucherChunk(
        db,
        input.chunk ?? { vouchers: [], sales: [], purchases: [] },
        input.plan,
        tenantId,
        input.actorId,
        maps,
        progress,
      )
      const next = input.progress.offset + 1
      if (input.totalChunks === undefined || next >= input.totalChunks) {
        progress.advance("complete", next)
      } else {
        progress.advance("journals", next)
      }
      break
    }
    case "complete":
      break
  }

  return {
    progress: progress.value,
    done: progress.value.stage === "complete",
    message:
      progress.value.failures.length > 0
        ? `${progress.value.failures.length} item${progress.value.failures.length === 1 ? "" : "s"} could not be imported and are listed.`
        : undefined,
  }
}

export const __test__ = { money, escapeLike, isoDateTime, TALLY_APPLY_CHUNK }
