/**
 * Storage layout for a normalised cut-over plan.
 *
 * Preview normalises once and persists the result, so apply never re-parses the
 * upload and a resumed apply reads the same numbers the user reviewed.
 */

import type {
  TallyCutoverPlan,
  TallyCutoverPurchase,
  TallyCutoverSale,
  TallyCutoverVoucher,
} from "@synapse/db/tally-normalise"
import { TALLY_SYSTEM_ACCOUNT_CODES } from "@synapse/db/tally-map"
import type { TallyApplyStage } from "./apply"
import { TALLY_APPLY_CHUNK, type TallyPlanSummary } from "./types"
import {
  ensureTallyBucket,
  readTallyJson,
  tallyChunkPath,
  writeTallyJson,
  type TallyStorageClient,
} from "./storage"

type StaticPlan = Pick<
  TallyCutoverPlan,
  | "company"
  | "companyKey"
  | "currency"
  | "conversionDate"
  | "mode"
  | "accounts"
  | "parties"
  | "stockItems"
  | "stock"
  | "opening"
  | "counts"
  | "warnings"
>

type PlanChunk = {
  vouchers: TallyCutoverVoucher[]
  sales: TallyCutoverSale[]
  purchases: TallyCutoverPurchase[]
}

const SUMMARY = "plan-summary"
const STATIC = "plan-static"
const CHUNK = "plan-chunk"

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * The plan's own accounting, reduced to the figures a preflight compares.
 * Parties and the opening journal are built from the same ledgers, so the two
 * sides must agree; when they do not, one of them lost a balance.
 */
function reconciliationOf(plan: TallyCutoverPlan): NonNullable<TallyPlanSummary["reconciliation"]> {
  const partyCodes = (kind: "customer" | "supplier") =>
    new Set(plan.accounts.filter((account) => account.partyType === kind).map((account) => account.code))

  const customerCodes = partyCodes("customer")
  const supplierCodes = partyCodes("supplier")
  const inventoryCode = TALLY_SYSTEM_ACCOUNT_CODES.INVENTORY

  let customerOpening = 0
  let supplierOpening = 0
  let inventoryOpening: number | null = null

  for (const line of plan.opening.lines) {
    if (customerCodes.has(line.accountCode)) customerOpening += line.debit - line.credit
    if (supplierCodes.has(line.accountCode)) supplierOpening += line.credit - line.debit
    if (line.accountCode === inventoryCode) {
      inventoryOpening = (inventoryOpening ?? 0) + line.debit - line.credit
    }
  }

  let partyReceivable = 0
  let partyPayable = 0
  for (const party of plan.parties) {
    if (party.kind === "customer") partyReceivable += party.openingBalance
    else partyPayable += party.openingBalance
  }

  return {
    inventoryOpening: inventoryOpening === null ? null : round2(inventoryOpening),
    customerOpening: round2(customerOpening),
    supplierOpening: round2(supplierOpening),
    partyReceivable: round2(partyReceivable),
    partyPayable: round2(partyPayable),
    duplicateVouchers: plan.exceptions.filter((entry) => entry.code === "VOUCHER_DUPLICATE").length,
  }
}

/**
 * Every source the journals stage must visit. A posted voucher is one; a sale
 * or purchase a closing cut-over mirrors without posting has no voucher, so it
 * is added on its own or its history would never be written.
 */
function journalSources(plan: TallyCutoverPlan): string[] {
  const seen = new Set<string>()
  const sources: string[] = []
  for (const voucher of plan.vouchers) {
    if (seen.has(voucher.sourceId)) continue
    seen.add(voucher.sourceId)
    sources.push(voucher.sourceId)
  }
  for (const entry of [...plan.sales, ...plan.purchases]) {
    if (seen.has(entry.sourceId)) continue
    seen.add(entry.sourceId)
    sources.push(entry.sourceId)
  }
  return sources
}

export function summarisePlan(
  plan: TallyCutoverPlan,
  format: "xml" | "xlsx" | "xls" | "csv",
  chunkSize = TALLY_APPLY_CHUNK,
): TallyPlanSummary {
  return {
    company: plan.company,
    companyKey: plan.companyKey,
    currency: plan.currency,
    conversionDate: plan.conversionDate,
    mode: plan.mode,
    format,
    counts: plan.counts,
    opening: {
      date: plan.opening.date,
      totalDebit: plan.opening.totalDebit,
      totalCredit: plan.opening.totalCredit,
      difference: plan.opening.difference,
    },
    stock: plan.stock,
    reconciliation: reconciliationOf(plan),
    exceptions: plan.exceptions.map((entry) => ({
      code: entry.code,
      message: entry.message,
      detail: entry.detail,
      severity: entry.severity,
    })),
    chunkCount: Math.max(1, Math.ceil(journalSources(plan).length / chunkSize)),
    chunkSize,
    warnings: plan.warnings,
    preparedAt: new Date().toISOString(),
  }
}

export async function writeTallyPlan(
  db: TallyStorageClient,
  tenantId: string,
  sessionId: string,
  plan: TallyCutoverPlan,
  format: "xml" | "xlsx" | "xls" | "csv",
): Promise<TallyPlanSummary> {
  const summary = summarisePlan(plan, format)
  // The plan is JSON. A bucket that was set up for the export's XML alone
  // accepts every upload and then refuses to store this, after the whole file
  // has already been read.
  await ensureTallyBucket(db)

  const staticPlan: StaticPlan = {
    company: plan.company,
    companyKey: plan.companyKey,
    currency: plan.currency,
    conversionDate: plan.conversionDate,
    mode: plan.mode,
    accounts: plan.accounts,
    parties: plan.parties,
    stockItems: plan.stockItems,
    stock: plan.stock,
    opening: plan.opening,
    counts: plan.counts,
    warnings: plan.warnings,
  }

  const saleBySource = new Map(plan.sales.map((sale) => [sale.sourceId, sale]))
  const purchaseBySource = new Map(plan.purchases.map((entry) => [entry.sourceId, entry]))
  const voucherBySource = new Map(plan.vouchers.map((voucher) => [voucher.sourceId, voucher]))
  const sources = journalSources(plan)

  for (let index = 0; index < summary.chunkCount; index += 1) {
    const start = index * summary.chunkSize
    const slice = sources.slice(start, start + summary.chunkSize)
    const chunk: PlanChunk = {
      vouchers: slice
        .map((sourceId) => voucherBySource.get(sourceId))
        .filter((voucher): voucher is TallyCutoverVoucher => Boolean(voucher)),
      sales: slice
        .map((sourceId) => saleBySource.get(sourceId))
        .filter((sale): sale is TallyCutoverSale => Boolean(sale)),
      purchases: slice
        .map((sourceId) => purchaseBySource.get(sourceId))
        .filter((entry): entry is TallyCutoverPurchase => Boolean(entry)),
    }
    await writeTallyJson(db, tallyChunkPath(tenantId, sessionId, CHUNK, index), chunk)
  }

  await writeTallyJson(db, tallyChunkPath(tenantId, sessionId, STATIC), staticPlan)
  await writeTallyJson(db, tallyChunkPath(tenantId, sessionId, SUMMARY), summary)
  return summary
}

export async function readTallyPlanSummary(
  db: TallyStorageClient,
  tenantId: string,
  sessionId: string,
): Promise<TallyPlanSummary | null> {
  return readTallyJson<TallyPlanSummary>(db, tallyChunkPath(tenantId, sessionId, SUMMARY))
}

export type LoadedStagePlan = {
  plan: TallyCutoverPlan
  chunk?: PlanChunk
  totalChunks: number
  summary: TallyPlanSummary
}

/** Loads exactly what one apply stage needs. */
export async function loadStagePlan(
  db: TallyStorageClient,
  tenantId: string,
  sessionId: string,
  stage: TallyApplyStage,
  chunkIndex: number,
): Promise<LoadedStagePlan> {
  const summary = await readTallyPlanSummary(db, tenantId, sessionId)
  if (!summary) throw new Error("TALLY_PLAN_MISSING")

  const staticPlan = await readTallyJson<StaticPlan>(
    db,
    tallyChunkPath(tenantId, sessionId, STATIC),
  )
  if (!staticPlan) throw new Error("TALLY_PLAN_MISSING")

  let chunk: PlanChunk | undefined
  if (stage === "journals") {
    const loaded = await readTallyJson<PlanChunk>(
      db,
      tallyChunkPath(tenantId, sessionId, CHUNK, chunkIndex),
    )
    // An empty chunk is a valid checkpoint: the source had no vouchers.
    chunk = loaded ?? { vouchers: [], sales: [], purchases: [] }
  }

  return {
    summary,
    totalChunks: summary.chunkCount,
    chunk,
    plan: {
      ...staticPlan,
      vouchers: chunk?.vouchers ?? [],
      sales: chunk?.sales ?? [],
      purchases: chunk?.purchases ?? [],
      exceptions: [],
    } as TallyCutoverPlan,
  }
}
