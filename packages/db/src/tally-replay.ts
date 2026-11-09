/**
 * Replays a normalised Tally plan in sequence and compares the position it
 * reaches with the figures Tally itself exports.
 *
 * Nothing here touches a database. The simulation is what the review shows and
 * what Apply verifies against: if the replay cannot reach Tally's closing
 * position, the difference is named before any row is written.
 *
 * Ordering is `(date, export order)`. Tally exposes no clock time, so the
 * sequence is reproducible, not a reconstruction of the day's real order.
 */

import type { TallyVoucherKind } from "./tally-map"
import type {
  TallyCutoverJournalLine,
  TallyCutoverMovement,
  TallyCutoverPlan,
} from "./tally-normalise"

export type TallyReplayEvent = {
  eventId: string
  type: "opening" | "voucher" | "movement"
  /** The Tally document kind, so the review can count a day by kind. */
  kind: TallyVoucherKind
  date: string
  sourceOrder: number
  sourceId: string
  description: string
  /** Ledger posting lines; empty for a movement that posts nothing. */
  lines: TallyCutoverJournalLine[]
  movements: TallyCutoverMovement[]
}

export type TallyReplayFinding = {
  code:
    | "REPLAY_NEGATIVE_STOCK"
    | "REPLAY_EXPIRED_BATCH_CONSUMED"
    | "REPLAY_UNKNOWN_BATCH_FOR_OUT"
  severity: "blocking" | "warning"
  date: string
  sourceId: string
  movementId: string
  stockItemName: string
  quantityBefore: number
  quantityAfter: number
  message: string
}

export type TallyReplayStockBatchState = {
  batchNumber?: string
  expiryDate?: string
  receivedDate: string
  quantity: number
  value: number
}

export type TallyReplayStockItemState = {
  stockItemName: string
  quantity: number
  value: number
  batches: TallyReplayStockBatchState[]
}

export type TallyReplayState = {
  /** Account code → signed balance, positive on the debit side. */
  accounts: Record<string, number>
  items: TallyReplayStockItemState[]
  sourceIdsByItem: Record<string, string[]>
  sourceIdsByAccount: Record<string, string[]>
  eventCount: number
  firstEventDate?: string
  lastEventDate?: string
}

export type TallyReplayReconciliationRow = {
  scope: "stock_item" | "stock_total" | "account"
  key: string
  expected: number | null
  actual: number | null
  difference: number | null
  status: "match" | "difference" | "not-available"
  tolerance: number
  /** The event a finding proved the divergence at, when one did. */
  firstDivergence?: { date: string; sourceId: string; movementId?: string }
  sourceIds: string[]
}

export type TallyReplayReconciliation = {
  rows: TallyReplayReconciliationRow[]
  blocking: number
  warnings: number
  tolerance: { quantity: 0; value: 0.01 }
}

export type TallyReplayOptions = {
  /** A configuration where Tally itself allowed negative stock must say so. */
  allowNegativeStock?: boolean
}

/**
 * What the stock a sale line removed cost, taken from the batch values the
 * replay itself built up from Tally's purchase rates. Keyed `sourceId:Lline`.
 *
 * `complete` is false when any part of the line was filled from stock the
 * replay could not cost — a shortage. A partial cost is not written, because a
 * profit report cannot tell an approximation from a measured figure.
 */
export type TallyReplayLineCost = {
  amount: number
  complete: boolean
}

export type TallyReplaySimulation = {
  state: TallyReplayState
  findings: TallyReplayFinding[]
  lineCosts: Record<string, TallyReplayLineCost>
}

const OPENING_SOURCE = "opening"
const PHYSICAL_BATCH_KEY = "PHYSICAL"
const NEGATIVE_BATCH_KEY = "NEGATIVE"
const NO_EXPIRY = "9999-12-31"

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100)
}

/**
 * The order movements must be written in for the database to reach the state
 * the simulation reached. Tally states nothing finer than the day, so same-day
 * vouchers keep the export's own order; a movement's line and batch place it
 * inside its voucher.
 */
export function compareReplayMovements(
  a: TallyCutoverMovement,
  b: TallyCutoverMovement,
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder
  if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1
  if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex
  return a.batchIndex - b.batchIndex
}

function openingMovement(
  plan: TallyCutoverPlan,
  stockItemName: string,
  batchIndex: number,
  quantity: number,
  batchNumber: string | undefined,
  expiryDate: string | undefined,
  value: number,
): TallyCutoverMovement {
  const movementId = `${plan.conversionDate}:OPENING:B${batchIndex}`
  return {
    movementId,
    sourceId: OPENING_SOURCE,
    kind: "other",
    movementKind: "opening",
    date: plan.conversionDate,
    sourceOrder: -1,
    lineIndex: 0,
    batchIndex,
    stockItemName,
    quantityDelta: quantity,
    batchNumber,
    expiryDate,
    rate: quantity === 0 ? 0 : round2(value / quantity),
    amount: round2(value),
    allocation: batchNumber ? "explicit" : "synthetic",
  }
}

/**
 * The whole sequence: opening first, then every voucher and movement in
 * `(date, export order)`.
 */
export function buildReplayEvents(plan: TallyCutoverPlan): TallyReplayEvent[] {
  const openingMovements: TallyCutoverMovement[] = []
  for (const item of plan.stockItems) {
    if (item.quantity === undefined || item.quantity <= 0) continue
    // The opening value is held per item, so each batch takes its share.
    const unitValue =
      item.value !== undefined && item.quantity !== 0
        ? item.value / item.quantity
        : (item.rate ?? 0)
    for (const [batchIndex, batch] of item.batches.entries()) {
      if (!batch.receivable || batch.quantity === undefined || batch.quantity <= 0) continue
      openingMovements.push(
        openingMovement(
          plan,
          item.sourceName,
          batchIndex,
          batch.quantity,
          batch.batchName,
          batch.expiryDate,
          unitValue * batch.quantity,
        ),
      )
    }
  }

  const events = new Map<string, TallyReplayEvent>()
  events.set(OPENING_SOURCE, {
    eventId: OPENING_SOURCE,
    type: "opening",
    kind: "other",
    date: plan.conversionDate,
    sourceOrder: -1,
    sourceId: OPENING_SOURCE,
    description: `Opening balances and stock at ${plan.conversionDate}`,
    lines: plan.opening.lines,
    movements: openingMovements,
  })

  for (const [index, voucher] of plan.vouchers.entries()) {
    events.set(voucher.sourceId, {
      eventId: voucher.sourceId,
      type: "voucher",
      kind: voucher.kind,
      date: voucher.date,
      sourceOrder: index,
      sourceId: voucher.sourceId,
      description: voucher.description,
      lines: voucher.lines,
      movements: [],
    })
  }

  for (const movement of plan.movements ?? []) {
    const existing = events.get(movement.sourceId)
    if (existing) {
      existing.movements.push(movement)
      existing.sourceOrder = movement.sourceOrder
      continue
    }
    // A stock journal posts no ledger lines, so its event is the movement.
    events.set(movement.sourceId, {
      eventId: movement.sourceId,
      type: "movement",
      kind: movement.kind,
      date: movement.date,
      sourceOrder: movement.sourceOrder,
      sourceId: movement.sourceId,
      description: `${movement.kind} movement`,
      lines: [],
      movements: [movement],
    })
  }

  return [...events.values()].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0
  })
}

type InternalBatch = {
  batchNumber?: string
  expiryDate?: string
  receivedDate: string
  quantity: number
  value: number
}

type InternalItem = {
  stockItemName: string
  batches: Map<string, InternalBatch>
}

type TallyFefoBatchShape = {
  batchNumber?: string
  expiryDate?: string
  receivedDate: string
  quantity: number
}

export type TallyFefoTake<T extends TallyFefoBatchShape = TallyFefoBatchShape> = {
  batch: T
  quantity: number
  /** False when the batch was expired or not yet received on the event date. */
  eligible: boolean
}

function fefoOrder(a: TallyFefoBatchShape, b: TallyFefoBatchShape): number {
  const aExpiry = a.expiryDate ?? NO_EXPIRY
  const bExpiry = b.expiryDate ?? NO_EXPIRY
  if (aExpiry !== bExpiry) return aExpiry < bExpiry ? -1 : 1
  if (a.receivedDate !== b.receivedDate) return a.receivedDate < b.receivedDate ? -1 : 1
  const aBatch = a.batchNumber ?? ""
  const bBatch = b.batchNumber ?? ""
  return aBatch < bBatch ? -1 : aBatch > bBatch ? 1 : 0
}

/**
 * First-expiry-first-out among batches that existed on the event date.
 *
 * Exported because Apply must reach the same batch the simulation did: a sale
 * the review showed as coming off batch A cannot come off batch B in the
 * database. When nothing eligible is left, the remaining takes come from
 * whatever is positive (expired or not yet received), marked `eligible: false`
 * so the caller can report it.
 */
export function chooseFefo<T extends TallyFefoBatchShape>(
  batches: readonly T[],
  quantity: number,
  eventDate: string,
): Array<TallyFefoTake<T>> {
  const positive = batches.filter((batch) => batch.quantity > 0)
  const eligible = positive
    .filter(
      (batch) =>
        batch.receivedDate <= eventDate &&
        (!batch.expiryDate || batch.expiryDate >= eventDate),
    )
    .sort(fefoOrder)
  const eligibleBatches = new Set<T>(eligible)
  const fallback = positive
    .filter((batch) => !eligibleBatches.has(batch))
    .sort(fefoOrder)

  let remaining = quantity
  const takes: Array<TallyFefoTake<T>> = []
  for (const batch of [...eligible, ...fallback]) {
    if (remaining <= 0) break
    const take = Math.min(batch.quantity, remaining)
    takes.push({ batch, quantity: take, eligible: eligibleBatches.has(batch) })
    remaining -= take
  }
  return takes
}

function itemQuantity(item: InternalItem): number {
  let total = 0
  for (const batch of item.batches.values()) total += batch.quantity
  return total
}

function itemValue(item: InternalItem): number {
  let total = 0
  for (const batch of item.batches.values()) total += batch.value
  return total
}

/**
 * Replays the plan and reports where the running stock and ledger reach.
 *
 * A sale without batch allocations is satisfied first-expiry-first-out among
 * batches received on or before that event and not expired on it. When nothing
 * sellable is left, the shortage is a finding: blocking unless the session
 * says this Tally configuration allowed negative stock.
 */
export function simulateReplay(
  plan: TallyCutoverPlan,
  options: TallyReplayOptions = {},
): TallyReplaySimulation {
  const allowNegative = options.allowNegativeStock === true
  const accounts = new Map<string, number>()
  const items = new Map<string, InternalItem>()
  const sourceIdsByItem: Record<string, string[]> = {}
  const sourceIdsByAccount: Record<string, string[]> = {}
  const findings: TallyReplayFinding[] = []
  const lineCosts: Record<string, TallyReplayLineCost> = {}
  const events = buildReplayEvents(plan)
  let firstEventDate: string | undefined
  let lastEventDate: string | undefined

  const noteSource = (record: Record<string, string[]>, key: string, sourceId: string) => {
    const list = record[key] ?? (record[key] = [])
    if (list[list.length - 1] !== sourceId) list.push(sourceId)
  }

  const postLines = (sourceId: string, lines: TallyCutoverJournalLine[]) => {
    for (const line of lines) {
      accounts.set(line.accountCode, (accounts.get(line.accountCode) ?? 0) + cents(line.debit) - cents(line.credit))
      noteSource(sourceIdsByAccount, line.accountCode, sourceId)
    }
  }

  /**
   * A sale line's cost is recorded once per batch allocation; a line split
   * across batches adds up, and any uncosted part makes the whole line
   * unquotable.
   */
  const recordLineCost = (
    movement: TallyCutoverMovement,
    amount: number,
    complete: boolean,
  ) => {
    if (movement.movementKind !== "sale_out") return
    const key = `${movement.sourceId}:L${movement.lineIndex}`
    const existing = lineCosts[key] ?? { amount: 0, complete: true }
    existing.amount = round2(existing.amount + amount)
    existing.complete = existing.complete && complete
    lineCosts[key] = existing
  }

  const itemFor = (stockItemName: string): InternalItem => {
    const existing = items.get(stockItemName)
    if (existing) return existing
    const created: InternalItem = { stockItemName, batches: new Map() }
    items.set(stockItemName, created)
    return created
  }

  const batchFor = (item: InternalItem, movement: TallyCutoverMovement): InternalBatch => {
    const key =
      movement.batchNumber ??
      (movement.movementKind === "physical_adjust" ? PHYSICAL_BATCH_KEY : movement.movementId)
    const existing = item.batches.get(key)
    if (existing) return existing
    const created: InternalBatch = {
      batchNumber: movement.batchNumber,
      expiryDate: movement.expiryDate,
      receivedDate: movement.date,
      quantity: 0,
      value: 0,
    }
    item.batches.set(key, created)
    return created
  }

  const takeFromBatch = (batch: InternalBatch, quantity: number): number => {
    const cost = batch.quantity > 0 ? (batch.value * quantity) / batch.quantity : 0
    batch.quantity -= quantity
    batch.value = round2(batch.value - cost)
    if (batch.quantity <= 0) {
      batch.quantity = 0
      batch.value = 0
    }
    return cost
  }

  const shortfall = (item: InternalItem, movement: TallyCutoverMovement, remaining: number) => {
    const before = itemQuantity(item)
    // The batch Tally named, or a holding batch for an unnamed shortage, keeps
    // the negative where the export shows it instead of hiding it elsewhere.
    const batch = movement.batchNumber
      ? batchFor(item, movement)
      : batchFor(item, { ...movement, batchNumber: NEGATIVE_BATCH_KEY })
    batch.quantity -= remaining
    batch.value = round2(batch.value - movement.rate * remaining)
    findings.push({
      code: "REPLAY_NEGATIVE_STOCK",
      severity: allowNegative ? "warning" : "blocking",
      date: movement.date,
      sourceId: movement.sourceId,
      movementId: movement.movementId,
      stockItemName: item.stockItemName,
      quantityBefore: before,
      quantityAfter: itemQuantity(item),
      message: allowNegative
        ? `Sale of "${item.stockItemName}" on ${movement.date} leaves ${round2(itemQuantity(item))} on hand. This session allows negative stock.`
        : `Sale of "${item.stockItemName}" on ${movement.date} exceeds the stock on hand, leaving ${round2(itemQuantity(item))}. Correct the vouchers in Tally, or acknowledge that this configuration allowed negative stock.`,
    })
  }

  const consumeOut = (item: InternalItem, movement: TallyCutoverMovement, quantity: number) => {
    let cost = 0
    let complete = true
    // Tally names the batch, so the sale leaves that batch even if it runs it
    // negative. Borrowing from a different batch would silently rewrite which
    // stock left the shelf.
    if (movement.allocation !== "fefo" && movement.batchNumber) {
      const named = [...item.batches.values()].find(
        (batch) => batch.batchNumber === movement.batchNumber,
      )
      if (named) {
        const take = Math.min(named.quantity, quantity)
        cost += takeFromBatch(named, take)
        if (quantity > take) {
          complete = false
          shortfall(item, movement, quantity - take)
        }
        recordLineCost(movement, cost, complete)
        return
      }
      findings.push({
        code: "REPLAY_UNKNOWN_BATCH_FOR_OUT",
        severity: "warning",
        date: movement.date,
        sourceId: movement.sourceId,
        movementId: movement.movementId,
        stockItemName: item.stockItemName,
        quantityBefore: itemQuantity(item),
        quantityAfter: itemQuantity(item),
        message: `Sale of "${item.stockItemName}" names batch ${movement.batchNumber}, which was never received in this replay. The line is allocated first-expiry-first-out instead.`,
      })
    }

    let remaining = quantity
    const takes = chooseFefo([...item.batches.values()], quantity, movement.date)
    for (const take of takes) {
      cost += takeFromBatch(take.batch, take.quantity)
      remaining -= take.quantity
      // Nothing sellable was left, so the remainder came from stock that was
      // expired or not yet received on that date. Tally allowed it; the review
      // must say so out loud.
      if (!take.eligible) {
        findings.push({
          code: "REPLAY_EXPIRED_BATCH_CONSUMED",
          severity: "warning",
          date: movement.date,
          sourceId: movement.sourceId,
          movementId: movement.movementId,
          stockItemName: item.stockItemName,
          quantityBefore: itemQuantity(item) + take.quantity,
          quantityAfter: itemQuantity(item),
          message: `Sale of "${item.stockItemName}" on ${movement.date} was filled from a batch that was expired or not yet received on that date.`,
        })
      }
    }

    if (remaining > 0) {
      complete = false
      shortfall(item, movement, remaining)
    }
    recordLineCost(movement, cost, complete)
  }

  const applyMovement = (movement: TallyCutoverMovement) => {
    const item = itemFor(movement.stockItemName)
    const before = itemQuantity(item)
    noteSource(sourceIdsByItem, item.stockItemName, movement.sourceId)

    if (movement.movementKind === "physical_adjust") {
      // The line is the counted quantity, not a difference. It becomes a
      // signed delta so the write Apply repeats stays order-safe.
      const target = movement.quantityDelta
      const batch = batchFor(item, movement)
      const delta = target - itemQuantity(item)
      batch.quantity = round2(batch.quantity + delta)
      batch.value = round2(batch.value + delta * movement.rate)
      batch.receivedDate = movement.date
      if (target < 0) {
        findings.push({
          code: "REPLAY_NEGATIVE_STOCK",
          severity: allowNegative ? "warning" : "blocking",
          date: movement.date,
          sourceId: movement.sourceId,
          movementId: movement.movementId,
          stockItemName: item.stockItemName,
          quantityBefore: before,
          quantityAfter: itemQuantity(item),
          message: `Physical stock for "${item.stockItemName}" on ${movement.date} counts ${target}, which cannot be on hand.`,
        })
      }
      return
    }

    if (movement.quantityDelta < 0) {
      consumeOut(item, movement, Math.abs(movement.quantityDelta))
      return
    }

    const batch = batchFor(item, movement)
    batch.quantity += movement.quantityDelta
    batch.value = round2(batch.value + movement.amount)
    if (!batch.expiryDate) batch.expiryDate = movement.expiryDate
  }

  for (const event of events) {
    firstEventDate ??= event.date
    lastEventDate = event.date
    postLines(event.sourceId, event.lines)
    for (const movement of event.movements) applyMovement(movement)
  }

  const accountObject: Record<string, number> = {}
  for (const [code, balance] of accounts.entries()) accountObject[code] = round2(balance / 100)

  return {
    state: {
      accounts: accountObject,
      items: [...items.values()]
        .sort((a, b) => (a.stockItemName < b.stockItemName ? -1 : a.stockItemName > b.stockItemName ? 1 : 0))
        .map((item) => ({
          stockItemName: item.stockItemName,
          quantity: round2(itemQuantity(item)),
          value: round2(itemValue(item)),
          batches: [...item.batches.values()]
            .sort(fefoOrder)
            .map((batch) => ({
              batchNumber: batch.batchNumber,
              expiryDate: batch.expiryDate,
              receivedDate: batch.receivedDate,
              quantity: round2(batch.quantity),
              value: round2(batch.value),
            })),
        })),
      sourceIdsByItem,
      sourceIdsByAccount,
      eventCount: events.length,
      firstEventDate,
      lastEventDate,
    },
    findings,
    lineCosts,
  }
}

function stockRow(
  key: string,
  expected: number | null | undefined,
  actual: number | undefined,
  tolerance: number,
  rounding: "integer" | "cents",
  sourceIds: string[],
): TallyReplayReconciliationRow {
  if (expected === null || expected === undefined) {
    return {
      scope: "stock_item",
      key,
      expected: null,
      actual: actual === undefined ? null : round2(actual),
      difference: null,
      status: "not-available",
      tolerance,
      sourceIds,
    }
  }
  const basis = rounding === "integer" ? (value: number) => Math.round(value) : round2
  const actualValue = basis(actual ?? 0)
  const difference = round2(actualValue - basis(expected))
  const matched = rounding === "integer" ? difference === 0 : Math.abs(difference) <= tolerance
  return {
    scope: "stock_item",
    key,
    expected: basis(expected),
    actual: actualValue,
    difference,
    status: matched ? "match" : "difference",
    tolerance,
    sourceIds,
  }
}

/**
 * Places the simulated position beside Tally's own closing figures.
 *
 * Every figure is a row of its own and a figure the export does not carry is
 * `not-available`, never a pass. Quantity must agree exactly; money within a
 * cent.
 */
export function reconcileReplay(
  simulation: TallyReplaySimulation,
  plan: TallyCutoverPlan,
): TallyReplayReconciliation {
  const { state, findings } = simulation
  const rows: TallyReplayReconciliationRow[] = []
  const itemBySource = state.sourceIdsByItem

  const simulatedItems = new Map(state.items.map((item) => [item.stockItemName, item]))
  const seenItems = new Set<string>()

  for (const item of plan.stockItems) {
    seenItems.add(item.sourceName)
    const actual = simulatedItems.get(item.sourceName)
    const sourceIds = itemBySource[item.sourceName] ?? []
    const finding = findings.find(
      (entry) => entry.stockItemName === item.sourceName && entry.severity === "blocking",
    )

    rows.push({
      ...stockRow(
        item.sourceName,
        item.closingQuantity,
        actual?.quantity,
        0,
        "integer",
        sourceIds,
      ),
      ...(finding
        ? {
            firstDivergence: {
              date: finding.date,
              sourceId: finding.sourceId,
              movementId: finding.movementId,
            },
          }
        : {}),
    })
    if (item.closingValue !== undefined) {
      rows.push(
        stockRow(`${item.sourceName} (value)`, item.closingValue, actual?.value, 0.01, "cents", sourceIds),
      )
    }
  }

  // Stock that moved but has no master line is reported rather than dropped.
  for (const item of state.items) {
    if (seenItems.has(item.stockItemName)) continue
    rows.push({
      scope: "stock_item",
      key: item.stockItemName,
      expected: null,
      actual: round2(item.quantity),
      difference: null,
      status: "not-available",
      tolerance: 0,
      sourceIds: itemBySource[item.stockItemName] ?? [],
    })
  }

  const actualStockValue = round2(state.items.reduce((total, item) => total + item.value, 0))
  rows.push({
    scope: "stock_total",
    key: "stock value",
    expected: plan.stock.closingValue,
    actual: actualStockValue,
    difference:
      plan.stock.closingValue === null ? null : round2(actualStockValue - plan.stock.closingValue),
    status:
      plan.stock.closingValue === null
        ? "not-available"
        : Math.abs(actualStockValue - plan.stock.closingValue) <= 0.01
          ? "match"
          : "difference",
    tolerance: 0.01,
    sourceIds: [],
  })

  const seenAccounts = new Set<string>()
  for (const account of plan.accounts) {
    const actual = state.accounts[account.code]
    if (account.closingBalance === undefined && (actual === undefined || actual === 0)) continue
    seenAccounts.add(account.code)
    const sourceIds = state.sourceIdsByAccount[account.code] ?? []
    if (account.closingBalance === undefined) {
      rows.push({
        scope: "account",
        key: `${account.code} ${account.name}`,
        expected: null,
        actual: actual ?? 0,
        difference: null,
        status: "not-available",
        tolerance: 0.01,
        sourceIds,
      })
      continue
    }
    const difference = round2((actual ?? 0) - account.closingBalance)
    rows.push({
      scope: "account",
      key: `${account.code} ${account.name}`,
      expected: account.closingBalance,
      actual: round2(actual ?? 0),
      difference,
      status: Math.abs(difference) <= 0.01 ? "match" : "difference",
      tolerance: 0.01,
      sourceIds,
    })
  }
  for (const [code, balance] of Object.entries(state.accounts)) {
    if (seenAccounts.has(code) || balance === 0) continue
    rows.push({
      scope: "account",
      key: code,
      expected: null,
      actual: balance,
      difference: null,
      status: "not-available",
      tolerance: 0.01,
      sourceIds: state.sourceIdsByAccount[code] ?? [],
    })
  }

  const blocking =
    rows.filter((row) => row.status === "difference").length +
    findings.filter((entry) => entry.severity === "blocking").length
  const warnings = findings.filter((entry) => entry.severity === "warning").length

  return {
    rows,
    blocking,
    warnings,
    tolerance: { quantity: 0, value: 0.01 },
  }
}
