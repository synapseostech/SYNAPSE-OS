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
import type { TallyApplyStage } from "./apply"
import { TALLY_APPLY_CHUNK, type TallyPlanSummary } from "./types"
import {
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
  | "accounts"
  | "parties"
  | "stockItems"
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

export function summarisePlan(
  plan: TallyCutoverPlan,
  format: "xml" | "xlsx" | "csv",
  chunkSize = TALLY_APPLY_CHUNK,
): TallyPlanSummary {
  return {
    company: plan.company,
    companyKey: plan.companyKey,
    currency: plan.currency,
    conversionDate: plan.conversionDate,
    format,
    counts: plan.counts,
    opening: {
      date: plan.opening.date,
      totalDebit: plan.opening.totalDebit,
      totalCredit: plan.opening.totalCredit,
      difference: plan.opening.difference,
    },
    exceptions: plan.exceptions.map((entry) => ({
      code: entry.code,
      message: entry.message,
      detail: entry.detail,
      severity: entry.severity,
    })),
    chunkCount: Math.max(1, Math.ceil(plan.vouchers.length / chunkSize)),
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
  format: "xml" | "xlsx" | "csv",
): Promise<TallyPlanSummary> {
  const summary = summarisePlan(plan, format)

  const staticPlan: StaticPlan = {
    company: plan.company,
    companyKey: plan.companyKey,
    currency: plan.currency,
    conversionDate: plan.conversionDate,
    accounts: plan.accounts,
    parties: plan.parties,
    stockItems: plan.stockItems,
    opening: plan.opening,
    counts: plan.counts,
    warnings: plan.warnings,
  }

  const saleBySource = new Map(plan.sales.map((sale) => [sale.sourceId, sale]))
  const purchaseBySource = new Map(plan.purchases.map((entry) => [entry.sourceId, entry]))

  for (let index = 0; index < summary.chunkCount; index += 1) {
    const start = index * summary.chunkSize
    const vouchers = plan.vouchers.slice(start, start + summary.chunkSize)
    const chunk: PlanChunk = {
      vouchers,
      sales: vouchers.map((voucher) => saleBySource.get(voucher.sourceId)).filter((sale): sale is TallyCutoverSale => Boolean(sale)),
      purchases: vouchers
        .map((voucher) => purchaseBySource.get(voucher.sourceId))
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
