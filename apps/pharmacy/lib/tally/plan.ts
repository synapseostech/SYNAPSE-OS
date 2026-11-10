/**
 * Storage layout for a normalised cut-over plan.
 *
 * Preview normalises once and persists the result, so apply never re-parses the
 * upload and a resumed apply reads the same numbers the user reviewed.
 */

import type {
  TallyCutoverMovement,
  TallyCutoverPlan,
  TallyCutoverPurchase,
  TallyCutoverSale,
  TallyCutoverVoucher,
} from "@synapse/db/tally-normalise"
import { TALLY_SYSTEM_ACCOUNT_CODES } from "@synapse/db/tally-map"
import {
  buildReplayEvents,
  compareReplayMovements,
  reconcileReplay,
  simulateReplay,
} from "@synapse/db/tally-replay"
import type { TallyApplyStage } from "./apply"
import {
  TALLY_APPLY_CHUNK,
  type TallyPlanSummary,
  type TallyReplayDayCount,
  type TallyReplayTarget,
} from "./types"
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
  | "cutoffDate"
  | "ordering"
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
const MOVEMENT_CHUNK = "plan-movement-chunk"
const REPLAY_TARGET = "plan-replay-target"

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

/**
 * Replays the plan and places the position it reaches beside Tally's own
 * closing figures. The result is persisted once, so Apply checks against the
 * numbers the review showed rather than recomputing them from another input.
 */
export function buildReplayTarget(
  plan: TallyCutoverPlan,
  preparedAt: string,
): TallyReplayTarget {
  const events = buildReplayEvents(plan)
  const simulation = simulateReplay(plan)
  const reconciliation = reconcileReplay(simulation, plan)

  const perDay = new Map<string, TallyReplayDayCount>()
  for (const event of events) {
    const day = perDay.get(event.date) ?? { date: event.date, events: 0, movements: 0, kinds: {} }
    day.events += 1
    day.movements += event.movements.length
    day.kinds[event.kind] = (day.kinds[event.kind] ?? 0) + 1
    perDay.set(event.date, day)
  }

  const totals = { match: 0, difference: 0, notAvailable: 0 }
  for (const row of reconciliation.rows) {
    if (row.status === "match") totals.match += 1
    else if (row.status === "difference") totals.difference += 1
    else totals.notAvailable += 1
  }

  return {
    preparedAt,
    conversionDate: plan.conversionDate,
    cutoffDate: plan.cutoffDate ?? "",
    ordering: "date-then-export-order",
    eventCount: events.length,
    movementCount: (plan.movements ?? []).length,
    perDay: [...perDay.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    reconciliation: reconciliation.rows,
    totals,
    blocking: reconciliation.blocking,
    warnings: reconciliation.warnings,
    findings: simulation.findings,
    simulated: simulation.state,
    costs: simulation.lineCosts,
  }
}

export function summarisePlan(
  plan: TallyCutoverPlan,
  format: "xml" | "xlsx" | "xls" | "csv",
  chunkSize = TALLY_APPLY_CHUNK,
  replay?: TallyReplayTarget,
): TallyPlanSummary {
  return {
    // One timestamp for the whole preview: an acknowledgement made against
    // this summary must also match the replay target it was shown with.
    preparedAt: replay?.preparedAt ?? new Date().toISOString(),
    company: plan.company,
    companyKey: plan.companyKey,
    currency: plan.currency,
    conversionDate: plan.conversionDate,
    mode: plan.mode,
    batchExpiry: plan.batchExpiry ?? "source",
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
    ...(replay
      ? {
          replay: {
            cutoffDate: replay.cutoffDate,
            ordering: replay.ordering,
            eventCount: replay.eventCount,
            movementCount: replay.movementCount,
            movementChunkCount: Math.ceil(replay.movementCount / chunkSize),
            perDay: replay.perDay,
            reconciliation: replay.reconciliation,
            blocking: replay.blocking,
            warnings: replay.warnings,
          },
        }
      : {}),
    exceptions: plan.exceptions.map((entry) => ({
      code: entry.code,
      message: entry.message,
      detail: entry.detail,
      severity: entry.severity,
    })),
    ...(plan.exceptionCounts ? { exceptionCounts: plan.exceptionCounts } : {}),
    chunkCount: Math.max(1, Math.ceil(journalSources(plan).length / chunkSize)),
    chunkSize,
    warnings: plan.warnings,
  }
}

export async function writeTallyPlan(
  db: TallyStorageClient,
  tenantId: string,
  sessionId: string,
  plan: TallyCutoverPlan,
  format: "xml" | "xlsx" | "xls" | "csv",
): Promise<TallyPlanSummary> {
  const preparedAt = new Date().toISOString()
  const replay = plan.mode === "replay" ? buildReplayTarget(plan, preparedAt) : undefined
  const summary = summarisePlan(plan, format, TALLY_APPLY_CHUNK, replay)
  // The plan is JSON. A bucket that was set up for the export's XML alone
  // accepts every upload and then refuses to store this, after the whole file
  // has already been read.
  await ensureTallyBucket(db)

  const staticPlan: StaticPlan = {
    company: plan.company,
    companyKey: plan.companyKey,
    currency: plan.currency,
    conversionDate: plan.conversionDate,
    cutoffDate: plan.cutoffDate,
    ordering: plan.ordering,
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

  if (replay) {
    // Chronological, because FEFO at a sale depends on what had arrived by then.
    // A chunk applied out of order would consume a batch that did not exist yet
    // and then disagree with the simulation at closing.
    const movements = [...(plan.movements ?? [])].sort(compareReplayMovements)
    const movementChunks = Math.ceil(replay.movementCount / summary.chunkSize)
    for (let index = 0; index < movementChunks; index += 1) {
      const start = index * summary.chunkSize
      await writeTallyJson(
        db,
        tallyChunkPath(tenantId, sessionId, MOVEMENT_CHUNK, index),
        movements.slice(start, start + summary.chunkSize),
      )
    }
    await writeTallyJson(db, tallyChunkPath(tenantId, sessionId, REPLAY_TARGET), replay)
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

/** The replay figures the review, the gate and the closing check all read. */
export async function readTallyReplayTarget(
  db: TallyStorageClient,
  tenantId: string,
  sessionId: string,
): Promise<TallyReplayTarget | null> {
  return readTallyJson<TallyReplayTarget>(
    db,
    tallyChunkPath(tenantId, sessionId, REPLAY_TARGET),
  )
}

/** One movement chunk, as the timeline route pages through them. */
export async function readTallyMovementChunk(
  db: TallyStorageClient,
  tenantId: string,
  sessionId: string,
  index: number,
): Promise<TallyCutoverMovement[] | null> {
  return readTallyJson<TallyCutoverMovement[]>(
    db,
    tallyChunkPath(tenantId, sessionId, MOVEMENT_CHUNK, index),
  )
}

export type LoadedStagePlan = {
  plan: TallyCutoverPlan
  chunk?: PlanChunk
  totalChunks: number
  summary: TallyPlanSummary
  /** `replay-closing` only: the figures the closing check compares against. */
  replay?: TallyReplayTarget
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

  let movements: TallyCutoverMovement[] | undefined
  if (stage === "stock-history") {
    // A chunk that is missing past the last one means the movements ran out.
    movements = (await readTallyMovementChunk(db, tenantId, sessionId, chunkIndex)) ?? []
  }

  let replay: TallyReplayTarget | undefined
  if (stage === "journals" || stage === "stock-history" || stage === "replay-closing") {
    // Journals reads the cost each sale line's stock moved at, history reads
    // which negatives the operator acknowledged, and closing reads the
    // position to compare against. All three read the same saved artifact.
    replay = (await readTallyReplayTarget(db, tenantId, sessionId)) ?? undefined
    // Closing against nothing would compare the database with itself.
    if (stage === "replay-closing" && !replay) throw new Error("TALLY_PLAN_MISSING")
  }

  return {
    summary,
    totalChunks: summary.chunkCount,
    chunk,
    replay,
    plan: {
      ...staticPlan,
      vouchers: chunk?.vouchers ?? [],
      sales: chunk?.sales ?? [],
      purchases: chunk?.purchases ?? [],
      ...(movements ? { movements } : {}),
      exceptions: [],
    } as TallyCutoverPlan,
  }
}
