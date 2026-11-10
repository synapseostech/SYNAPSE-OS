/**
 * Resumable Tally cut-over apply.
 *
 * Each call does one bounded unit of work and returns the next checkpoint, so a
 * large export never depends on one long request. Every write is idempotent:
 * journals key on (source_type, source_id), mirrors on their document number,
 * and opening batches are checked before the receiving RPC (which tops up).
 */

import { receivePharmacyStock, parsePharmacyRpcError } from "@synapse/db/inventory-rpc"
import {
  applyTallyReplayMovement,
  readTallyReplayActuals,
  recordTallyReplayCheckpoint,
  type TallyReplayAllocationInput,
  type TallyReplayCheckpoint,
} from "@synapse/db/tally-replay-rpc"
import { chooseFefo, type TallyReplayLineCost } from "@synapse/db/tally-replay"
import { tallyVoucherSourceType } from "@synapse/db/tally-map"
import { netAmountFor } from "@/lib/pos/net-amount"
import type {
  TallyCutoverMovement,
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
  type TallyDbError,
  type TallyReplayTarget,
} from "./types"

export type TallyApplyStage =
  | "accounts"
  | "parties"
  | "products"
  | "opening-journal"
  | "opening-stock"
  | "stock-history"
  | "journals"
  | "replay-closing"
  | "complete"

/**
 * Every stage an apply can reach. A replay walks all of them; an opening or
 * closing cut-over skips `stock-history` and `replay-closing` and goes from
 * `opening-stock` to `journals` to `complete`.
 */
export const TALLY_STAGE_ORDER: TallyApplyStage[] = [
  "accounts",
  "parties",
  "products",
  "opening-journal",
  "opening-stock",
  "stock-history",
  "journals",
  "replay-closing",
  "complete",
]

export type TallyApplyCounts = {
  accounts: number
  parties: number
  products: number
  openingJournal: number
  openingStock: number
  /** Replay only: movements this run applied to stock. */
  stockMovements: number
  /** Replay only: movements a re-run found already applied. */
  movementsReplayed: number
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
const TRUNCATION_CODE = "FAILURES_TRUNCATED"
const INSERT_BATCH = 200

/**
 * An abort that names where it happened. Item failures are checkpointed to the
 * session; this is the other kind — the stage itself could not continue — and
 * the route logs it, so the reason must outlive the request.
 */
function stepFailed(stage: TallyApplyStage, item: string | null, error: TallyDbError): Error {
  const failure = new Error(`${stage}${item ? ` @ ${item}` : ""}: ${error.message}`)
  failure.name = "TallyApplyStepError"
  return Object.assign(failure, { stage, item, detail: error })
}

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
      stockMovements: 0,
      movementsReplayed: 0,
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
    const duplicate = this.value.failures.some(
      (failure) => failure.stage === stage && failure.key === key && failure.code === code,
    )
    if (duplicate) return
    if (this.value.failures.length >= MAX_FAILURES) {
      // Dropping the tail silently would let a review understate what the import
      // missed. One entry stands in for everything past the cap.
      if (this.value.failures.some((failure) => failure.code === TRUNCATION_CODE)) return
      this.value.failures.push({
        stage,
        key: "apply",
        code: TRUNCATION_CODE,
        message: `More than ${MAX_FAILURES} items could not be imported; the rest are not listed.`,
      })
      return
    }
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

function productNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

async function loadProducts(db: TallyApplyDb, tenantId: string): Promise<{ bySku: Map<string, string>; byName: Map<string, string> }> {
  const { data } = await db
    .from("pharmacy_products")
    .select("id, sku, name, strength, dosage_form, active_ingredient")
    .eq("tenant_id", tenantId)
  const bySku = new Map<string, string>()
  const groupedByName = new Map<
    string,
    Array<{
      id: string
      strength?: string | null
      dosage_form?: string | null
      active_ingredient?: string | null
    }>
  >()
  for (const row of (data ?? []) as Array<{
    id: string
    sku: string
    name: string
    strength?: string | null
    dosage_form?: string | null
    active_ingredient?: string | null
  }>) {
    bySku.set(row.sku.toLowerCase(), row.id)
    const key = productNameKey(row.name)
    const group = groupedByName.get(key) ?? []
    group.push(row)
    groupedByName.set(key, group)
  }
  const byName = new Map<string, string>()
  for (const [key, products] of groupedByName) {
    const [product] = products
    if (
      products.length === 1 &&
      product &&
      !product.strength?.trim() &&
      !product.dosage_form?.trim() &&
      !product.active_ingredient?.trim()
    ) {
      byName.set(key, product.id)
    }
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
  item: string,
): Promise<Array<Record<string, unknown>>> {
  if (rows.length === 0) return []
  const { data, error } = await db
    .from(table)
    .upsert(rows, { onConflict, ignoreDuplicates: true })
    .select()
  if (error) throw stepFailed("journals", item, error)
  return (data ?? []) as Array<Record<string, unknown>>
}

async function findRow(
  db: TallyApplyDb,
  table: string,
  filters: Record<string, string>,
  columns: string[] = [],
): Promise<({ id: string; notes?: string | null } & Record<string, unknown>) | null> {
  let query = db.from(table).select(["id", "notes", ...columns].join(", "))
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value)
  const { data } = await query.limit(1)
  return (
    ((data ?? []) as Array<{ id: string; notes?: string | null } & Record<string, unknown>>)[0] ??
    null
  )
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
  if (seeded.error) throw stepFailed("accounts", "system chart", seeded.error)

  const accounts = await loadAccounts(db, tenantId)
  const existing = new Set(accounts.keys())
  const missing = plan.accounts.filter((account) => !existing.has(account.code))
  for (let index = 0; index < missing.length; index += INSERT_BATCH) {
    const batch = missing.slice(index, index + INSERT_BATCH).map((account) => ({
      code: account.code,
      name: account.name,
      account_type: account.accountType,
      normal_balance: account.normalBalance,
    }))
    // The accounts table is closed to direct writes; imported ledgers enter
    // through this function, the same way the seeded chart does.
    const { data, error } = await db.rpc("add_pharmacy_accounting_accounts", {
      p_tenant_id: tenantId,
      p_accounts: batch,
    })
    if (error) {
      const label = batch.length === 1 ? batch[0]!.code : `${batch[0]!.code} (+${batch.length - 1})`
      throw stepFailed("accounts", label, error)
    }
    progress.value.counts.accounts += Number(data ?? 0)
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
    // An ILIKE on the raw name misses a portal product whose name differs only
    // in whitespace, and would create a duplicate for it. The unique-name map
    // was built with productNameKey, so consult it first.
    const existingId =
      known.byName.get(productNameKey(item.name)) ??
      (await findByName(db, "pharmacy_products", tenantId, item.name))
    if (existingId) {
      known.bySku.set(sku, existingId)
      known.byName.set(productNameKey(item.name), existingId)
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
    known.byName.set(productNameKey(item.name), (data as { id: string }).id)
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

/**
 * The batch number given to opening stock Tally does not name. It is derived
 * from the item and the batch's position so a resumed apply recognises the
 * batch it already created instead of receiving it a second time.
 */
function openingBatchKey(sku: string, index: number): string {
  return `TALLY-OPEN-${sku.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase()}-${index}`
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
      products.byName.get(productNameKey(item.name))
    if (!productId) {
      progress.fail("opening-stock", item.sku, "PRODUCT_MISSING", "Product was not created; no stock received.")
      continue
    }
    let batchIndex = 0
    for (const batch of item.batches) {
      if (!batch.receivable) continue
      batchIndex += 1
      const batchNumber = batch.batchName?.trim() || openingBatchKey(item.sku, batchIndex)
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

/**
 * The two buckets the simulation keys internally. A physical count has no
 * batch identity and a shortage has no batch at all, so each needs a stable
 * row of its own rather than being folded into a real batch.
 */
const PHYSICAL_BATCH = "TALLY-RPL-PHYSICAL"
const NEGATIVE_BATCH = "TALLY-RPL-NEGATIVE"
const NO_EXPIRY = "9999-12-31"
const CLOSING_DIFFERENCES_LISTED = 20

type BatchRow = {
  batchNumber: string
  expiryDate: string
  receivedDate: string
  quantity: number
}

function productIdByStockItem(
  plan: TallyCutoverPlan,
  products: { bySku: Map<string, string>; byName: Map<string, string> },
): Map<string, string> {
  const ids = new Map<string, string>()
  for (const item of plan.stockItems) {
    const productId =
      products.bySku.get(item.sku.trim().toLowerCase()) ??
      products.byName.get(productNameKey(item.name))
    if (productId) ids.set(item.sourceName, productId)
  }
  return ids
}

/**
 * Opening stock replayed as history: through the replay RPC, so the batch keeps
 * the expiry and the received date the export states. `receive_pharmacy_stock`
 * would refuse a batch that is already expired and stamp today's date, which is
 * right for a delivery and wrong for history.
 */
async function stageOpeningStockReplay(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  progress: Progress,
  sessionId: string,
): Promise<void> {
  const products = await loadProducts(db, tenantId)
  // One source for the whole opening position, so its provenance is as stable
  // as the opening journal's.
  const sourceId = `${plan.companyKey}:opening:${plan.conversionDate}`

  for (const [itemIndex, item] of plan.stockItems.entries()) {
    if (item.quantity === undefined || item.quantity <= 0) continue
    const productId =
      products.bySku.get(item.sku.trim().toLowerCase()) ??
      products.byName.get(productNameKey(item.name))
    if (!productId) {
      progress.fail("opening-stock", item.sku, "PRODUCT_MISSING", "Product was not created; no stock received.")
      continue
    }
    const unitValue =
      item.quantity !== 0 ? (item.value ?? 0) / item.quantity : (item.rate ?? 0)

    for (const [batchIndex, batch] of item.batches.entries()) {
      if (!batch.receivable || batch.quantity === undefined || batch.quantity <= 0) continue
      const quantity = Math.round(batch.quantity)
      if (quantity <= 0) continue
      const named = batch.batchName?.trim()
      const batchNumber = named || openingBatchKey(item.sku, batchIndex + 1)

      const { data, error } = await applyTallyReplayMovement(db, {
        tenantId,
        sessionId,
        // Same id the simulation gives this opening batch, so a finding and a
        // provenance row name the same thing.
        movementId: `${plan.conversionDate}:OPENING:B${batchIndex}`,
        sourceType: "tally_opening",
        sourceId,
        lineIndex: itemIndex,
        movementKind: "opening",
        movementDate: plan.conversionDate,
        productId,
        allocation: named ? "explicit" : "synthetic",
        allocations: [
          {
            batchIndex,
            batchNumber,
            expiryDate: batch.expiryDate ?? null,
            quantityDelta: quantity,
            rate: money(unitValue),
            amount: money(unitValue * quantity),
          },
        ],
      })
      if (error) {
        progress.fail("opening-stock", `${item.sku}/${batchNumber}`, error.code, error.humanMessage)
        continue
      }
      // A batch an earlier attempt already wrote is present too, and the
      // reconciliation row asks what the pharmacy holds, not who wrote it.
      if (data) progress.value.counts.openingStock += 1
    }
  }
}

async function loadBatches(
  db: TallyApplyDb,
  tenantId: string,
  productId: string,
): Promise<BatchRow[]> {
  const { data } = await db
    .from("pharmacy_product_batches")
    .select("batch_number, expiry_date, received_date, quantity")
    .eq("tenant_id", tenantId)
    .eq("product_id", productId)
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    batchNumber: String(row.batch_number ?? ""),
    expiryDate: String(row.expiry_date ?? NO_EXPIRY).slice(0, 10),
    // A timestamptz comes back with a time; only the business day decides
    // whether a batch was received by the movement's date.
    receivedDate: String(row.received_date ?? "").slice(0, 10),
    quantity: Math.round(Number(row.quantity ?? 0)),
  }))
}

async function loadProductQuantity(
  db: TallyApplyDb,
  tenantId: string,
  productId: string,
): Promise<number> {
  const { data } = await db
    .from("pharmacy_products")
    .select("quantity")
    .eq("tenant_id", tenantId)
    .eq("id", productId)
    .limit(1)
  return Math.round(Number(((data ?? []) as Array<{ quantity?: number }>)[0]?.quantity ?? 0))
}

/**
 * Reproduces the simulation's choice of batches for a sale that names none: a
 * named batch gives what it has (and the rest leaves it too, as the simulation
 * records it); FEFO fills the remainder; and what nothing covers goes to the
 * shortage bucket, which is only writable once the negative was acknowledged.
 */
function outgoingAllocations(
  batches: BatchRow[],
  movement: TallyCutoverMovement,
  quantity: number,
): TallyReplayAllocationInput[] {
  const named =
    movement.allocation !== "fefo" && movement.batchNumber
      ? batches.find((batch) => batch.batchNumber === movement.batchNumber)
      : undefined

  if (named) {
    return [
      {
        batchIndex: 0,
        batchNumber: named.batchNumber,
        expiryDate: named.expiryDate,
        quantityDelta: -quantity,
        rate: movement.rate,
        amount: money(-quantity * movement.rate),
      },
    ]
  }

  const allocations: TallyReplayAllocationInput[] = []
  let remaining = quantity
  let index = 0
  for (const take of chooseFefo(batches, quantity, movement.date)) {
    allocations.push({
      batchIndex: index++,
      batchNumber: take.batch.batchNumber,
      expiryDate: take.batch.expiryDate,
      quantityDelta: -take.quantity,
      rate: movement.rate,
      amount: money(-take.quantity * movement.rate),
    })
    remaining -= take.quantity
  }
  if (remaining > 0) {
    allocations.push({
      batchIndex: index,
      batchNumber: NEGATIVE_BATCH,
      expiryDate: NO_EXPIRY,
      quantityDelta: -remaining,
      rate: movement.rate,
      amount: money(-remaining * movement.rate),
    })
  }
  return allocations
}

/**
 * The history stage: one movement chunk per request, applied through the replay
 * RPC in the order the preview showed. A resumed chunk re-sends movements the
 * RPC reports as already applied, so a crash costs a repeat and never a second
 * stock movement.
 */
async function stageStockHistory(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  progress: Progress,
  sessionId: string,
  target: TallyReplayTarget | undefined,
): Promise<void> {
  const movements = plan.movements ?? []
  if (movements.length === 0) return

  const products = await loadProducts(db, tenantId)
  const productIds = productIdByStockItem(plan, products)
  // The review's own findings, not a fresh guess: a movement may write a
  // negative quantity only because the operator was shown that and applied.
  const negativeAllowed = new Set(
    (target?.findings ?? [])
      .filter((finding) => finding.code === "REPLAY_NEGATIVE_STOCK")
      .map((finding) => finding.movementId),
  )

  for (const movement of movements) {
    const productId = productIds.get(movement.stockItemName)
    if (!productId) {
      progress.fail(
        "stock-history",
        movement.stockItemName,
        "PRODUCT_MISSING",
        `"${movement.stockItemName}" has no product in this pharmacy, so its stock movement was not replayed.`,
      )
      continue
    }

    let allocations: TallyReplayAllocationInput[]
    if (movement.movementKind === "physical_adjust") {
      // The line states the counted quantity, not a difference. It becomes a
      // delta against what the database holds now, so the write stays a signed
      // movement like every other one.
      const delta = Math.round(movement.quantityDelta) - (await loadProductQuantity(db, tenantId, productId))
      if (delta === 0) continue
      if (delta > 0) {
        // Stock the count found that the book did not have has no batch of its
        // own; it goes into the physical-count bucket.
        allocations = [
          {
            batchIndex: movement.batchIndex,
            batchNumber: movement.batchNumber ?? PHYSICAL_BATCH,
            // A physical count carries no expiry, and inventing one would make
            // two counts of the same product disagree about the same bucket.
            expiryDate: movement.expiryDate ?? NO_EXPIRY,
            quantityDelta: delta,
            rate: movement.rate,
            amount: money(delta * movement.rate),
          },
        ]
      } else {
        // Stock the count found missing must leave the batches that hold it,
        // exactly as a sale does. Booking the shortfall onto a fresh batch
        // would drive that batch negative while the product kept stock its
        // own books no longer had.
        const batches = await loadBatches(db, tenantId, productId)
        allocations = outgoingAllocations(batches, movement, Math.abs(delta))
      }
    } else if (movement.quantityDelta < 0) {
      const batches = await loadBatches(db, tenantId, productId)
      allocations = outgoingAllocations(batches, movement, Math.abs(movement.quantityDelta))
    } else {
      allocations = [
        {
          batchIndex: movement.batchIndex,
          batchNumber: movement.batchNumber ?? "",
          expiryDate: movement.expiryDate ?? null,
          quantityDelta: movement.quantityDelta,
          rate: movement.rate,
          amount: movement.amount,
        },
      ]
    }

    const { data, error } = await applyTallyReplayMovement(db, {
      tenantId,
      sessionId,
      movementId: movement.movementId,
      sourceType: tallyVoucherSourceType(movement.kind) ?? "tally_stock_movement",
      sourceId: movement.sourceId,
      lineIndex: movement.lineIndex,
      movementKind: movement.movementKind,
      movementDate: movement.date,
      productId,
      godown: movement.godown ?? null,
      allocation: movement.allocation,
      allocations,
      allowNegative: negativeAllowed.has(movement.movementId),
    })
    if (error) {
      progress.fail(
        "stock-history",
        movement.movementId,
        error.code,
        `${movement.stockItemName} on ${movement.date}: ${error.humanMessage}`,
      )
      continue
    }
    if (data?.replayed) {
      progress.value.counts.movementsReplayed =
        (progress.value.counts.movementsReplayed ?? 0) + 1
    } else {
      progress.value.counts.stockMovements = (progress.value.counts.stockMovements ?? 0) + 1
    }
  }
}

/**
 * A continuation does not replay an opening position: it is already in the
 * database, and writing it again would double the history. The two opening
 * stages therefore verify instead of apply — the account half at
 * `opening-journal`, the stock half at `opening-stock` — against the
 * checkpoint the previous session closed on.
 *
 * A drift is an abort, not a listed failure: continuing on top of a base that
 * no longer matches the checkpoint would post new history against a position
 * nobody reviewed.
 */
async function verifyContinuationAccounts(
  db: TallyApplyDb,
  tenantId: string,
  checkpoint: TallyReplayCheckpoint,
): Promise<void> {
  const actuals = await readTallyReplayActuals(db, tenantId)
  if (actuals.error || !actuals.data) {
    throw new Error(
      `TALLY_CONTINUATION_READ_FAILED: the position this continuation starts from could not be read (${actuals.error?.humanMessage ?? "no data"}).`,
    )
  }

  const actualByCode = new Map(
    actuals.data.accounts.map((row) => [row.code, money(row.debit - row.credit)]),
  )
  const drifted: string[] = []
  for (const [code, expected] of Object.entries(checkpoint.closingState.accounts)) {
    const actual = actualByCode.get(code) ?? 0
    if (Math.abs(money(actual - expected)) > 0.01) {
      drifted.push(`account ${code}: checkpoint ${expected}, database holds ${actual}`)
    }
  }

  if (drifted.length > 0) {
    throw new Error(
      `TALLY_CONTINUATION_DRIFT: the ledger no longer matches the ${checkpoint.throughDate} checkpoint this import continues from — ${drifted.slice(0, CLOSING_DIFFERENCES_LISTED).join("; ")}${drifted.length > CLOSING_DIFFERENCES_LISTED ? `; ${drifted.length - CLOSING_DIFFERENCES_LISTED} more` : ""}. Nothing was applied by this stage.`,
    )
  }
}

async function verifyContinuationStock(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  checkpoint: TallyReplayCheckpoint,
): Promise<void> {
  const actuals = await readTallyReplayActuals(db, tenantId)
  if (actuals.error || !actuals.data) {
    throw new Error(
      `TALLY_CONTINUATION_READ_FAILED: the position this continuation starts from could not be read (${actuals.error?.humanMessage ?? "no data"}).`,
    )
  }

  const productIds = productIdByStockItem(plan, await loadProducts(db, tenantId))
  const quantityByProduct = new Map(actuals.data.products.map((row) => [row.productId, row.quantity]))
  const drifted: string[] = []
  for (const item of checkpoint.closingState.items) {
    const productId = productIds.get(item.stockItemName)
    const actual = productId ? (quantityByProduct.get(productId) ?? 0) : 0
    if (money(actual - item.quantity) !== 0) {
      drifted.push(`stock item ${item.stockItemName}: checkpoint ${item.quantity}, database holds ${actual}`)
    }
  }

  if (drifted.length > 0) {
    throw new Error(
      `TALLY_CONTINUATION_DRIFT: stock no longer matches the ${checkpoint.throughDate} checkpoint this import continues from — ${drifted.slice(0, CLOSING_DIFFERENCES_LISTED).join("; ")}${drifted.length > CLOSING_DIFFERENCES_LISTED ? `; ${drifted.length - CLOSING_DIFFERENCES_LISTED} more` : ""}. Nothing was applied by this stage.`,
    )
  }
}

/**
 * The closing check. The database is read back and placed beside the position
 * the reviewed replay said it would reach; nothing is adjusted, and a
 * difference stops the session short of `complete`.
 */
async function stageReplayClosing(
  db: TallyApplyDb,
  plan: TallyCutoverPlan,
  tenantId: string,
  actorId: string,
  sessionId: string,
  progress: Progress,
  target: TallyReplayTarget | undefined,
): Promise<void> {
  if (!target) {
    throw new Error(
      "TALLY_PLAN_MISSING: the reviewed replay has no saved closing position, so the closing check cannot run.",
    )
  }

  const actuals = await readTallyReplayActuals(db, tenantId)
  if (actuals.error || !actuals.data) {
    throw new Error(
      `TALLY_REPLAY_CLOSING_READ_FAILED: ${actuals.error?.humanMessage ?? "the applied state could not be read"}`,
    )
  }

  const productIds = productIdByStockItem(plan, await loadProducts(db, tenantId))
  const quantityByProduct = new Map(actuals.data.products.map((row) => [row.productId, row.quantity]))
  const accountByCode = new Map(
    actuals.data.accounts.map((row) => [row.code, money(row.debit - row.credit)]),
  )
  const batchQuantityByProduct = new Map<string, number>()
  for (const batch of actuals.data.batches) {
    batchQuantityByProduct.set(
      batch.productId,
      (batchQuantityByProduct.get(batch.productId) ?? 0) + batch.quantity,
    )
  }

  const differences: Array<{ scope: string; key: string; expected: number; actual: number }> = []

  for (const item of target.simulated.items) {
    const productId = productIds.get(item.stockItemName)
    const actual = productId ? (quantityByProduct.get(productId) ?? 0) : 0
    if (money(actual - item.quantity) !== 0) {
      differences.push({ scope: "stock item", key: item.stockItemName, expected: item.quantity, actual })
      continue
    }
    // Stock that reached the right total through batches that do not add up to
    // it would fail the next sale rather than this check.
    const batchSum = productId ? (batchQuantityByProduct.get(productId) ?? 0) : 0
    if (money(batchSum - actual) !== 0) {
      differences.push({ scope: "batch total", key: item.stockItemName, expected: actual, actual: batchSum })
    }
  }

  for (const [code, balance] of Object.entries(target.simulated.accounts)) {
    const actual = accountByCode.get(code) ?? 0
    if (Math.abs(money(actual - balance)) > 0.01) {
      differences.push({ scope: "account", key: code, expected: balance, actual })
    }
  }

  if (differences.length > 0) {
    const listed = differences
      .slice(0, CLOSING_DIFFERENCES_LISTED)
      .map((entry) => `${entry.scope} ${entry.key}: reviewed ${entry.expected}, database holds ${entry.actual}`)
      .join("; ")
    throw new Error(
      `TALLY_REPLAY_CLOSING_MISMATCH: ${differences.length} figure${differences.length === 1 ? "" : "s"} do not match the reviewed replay — ${listed}${differences.length > CLOSING_DIFFERENCES_LISTED ? "; more are in the progress record" : ""}`,
    )
  }

  // The session reaches `complete` only after this row exists, so a crash
  // between the check and completion leaves the check to be re-run harmlessly.
  const { data: existing } = await db
    .from("pharmacy_audit_logs")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("action", "IMPORT_TALLY_REPLAY")
    .eq("entity", "IMPORT_SESSION")
    .eq("entity_id", sessionId)
    .limit(1)
  if (((existing ?? []) as unknown[]).length === 0) {
    const compared = target.simulated.items.length + Object.keys(target.simulated.accounts).length
    const { error } = await db.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: actorId,
      action: "IMPORT_TALLY_REPLAY",
      entity: "IMPORT_SESSION",
      entity_id: sessionId,
      details: `Tally replay closed against the reviewed position: cutoff ${target.cutoffDate}, ${progress.value.counts.stockMovements ?? 0} stock movements applied, ${progress.value.counts.movementsReplayed ?? 0} already applied, ${compared} figures compared (quantities exact, money within 0.01), session ${sessionId}`,
    })
    if (error) throw stepFailed("replay-closing", "audit", error)
  }

  // The checkpoint is appended only now, after the database matched the
  // reviewed position. It is idempotent on (company, cutoff), so a resumed
  // closing stage appends it once; a cutoff the company has already closed at
  // — or one that does not advance its period — is refused here rather than
  // silently overwriting the position a continuation would read.
  const checkpoint = await recordTallyReplayCheckpoint(db, {
    tenantId,
    sessionId,
    companyKey: plan.companyKey,
    throughDate: target.cutoffDate,
    closingState: target.simulated,
  })
  if (checkpoint.error) {
    throw new Error(
      `TALLY_CHECKPOINT_FAILED: the replay closed but its checkpoint could not be recorded (${checkpoint.error.humanMessage}). Retry the closing stage.`,
    )
  }
}

function saleItemsFor(
  sale: TallyCutoverSale,
  products: { byName: Map<string, string> },
): Array<{
  stockItemName: string
  quantity: number
  unitPrice: number
  lineTotal: number
  lineIndex?: number
}> {
  return sale.items.filter((item) => {
    const quantity = Math.round(item.quantity)
    if (quantity <= 0) return false
    return products.byName.has(productNameKey(item.stockItemName))
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
    /** Replay only: what the replayed stock says each sale line cost. */
    costs?: Record<string, TallyReplayLineCost>
  },
  progress: Progress,
): Promise<void> {
  const missing = sale.items.filter(
    (item) =>
      Math.round(item.quantity) > 0 &&
      !input.products.byName.has(productNameKey(item.stockItemName)),
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
        // What the customer owed, not the pre-tax line sum. See lib/pos/net-amount.ts.
        net_amount: netAmountFor({
          totalAmount: money(sale.total),
          discount: money(sale.discount),
          tax: money(sale.tax),
        }),
        payment_method: sale.paymentMethod,
        status: "COMPLETED",
        notes: `${TALLY_MIRROR_NOTE_PREFIX} (${input.company ?? "cut-over"}) — read-only`,
        created_at: isoDateTime(sale.date),
      },
    ],
    "tenant_id,transaction_no",
    sale.sourceId,
  )
  // A replay can find the parent already there — after an earlier run failed
  // on the items, or after a crash before the checkpoint caught up. Repair the
  // missing items instead of returning early and leaving the sale empty.
  const insertedId = (inserted[0] as { id: string } | undefined)?.id
  const existing = insertedId
    ? null
    : await findRow(
        db,
        "pharmacy_transactions",
        {
          tenant_id: input.tenantId,
          transaction_no: sale.transactionNumber,
        },
        ["total_amount", "discount", "tax"],
      )
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
  // A different Tally voucher can carry a number this import already used. The
  // upsert skipped the insert, and grafting the second sale's lines onto the
  // first mirror would mix two sales; report it instead. A genuine replay of
  // the same voucher carries identical figures and still repairs its items.
  if (!insertedId && existing && isTallyMirrorNote(existing.notes)) {
    const sameSale =
      money(Number(existing.total_amount)) === money(sale.total) &&
      money(Number(existing.discount)) === money(sale.discount) &&
      money(Number(existing.tax)) === money(sale.tax)
    if (!sameSale) {
      progress.fail(
        "journals",
        sale.sourceId,
        "SALE_NUMBER_COLLISION",
        `Sale ${sale.transactionNumber} is already imported from Tally with different figures, so this voucher was not mirrored.`,
      )
      return
    }
  }
  const transactionId = insertedId ?? existing?.id
  if (!transactionId) return

  let mirrored = inserted.length > 0
  const items = saleItemsFor(sale, input.products).map((item) => {
    const quantity = Math.round(item.quantity)
    const cost =
      item.lineIndex === undefined ? undefined : input.costs?.[`${sale.sourceId}:L${item.lineIndex}`]
    return {
      tenant_id: input.tenantId,
      transaction_id: transactionId,
      product_id: input.products.byName.get(productNameKey(item.stockItemName))!,
      quantity,
      unit_price: money(item.unitPrice),
      // Tally sales vouchers carry no cost of sale of their own. A replay can
      // state it, because it knows which batches left at their purchase rates;
      // where it cannot (a shortage, or a target saved before costs existed)
      // the value stays null and the profit report uses the product's cost.
      cost_price: cost?.complete && quantity > 0 ? money(cost.amount / quantity) : null,
      total_price: money(item.lineTotal),
    }
  })
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
    purchase.sourceId,
  )
  const insertedId = (inserted[0] as { id: string } | undefined)?.id
  const existing = insertedId
    ? null
    : await findRow(
        db,
        "pharmacy_purchases",
        {
          tenant_id: input.tenantId,
          purchase_no: purchase.purchaseNumber,
        },
        ["total", "tax", "amount_paid"],
      )
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
  if (!insertedId && existing && isTallyMirrorNote(existing.notes)) {
    const samePurchase =
      money(Number(existing.total)) === money(purchase.total) &&
      money(Number(existing.tax)) === money(purchase.tax) &&
      money(Number(existing.amount_paid)) === money(purchase.amountPaid)
    if (!samePurchase) {
      progress.fail(
        "journals",
        purchase.sourceId,
        "PURCHASE_NUMBER_COLLISION",
        `Purchase ${purchase.purchaseNumber} is already imported from Tally with different figures, so this voucher was not mirrored.`,
      )
      return
    }
  }
  const purchaseId = insertedId ?? existing?.id
  if (!purchaseId) return

  let mirrored = inserted.length > 0
  const items = purchase.items
    .filter((item) => Math.round(item.quantity) > 0)
    .map((item) => ({
      tenant_id: input.tenantId,
      purchase_id: purchaseId,
      product_id: input.products.byName.get(productNameKey(item.stockItemName)) ?? null,
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
  costs?: Record<string, TallyReplayLineCost>,
): Promise<void> {
  // A mirror is the portal's copy of the sale the voucher posted. If the journal
  // was refused, writing the sale anyway shows history the ledger never got —
  // and the read-only guard makes that row impossible to remove afterwards.
  // Only sources attempted in this chunk are tracked: a chunk carrying mirrors
  // with no matching voucher has no journal to gate on.
  const journalPosted = new Map<string, boolean>()
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
    journalPosted.set(voucher.sourceId, posted)
    if (posted) progress.value.counts.journals += 1
  }

  const products = { byName: maps.productsByName }
  for (const sale of chunk.sales) {
    if (journalPosted.get(sale.sourceId) === false) {
      progress.fail(
        "journals",
        sale.sourceId,
        "SALE_JOURNAL_NOT_POSTED",
        `Sale ${sale.transactionNumber} was not imported because its ledger journal did not post.`,
      )
      continue
    }
    await mirrorSale(
      db,
      sale,
      { tenantId, actorId, customers: maps.customers, products, company: plan.company, costs },
      progress,
    )
  }
  for (const purchase of chunk.purchases) {
    if (journalPosted.get(purchase.sourceId) === false) {
      progress.fail(
        "journals",
        purchase.sourceId,
        "PURCHASE_JOURNAL_NOT_POSTED",
        `Purchase ${purchase.purchaseNumber} was not imported because its ledger journal did not post.`,
      )
      continue
    }
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
    /** The import session itself. A replayed movement records which session moved it. */
    sessionId: string
    /** Plan mode `replay`; opening and closing cut-overs leave this unset. */
    replay?: boolean
    /** `stock-history` chunk count, from the saved summary. */
    movementTotalChunks?: number
    /** The reviewed closing figures, loaded for `stock-history` and `replay-closing`. */
    replayTarget?: TallyReplayTarget
    /**
     * Set when this session continues a completed replay. The opening stages
     * verify the database against this checkpoint instead of applying an
     * opening position that is already there.
     */
    continuation?: TallyReplayCheckpoint | null
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
      if (input.continuation) {
        // The opening journal is already in the database; a continuation
        // proves that rather than posting it a second time.
        await verifyContinuationAccounts(db, tenantId, input.continuation)
        progress.advance("opening-stock")
        break
      }
      const posted = await stageOpeningJournal(db, input.plan, tenantId, input.actorId, progress)
      // History must not post on top of an opening position that never landed.
      if (posted) progress.advance("opening-stock")
      break
    }
    case "opening-stock": {
      if (input.continuation) {
        await verifyContinuationStock(db, input.plan, tenantId, input.continuation)
        progress.advance("stock-history", 0)
        break
      }
      if (input.replay) {
        // History keeps the export's dates, so it cannot go through the
        // receiving RPC that stamps today and refuses a past expiry.
        await stageOpeningStockReplay(db, input.plan, tenantId, progress, input.sessionId)
        progress.advance("stock-history", 0)
      } else {
        await stageOpeningStock(db, input.plan, tenantId, input.actorId, progress)
        progress.advance("journals", 0)
      }
      break
    }
    case "stock-history": {
      await stageStockHistory(
        db,
        input.plan,
        tenantId,
        progress,
        input.sessionId,
        input.replayTarget,
      )
      const next = input.progress.offset + 1
      const total = input.movementTotalChunks ?? 0
      progress.advance(next >= total ? "journals" : "stock-history", next >= total ? 0 : next)
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
        input.replayTarget?.costs,
      )
      const next = input.progress.offset + 1
      if (input.totalChunks === undefined || next >= input.totalChunks) {
        // A replay is not finished when the journals are posted; it is finished
        // when the database agrees with the position the operator reviewed.
        progress.advance(input.replay ? "replay-closing" : "complete", input.replay ? 0 : next)
      } else {
        progress.advance("journals", next)
      }
      break
    }
    case "replay-closing": {
      await stageReplayClosing(
        db,
        input.plan,
        tenantId,
        input.actorId,
        input.sessionId,
        progress,
        input.replayTarget,
      )
      progress.advance("complete")
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

export type TallyJournalReversal = {
  posted: number
  failures: Array<{ sourceId: string; code: string; message: string }>
}

/**
 * Posts one reversing entry per voucher a session already applied.
 *
 * Debits and credits are swapped and the entry keeps the voucher's own date, so
 * the period the import posted to nets back to zero instead of the reversal
 * landing in a later period. The source key is the same one the stock reversal
 * uses, and the journal RPC is idempotent on it, so a retried rollback posts
 * each reversing entry once.
 */
export async function reverseTallyJournals(
  db: TallyApplyDb,
  input: {
    tenantId: string
    actorId: string
    vouchers: TallyCutoverVoucher[]
  },
): Promise<TallyJournalReversal> {
  const progress = new Progress(emptyProgress())
  const accounts = await loadAccounts(db, input.tenantId)
  let posted = 0

  for (const voucher of input.vouchers) {
    const reversed = await postJournal(db, {
      tenantId: input.tenantId,
      sourceType: "tally_replay_reversal",
      sourceId: `${voucher.sourceType}:${voucher.sourceId}`,
      date: voucher.date,
      description: `Reversal of the Tally import: ${voucher.description}`,
      currency: voucher.currency,
      actorId: input.actorId,
      lines: voucher.lines.map((line) => ({
        accountCode: line.accountCode,
        debit: line.credit,
        credit: line.debit,
        description: line.description,
      })),
      accounts,
      stage: "journals",
      progress,
    })
    if (reversed) posted += 1
  }

  return {
    posted,
    failures: progress.value.failures.map((failure) => ({
      sourceId: failure.key,
      code: failure.code,
      message: failure.message,
    })),
  }
}

export const __test__ = { money, escapeLike, isoDateTime, TALLY_APPLY_CHUNK, Progress }
