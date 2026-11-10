/**
 * Turns a parsed Tally document into the cut-over plan the pharmacy importer
 * executes: mapped accounts, party bills, opening journal, opening stock,
 * historical journals and reporting mirrors.
 *
 * Nothing here writes to a database. The plan is the review surface: every
 * skipped voucher, missing expiry and unbalanced opening is reported rather
 * than repaired, and the opening journal is never plugged.
 */

import {
  classifyTallyLedger,
  classifyTallyVoucherType,
  isCashOrBankRole,
  mapTallyLedgers,
  normaliseTallyKey,
  paymentMethodForRole,
  stableHash,
  tallyAccountCode,
  tallyVoucherSourceType,
  type TallyAccountOverrides,
  type TallyAccountRole,
  type TallyAccountType,
  type TallyLedgerClassification,
  type TallyMappedAccount,
  type TallyNormalBalance,
  type TallyVoucherKind,
} from "./tally-map"
import type {
  TallyBillAllocation,
  TallyInventoryLine,
  TallyLedger,
  TallyLedgerLine,
  TallyVoucher,
  TallyXmlDocument,
  TallyXmlRowWarning,
} from "./tally-xml-rows"

export type TallyExceptionCode =
  | "COMPANY_MISSING"
  | "SOURCE_TRUNCATED"
  | "CONVERSION_DATE_REQUIRED"
  | "UNCLASSIFIED_LEDGER"
  | "LEDGER_MISSING"
  | "LEDGER_INFERRED"
  | "PARTY_INFERRED"
  | "DUPLICATE_LEDGER"
  | "OPENING_DIFFERENCE"
  | "OPENING_BALANCE_UNAVAILABLE"
  | "OPENING_STOCK_WITHOUT_EXPIRY"
  | "OPENING_STOCK_EXPIRED"
  | "OPENING_STOCK_WITHOUT_VALUE"
  | "OPENING_STOCK_WITHOUT_QUANTITY"
  | "OPENING_STOCK_QUANTITY_MISMATCH"
  | "CLOSING_STOCK_BATCHES_UNAVAILABLE"
  | "CLOSING_PERIOD_MISMATCH"
  | "CLOSING_PERIOD_UNKNOWN"
  | "CLOSING_MODE_HISTORY_ONLY"
  | "STOCK_CLOSING_VALUE_MISSING"
  | "NON_INTEGER_QUANTITY"
  | "PARTY_OPENING_OPPOSITE_SIDE"
  | "PARTY_BILLS_MISMATCH"
  | "VOUCHER_BEFORE_CONVERSION"
  | "VOUCHER_DATE_MISSING"
  | "VOUCHER_UNBALANCED"
  | "VOUCHER_ZERO_VALUE"
  | "VOUCHER_CANCELLED"
  | "VOUCHER_DUPLICATE"
  | "VOUCHER_GUID_MISSING"
  | "VOUCHER_TYPE_UNSUPPORTED"
  | "MULTI_CURRENCY_UNSUPPORTED"
  | "PARTY_MISSING"
  | "SALE_LINES_MISSING"
  | "SALE_LINE_SKIPPED"
  | "STOCK_LINE_WITHOUT_QUANTITY"
  | "CREDIT_SALE_NOT_MIRRORED"
  | "COST_UNKNOWN"
  | "PURCHASE_LINE_SKIPPED"
  | "REPLAY_PERIOD_REQUIRED"
  | "REPLAY_PERIOD_INVALID"
  | "REPLAY_PERIOD_MISMATCH"
  | "REPLAY_VOUCHER_AFTER_CUTOFF"
  | "REPLAY_STOCK_JOURNAL_DIRECTION_UNKNOWN"
  | "REPLAY_INVENTORY_NOTE_IGNORED"
  | "REPLAY_ORDER_IGNORED"
  | "REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER"
  | "REPLAY_MOVEMENT_WITHOUT_QUANTITY"
  | "REPLAY_MOVEMENT_EXPIRY_MISSING"
  | "REPLAY_BATCH_EXPIRY_NOT_SUPPLIED"
  | "REPLAY_NON_INTEGER_QUANTITY"
  | "REPLAY_SYNTHETIC_BATCH"
  | "REPLAY_BATCH_IDENTITY_RECONSTRUCTED"
  | "BATCH_EXPIRY_CONFLICT"
  | "ENTERED_BY_NOT_MAPPED"
  | "COST_CENTRE_NOT_MAPPED"
  | "EXCEPTION_LIMIT_REACHED"

export type TallyException = {
  code: TallyExceptionCode
  severity: "blocking" | "warning"
  message: string
  detail?: string
}

export type TallyCutoverAccount = {
  sourceName: string
  code: string
  name: string
  accountType: TallyAccountType
  normalBalance: TallyNormalBalance
  role: TallyAccountRole
  systemKey?: string
  partyType?: "customer" | "supplier"
  unclassified: boolean
  sourceGuid?: string
  openingBalance: number
  openingSide: "debit" | "credit" | "none"
  openingMethod: "exported" | "derived" | "closing" | "none"
  closingBalance?: number
}

export type TallyCutoverPartyBill = {
  reference?: string
  amount: number
  dueDate?: string
  billType?: string
  dueDateDerived: boolean
}

export type TallyCutoverParty = {
  kind: "customer" | "supplier"
  name: string
  accountCode: string
  email?: string
  phone?: string
  address?: string
  openingBalance: number
  bills: TallyCutoverPartyBill[]
}

export type TallyCutoverStockBatch = {
  batchName?: string
  expiryDate?: string
  quantity?: number
  /**
   * True when the batch can be received by `receive_pharmacy_stock`: it has a
   * name, a future expiry and a positive whole quantity. Expired opening stock
   * is reported and skipped rather than rejected mid-import.
   */
  receivable: boolean
}

export type TallyCutoverStockItem = {
  sourceName: string
  sku: string
  name: string
  unit?: string
  /** Posted as the opening quantity. Closing mode takes Tally's closing figure here. */
  quantity?: number
  rate?: number
  value?: number
  /** Exported closing figures: posted in closing mode, shown only in opening mode. */
  closingQuantity?: number
  closingValue?: number
  batches: TallyCutoverStockBatch[]
}

/**
 * Tally's own stock valuation for the exported period, as the profit and loss
 * account presents it. Read from the export, never recomputed and never posted.
 */
export type TallyCutoverStockValuation = {
  openingValue: number | null
  closingValue: number | null
  itemsWithOpeningValue: number
  itemsWithClosingValue: number
  itemCount: number
}

export type TallyCutoverJournalLine = {
  accountCode: string
  accountName: string
  debit: number
  credit: number
  description?: string
}

export type TallyCutoverOpening = {
  date: string
  currency: string
  lines: TallyCutoverJournalLine[]
  totalDebit: number
  totalCredit: number
  difference: number
}

export type TallyCutoverVoucher = {
  sourceId: string
  sourceType: string
  kind: TallyVoucherKind
  date: string
  number?: string
  description: string
  currency: string
  partyName?: string
  lines: TallyCutoverJournalLine[]
}

/**
 * One stock movement the export proves, with its place in the sequence.
 *
 * `quantityDelta` is signed in whole units: positive moved stock in, negative
 * moved it out. A physical-stock line is the counted quantity, not a
 * difference, and `movementKind` says so; the replay simulation resolves it
 * against the quantity at that point.
 */
export type TallyCutoverMovement = {
  movementId: string
  sourceId: string
  kind: TallyVoucherKind
  movementKind:
    | "opening"
    | "purchase_in"
    | "sale_out"
    | "return_in"
    | "return_out"
    | "stock_journal_in"
    | "stock_journal_out"
    | "physical_adjust"
  date: string
  /** Index in the consolidated export, before any filtering. */
  sourceOrder: number
  lineIndex: number
  batchIndex: number
  stockItemName: string
  quantityDelta: number
  batchNumber?: string
  expiryDate?: string
  godown?: string
  rate: number
  amount: number
  allocation: "explicit" | "fefo" | "synthetic"
}

export type TallyCutoverSaleItem = {
  stockItemName: string
  quantity: number
  unitPrice: number
  lineTotal: number
  /** Index into the voucher's inventory lines, which is how a replay movement names its line. */
  lineIndex?: number
}

export type TallyCutoverSale = {
  sourceId: string
  date: string
  transactionNumber: string
  partyName?: string
  paymentMethod: "CASH" | "CARD" | "MOBILE_MONEY" | "BANK_TRANSFER"
  total: number
  tax: number
  discount: number
  items: TallyCutoverSaleItem[]
}

export type TallyCutoverPurchaseItem = {
  stockItemName: string
  quantity: number
  unitCost: number
  lineTotal: number
}

export type TallyCutoverPurchase = {
  sourceId: string
  date: string
  purchaseNumber: string
  partyName: string
  total: number
  tax: number
  amountPaid: number
  paymentMethod?: "CASH" | "CARD" | "MOBILE_MONEY" | "BANK_TRANSFER"
  items: TallyCutoverPurchaseItem[]
}

export type TallyCutoverPlan = {
  company?: string
  companyKey: string
  currency: string
  conversionDate: string
  /** Replay only: the last date the replayed history covers. */
  cutoffDate?: string
  /** Replay only: how same-day vouchers were ordered. Absent, never guessed. */
  ordering?: "date-then-export-order"
  /**
   * Whether the source states batch expiry dates. `not-supplied` is recorded
   * so the review, the preflight and the audit can say stock was imported
   * without an expiry instead of leaving it to be inferred from empty fields.
   */
  batchExpiry?: TallyBatchExpiry
  accounts: TallyCutoverAccount[]
  parties: TallyCutoverParty[]
  mode: TallyCutoverMode
  stockItems: TallyCutoverStockItem[]
  stock: TallyCutoverStockValuation
  opening: TallyCutoverOpening
  vouchers: TallyCutoverVoucher[]
  sales: TallyCutoverSale[]
  purchases: TallyCutoverPurchase[]
  /**
   * Replay only. Opening stock is not repeated here: it is carried by
   * `stockItems` and applied by its own stage.
   */
  movements?: TallyCutoverMovement[]
  exceptions: TallyException[]
  /**
   * Every code found, counted before the listed exceptions are capped, so a
   * capped list never reads as the whole problem.
   */
  exceptionCounts?: Partial<Record<TallyExceptionCode, number>>
  counts: {
    ledgers: number
    groups: number
    stockItems: number
    vouchers: number
    postedVouchers: number
    skippedVouchers: number
    sales: number
    purchases: number
    openingLines: number
  }
  warnings: TallyXmlRowWarning[]
}

/**
 * `opening` imports Tally's opening balances and replays the Day Book.
 * `closing` imports the balances the export closes on and posts no vouchers.
 * `replay` also rebuilds every stock movement, in date order, up to a cutoff.
 */
export type TallyCutoverMode = "opening" | "closing" | "replay"

export type TallyNormaliseOptions = {
  conversionDate?: string
  /** Replay only. Defaults to the export's period end. */
  cutoffDate?: string
  currency?: string
  mode?: TallyCutoverMode
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
  /**
   * Whether the export states a batch expiry on every inbound stock line.
   * `not-supplied` is an explicit operator decision, never inferred: receipts
   * keep their Tally batch name and are stored with no expiry, and the plan
   * carries one aggregate warning saying so.
   */
  batchExpiry?: TallyBatchExpiry
  /** Today in Africa/Kampala (YYYY-MM-DD). Defaults to the current date. */
  today?: string
}

/** Whether the source carries batch expiry dates. */
export type TallyBatchExpiry = "source" | "not-supplied"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_EXCEPTIONS = 500

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function cents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100)
}

/** Calendar date in Africa/Kampala, matching the stock receiving guard. */
function kampalaDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Kampala" }).format(now)
}

function addDays(date: string, days: number): string | undefined {
  if (!Number.isFinite(days)) return undefined
  const parsed = new Date(`${date}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return undefined
  parsed.setUTCDate(parsed.getUTCDate() + Math.trunc(days))
  return parsed.toISOString().slice(0, 10)
}

function trimText(value: string | undefined, limit = 200): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim()
  return trimmed ? trimmed.slice(0, limit) : undefined
}

function money(value: number): string {
  return value.toFixed(2)
}

function voucherLabel(voucher: TallyVoucher): string {
  return trimText(voucher.number) ?? trimText(voucher.guid) ?? trimText(voucher.remoteId) ?? "without a number"
}

/**
 * Tally's own ledger export writes a debit balance as a negative amount — the
 * day book agrees, where a debit line carries a negative AMOUNT with
 * ISDEEMEDPOSITIVE "Yes". Hand-written and third-party files sometimes use the
 * opposite sign, so the export is asked to vote with the ledgers whose Tally
 * group fixes their natural side. A document with no evidence keeps Tally's.
 */
function inferBalanceSign(
  accounts: TallyMappedAccount[],
  ledgerByKey: Map<string, TallyLedger>,
): 1 | -1 {
  let debitPositive = 0
  let debitNegative = 0
  for (const account of accounts) {
    if (account.unclassified) continue
    const ledger = ledgerByKey.get(normaliseTallyKey(account.sourceName))
    const value = ledger?.closingBalance ?? ledger?.openingBalance
    if (value === undefined || value === 0) continue
    const positiveIsDebit = (value > 0) === (account.normalBalance === "debit")
    if (positiveIsDebit) debitPositive += 1
    else debitNegative += 1
  }
  return debitNegative >= debitPositive ? -1 : 1
}

function paymentMethodFromLine(
  line: TallyLedgerLine,
  accountFor: (name: string) => TallyMappedAccount,
): "CASH" | "CARD" | "MOBILE_MONEY" | "BANK_TRANSFER" | undefined {
  if (line.amount <= 0) return undefined
  const account = accountFor(line.ledgerName)
  return isCashOrBankRole(account.role) ? paymentMethodForRole(account.role) : undefined
}

type LedgerUsage = {
  salesCredit: number
  salesDebit: number
  purchaseDebit: number
  purchaseCredit: number
}

/**
 * How each ledger name is used across the export. An export of day books alone
 * carries no ledger masters, so the vouchers' own sides are the only evidence
 * of what an account is; this records it rather than guessing from the name.
 */
function ledgerUsage(vouchers: TallyVoucher[]): Map<string, LedgerUsage> {
  const usage = new Map<string, LedgerUsage>()
  const record = (name: string, side: "debit" | "credit", kind: TallyVoucherKind) => {
    const key = normaliseTallyKey(name)
    if (!key) return
    const entry =
      usage.get(key) ?? { salesCredit: 0, salesDebit: 0, purchaseDebit: 0, purchaseCredit: 0 }
    if (kind === "sales" || kind === "credit_note") {
      if (side === "credit") entry.salesCredit += 1
      else entry.salesDebit += 1
    } else if (kind === "purchase" || kind === "debit_note") {
      if (side === "debit") entry.purchaseDebit += 1
      else entry.purchaseCredit += 1
    }
    usage.set(key, entry)
  }
  for (const voucher of vouchers) {
    const kind = classifyTallyVoucherType(voucher.type)
    if (
      kind !== "sales" &&
      kind !== "purchase" &&
      kind !== "credit_note" &&
      kind !== "debit_note"
    ) {
      continue
    }
    for (const line of voucher.ledgerLines) record(line.ledgerName, line.side, kind)
    for (const line of voucher.inventoryLines) {
      for (const allocation of line.ledgers) record(allocation.ledgerName, allocation.side, kind)
    }
  }
  return usage
}

/**
 * Classifies a ledger from the side it occupies in its vouchers, used only when
 * the export has no master for it and the name itself is not recognised. A name
 * that appears on both sides of a trade, or in more than one role, stays
 * unclassified rather than being forced into one.
 */
function classifyFromUsage(usage: LedgerUsage | undefined): TallyLedgerClassification | undefined {
  if (!usage) return undefined
  if (usage.salesCredit > 0 && usage.salesDebit === 0 && usage.purchaseDebit === 0 && usage.purchaseCredit === 0) {
    return {
      accountType: "income",
      normalBalance: "credit",
      role: "sales",
      systemKey: "SALES_REVENUE",
      unclassified: false,
    }
  }
  if (usage.purchaseDebit > 0 && usage.salesCredit === 0 && usage.salesDebit === 0 && usage.purchaseCredit === 0) {
    return { accountType: "expense", normalBalance: "debit", role: "expense", unclassified: false }
  }
  if (usage.salesDebit > 0 && usage.salesCredit === 0 && usage.purchaseDebit === 0 && usage.purchaseCredit === 0) {
    return {
      accountType: "asset",
      normalBalance: "debit",
      role: "receivable",
      partyType: "customer",
      unclassified: false,
    }
  }
  if (usage.purchaseCredit > 0 && usage.purchaseDebit === 0 && usage.salesCredit === 0 && usage.salesDebit === 0) {
    return {
      accountType: "liability",
      normalBalance: "credit",
      role: "payable",
      partyType: "supplier",
      unclassified: false,
    }
  }
  return undefined
}

function billsForParty(
  bills: TallyBillAllocation[],
  opening: number,
  partyType: "customer" | "supplier",
  conversionDate: string,
  addException: (code: TallyExceptionCode, message: string, detail?: string) => void,
): TallyCutoverPartyBill[] {
  const receivable = partyType === "customer"
  const expectedSign = receivable ? opening > 0 : opening < 0
  if (opening !== 0 && !expectedSign) {
    addException(
      "PARTY_OPENING_OPPOSITE_SIDE",
      `${partyType === "customer" ? "Customer" : "Supplier"} opening is on the opposite side and is not included in ageing.`,
    )
    return []
  }

  if (bills.length === 0) {
    if (opening === 0) return []
    return [{ amount: Math.abs(opening), dueDateDerived: false }]
  }

  const mapped = bills
    .filter((bill) => bill.amount !== 0)
    .map((bill) => ({
      reference: trimText(bill.name, 120),
      amount: Math.abs(bill.amount),
      dueDate:
        bill.creditPeriodDays === undefined
          ? undefined
          : addDays(conversionDate, bill.creditPeriodDays),
      billType: bill.billType,
      dueDateDerived: bill.creditPeriodDays !== undefined,
    }))

  const billTotal = mapped.reduce((total, bill) => total + cents(bill.amount), 0)
  if (opening !== 0 && billTotal !== cents(Math.abs(opening))) {
    addException(
      "PARTY_BILLS_MISMATCH",
      `Bill allocations total ${money(billTotal / 100)} against an opening of ${money(Math.abs(opening))}. Bills are imported as exported.`,
    )
  }
  return mapped
}

const SYNTHETIC_BATCH_PREFIX = "TALLY-RPL-"

function isPhysicalStockVoucher(voucher: TallyVoucher): boolean {
  return normaliseTallyKey(voucher.type).includes("PHYSICAL STOCK")
}

/**
 * Which way a stock line moved. Tally states it three ways and the export
 * carries whichever the voucher type uses: the list a stock journal line sits
 * in, the line's own `ISDEEMEDPOSITIVE`, or — for every other voucher — the
 * kind. A stock journal that states none of them is not guessed at.
 */
function replayDirection(
  voucher: TallyVoucher,
  kind: TallyVoucherKind,
  line: TallyInventoryLine,
): "in" | "out" | "set" | undefined {
  if (isPhysicalStockVoucher(voucher)) return "set"
  if (line.listSide) return line.listSide
  if (line.deemedPositive !== undefined) return line.deemedPositive ? "in" : "out"
  switch (kind) {
    case "sales":
      return "out"
    case "purchase":
      return "in"
    case "credit_note":
      return "in"
    case "debit_note":
      return "out"
    default:
      return undefined
  }
}

function replayMovementKind(
  kind: TallyVoucherKind,
  direction: "in" | "out" | "set",
): TallyCutoverMovement["movementKind"] {
  if (direction === "set") return "physical_adjust"
  if (kind === "purchase") return direction === "in" ? "purchase_in" : "return_out"
  if (kind === "sales") return direction === "out" ? "sale_out" : "return_in"
  if (kind === "credit_note") return direction === "in" ? "return_in" : "return_out"
  if (kind === "debit_note") return direction === "out" ? "return_out" : "return_in"
  // Any other voucher that moves stock is a stock adjustment as far as the
  // export shows; its kind is reported rather than invented.
  return direction === "in" ? "stock_journal_in" : "stock_journal_out"
}

const TRADE_MOVEMENT_KINDS = new Set<TallyVoucherKind>([
  "sales",
  "purchase",
  "credit_note",
  "debit_note",
  "stock_journal",
])

type ReplayBatchIdentity = {
  /** Expiry of the earliest receipt that uses this Tally batch name. */
  primaryExpiry: string
  primaryDate: string
  primaryOrder: number
  /** Expiry → receipts. More than one cannot be one row in Synapse. */
  expiryCounts: Map<string, number>
  receipts: number
  /** OUT/SET lines naming this batch, and those of them that restate its expiry. */
  outLines: number
  outWithExpiry: Map<string, number>
}

const batchIdentityKey = (stockItemName: string, batchNumber: string): string =>
  `${normaliseTallyKey(stockItemName)}|${normaliseTallyKey(batchNumber)}`

/**
 * Tally identifies a batch by name alone; Synapse keeps one row per
 * (product, batch number) and so one expiry. Many pharmacies therefore have
 * receipts that all share a name such as "Primary Batch" while carrying
 * different expiries. This pass reads the plan-wide picture before any movement
 * is built, so the choice of which receipt keeps the Tally name and which are
 * displaced never depends on the order the exporter happened to write.
 */
function collectReplayBatchIdentities(
  sourceVouchers: TallyVoucher[],
  conversionDate: string,
  cutoffDate: string | undefined,
): Map<string, ReplayBatchIdentity> {
  const identities = new Map<string, ReplayBatchIdentity>()
  const seen = new Set<string>()

  const entryFor = (stockItemName: string, batchNumber: string, date: string, sourceOrder: number) => {
    const key = batchIdentityKey(stockItemName, batchNumber)
    let entry = identities.get(key)
    if (!entry) {
      entry = {
        primaryExpiry: "",
        primaryDate: date,
        primaryOrder: sourceOrder,
        expiryCounts: new Map(),
        receipts: 0,
        outLines: 0,
        outWithExpiry: new Map(),
      }
      identities.set(key, entry)
    }
    return entry
  }

  for (const [sourceOrder, voucher] of sourceVouchers.entries()) {
    if (voucher.isCancelled || !voucher.date) continue
    if (voucher.date < conversionDate) continue
    if (cutoffDate && ISO_DATE_RE.test(cutoffDate) && voucher.date > cutoffDate) continue
    const kind = classifyTallyVoucherType(voucher.type)
    if (kind === "order" || kind === "inventory_note") continue
    if (!tallyVoucherSourceType(kind) && kind !== "stock_journal") continue
    // The voucher loop skips a second copy of the same source voucher, so its
    // lines must not be counted twice here either.
    const identity = voucher.guid ?? voucher.remoteId
    if (identity) {
      if (seen.has(identity)) continue
      seen.add(identity)
    }

    const directions = voucher.inventoryLines.map((line) => replayDirection(voucher, kind, line))
    if (directions.some((direction) => direction === undefined)) continue

    for (const [lineIndex, line] of voucher.inventoryLines.entries()) {
      const direction = directions[lineIndex] as "in" | "out" | "set"
      if (line.batches.length === 0) continue
      for (const batch of line.batches) {
        const batchNumber = trimText(batch.batchName, 120)
        if (!batchNumber) continue
        const entry = entryFor(line.stockItemName, batchNumber, voucher.date, sourceOrder)
        if (direction === "in") {
          const quantity =
            batch.quantity ?? (line.batches.length === 1 ? line.quantity : undefined)
          if (quantity === undefined || !Number.isFinite(quantity) || !Number.isInteger(quantity)) continue
          if (!batch.expiryDate) continue
          const firstReceipt = entry.receipts === 0
          const earlier =
            voucher.date < entry.primaryDate ||
            (voucher.date === entry.primaryDate && sourceOrder < entry.primaryOrder)
          entry.receipts += 1
          entry.expiryCounts.set(
            batch.expiryDate,
            (entry.expiryCounts.get(batch.expiryDate) ?? 0) + 1,
          )
          if (firstReceipt || earlier) {
            entry.primaryDate = voucher.date
            entry.primaryOrder = sourceOrder
            entry.primaryExpiry = batch.expiryDate
          }
        } else {
          entry.outLines += 1
          if (batch.expiryDate) {
            entry.outWithExpiry.set(
              batch.expiryDate,
              (entry.outWithExpiry.get(batch.expiryDate) ?? 0) + 1,
            )
          }
        }
      }
    }
  }
  return identities
}

/**
 * A 64-bit key: one 32-bit hash is not enough when tens of thousands of
 * receipts share a batch name.
 */
function collisionBatchKey(movementId: string, expiryDate: string): string {
  return `${stableHash(`${movementId}|${expiryDate}`)}${stableHash(`${expiryDate}|${movementId}`)}`.toUpperCase()
}

type ReplayCapture = {
  voucher: TallyVoucher
  kind: TallyVoucherKind
  sourceId: string
  date: string
  sourceOrder: number
  addException: (code: TallyExceptionCode, message: string, detail?: string, severity?: "blocking" | "warning") => void
  /** Plan-wide batch identity, so a name with two expiries is handled once. */
  batchIdentities: Map<string, ReplayBatchIdentity> | null
  /** The operator accepted that the export states no batch expiry. */
  allowMissingExpiry: boolean
  /** Receipts accepted without an expiry, counted once for the plan. */
  missingExpiry: { receipts: number; items: Set<string> }
  movements: TallyCutoverMovement[]
}

/**
 * Turns one voucher's inventory into movements. A line with batch allocations
 * becomes one movement per batch; a sale line without them is left to FEFO,
 * marked as such rather than given a batch Tally never named.
 */
function captureReplayMovements({
  voucher,
  kind,
  sourceId,
  date,
  sourceOrder,
  addException,
  batchIdentities,
  allowMissingExpiry,
  missingExpiry,
  movements,
}: ReplayCapture): void {
  if (!TRADE_MOVEMENT_KINDS.has(kind)) {
    addException(
      "REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER",
      `Voucher "${voucherLabel(voucher)}" is a ${voucher.type || "voucher"} but carries stock. Its movement is recorded as a stock adjustment; the export does not say it is a purchase or a sale, so neither is assumed.`,
      sourceId,
      "warning",
    )
  }
  const directions = voucher.inventoryLines.map((line) =>
    replayDirection(voucher, kind, line),
  )
  if (directions.some((direction) => direction === undefined)) {
    addException(
      "REPLAY_STOCK_JOURNAL_DIRECTION_UNKNOWN",
      `Voucher "${voucherLabel(voucher)}" moves stock, but the export does not say which side its lines are on. It is not guessed at; re-export the voucher with its inventory lists, or post it manually.`,
      sourceId,
      "blocking",
    )
    return
  }

  for (const [lineIndex, line] of voucher.inventoryLines.entries()) {
    const direction = directions[lineIndex] as "in" | "out" | "set"
    const movementKind = replayMovementKind(kind, direction)
    const lineQuantity = line.quantity

    if (lineQuantity === undefined || !Number.isFinite(lineQuantity)) {
      addException(
        "REPLAY_MOVEMENT_WITHOUT_QUANTITY",
        `Stock line "${line.stockItemName}" on "${voucherLabel(voucher)}" has no readable quantity, so its movement cannot be replayed.`,
        `${sourceId}:L${lineIndex}`,
        "blocking",
      )
      continue
    }
    if (!Number.isInteger(lineQuantity)) {
      addException(
        "REPLAY_NON_INTEGER_QUANTITY",
        `Stock line "${line.stockItemName}" on "${voucherLabel(voucher)}" has quantity ${lineQuantity}, which is not a whole unit. The pharmacy stock ledger only accepts whole units.`,
        `${sourceId}:L${lineIndex}`,
        "blocking",
      )
      continue
    }

    const parts: Array<{
      batchIndex: number
      quantity: number
      batchName?: string
      expiryDate?: string
      godown?: string
      amount: number
    }> = []
    const batches = line.batches

    if (batches.length === 0) {
      parts.push({
        batchIndex: 0,
        quantity: lineQuantity,
        godown: line.godown,
        amount: round2(line.amount),
      })
    } else {
      for (const [batchIndex, batch] of batches.entries()) {
        const quantity =
          batch.quantity ??
          (batches.length === 1 ? lineQuantity : undefined)
        if (quantity === undefined || !Number.isFinite(quantity)) {
          addException(
            "REPLAY_MOVEMENT_WITHOUT_QUANTITY",
            `Batch ${batch.batchName ?? batchIndex + 1} of "${line.stockItemName}" on "${voucherLabel(voucher)}" has no readable quantity, so its share of the line cannot be replayed.`,
            `${sourceId}:L${lineIndex}:B${batchIndex}`,
            "blocking",
          )
          continue
        }
        if (!Number.isInteger(quantity)) {
          addException(
            "REPLAY_NON_INTEGER_QUANTITY",
            `Batch ${batch.batchName ?? batchIndex + 1} of "${line.stockItemName}" on "${voucherLabel(voucher)}" has quantity ${quantity}, which is not a whole unit.`,
            `${sourceId}:L${lineIndex}:B${batchIndex}`,
            "blocking",
          )
          continue
        }
        const amount =
          batch.amount ??
          (lineQuantity !== 0 ? round2((line.amount * quantity) / lineQuantity) : round2(line.amount))
        parts.push({
          batchIndex,
          quantity,
          batchName: trimText(batch.batchName, 120),
          expiryDate: batch.expiryDate,
          godown: batch.godown ?? line.godown,
          amount,
        })
      }
    }

    for (const part of parts) {
      const movementId = `${sourceId}:L${lineIndex}:B${part.batchIndex}`
      const signedQuantity =
        direction === "out" ? -Math.abs(part.quantity) : part.quantity

      if (direction === "in" && !part.expiryDate) {
        if (!allowMissingExpiry) {
          addException(
            "REPLAY_MOVEMENT_EXPIRY_MISSING",
            `"${line.stockItemName}"${part.batchName ? ` batch ${part.batchName}` : ""} is received on ${date} with no expiry date, so it cannot be replayed into a batch. Turn on batch-wise expiry dates for the stock items in Tally and re-export; the StockBatches sheet fills opening and closing stock, not voucher lines.`,
            movementId,
            "blocking",
          )
          continue
        }
        // The operator accepted a source with no expiry dates. The receipt
        // keeps the batch name Tally states and no expiry; the plan records
        // how many receipts were like this, once, rather than inventing a
        // date or repeating an exception per line.
        missingExpiry.receipts += 1
        missingExpiry.items.add(line.stockItemName)
      }

      let batchNumber = part.batchName
      let allocation: TallyCutoverMovement["allocation"] =
        direction === "out" && batches.length === 0
          ? "fefo"
          : batchNumber
            ? "explicit"
            : "fefo"
      if (direction === "in" && !batchNumber) {
        batchNumber = `${SYNTHETIC_BATCH_PREFIX}${stableHash(movementId).toUpperCase()}`
        allocation = "synthetic"
        addException(
          "REPLAY_SYNTHETIC_BATCH",
          `"${line.stockItemName}" is received on ${date} without a batch number. A deterministic key is used so the movement can be replayed; Tally's own batch identity is not known.`,
          sourceId,
          "warning",
        )
      }

      // Tally names a batch; it does not promise the name is unique per
      // expiry. One Synapse row holds one expiry, so a name covering several
      // expiries is split: the earliest receipt keeps Tally's name and every
      // later one gets a deterministic key of its own. A sale naming such a
      // batch cannot be attributed to one of them — Tally never recorded which
      // — so it is allocated first-expiry-first-out instead of guessed.
      const identity = batchNumber && batchIdentities
        ? batchIdentities.get(batchIdentityKey(line.stockItemName, batchNumber))
        : undefined
      const colliding = identity !== undefined && identity.expiryCounts.size > 1
      const matchesPrimary = colliding && part.expiryDate === identity.primaryExpiry

      if (colliding && !matchesPrimary) {
        if (direction === "out") {
          batchNumber = undefined
          allocation = "fefo"
        } else {
          batchNumber = `${SYNTHETIC_BATCH_PREFIX}${collisionBatchKey(movementId, part.expiryDate ?? "")}`
          allocation = "synthetic"
        }
      }

      const rate =
        part.quantity !== 0
          ? round2(part.amount / Math.abs(part.quantity))
          : round2(line.rate ?? 0)

      movements.push({
        movementId,
        sourceId,
        kind,
        movementKind,
        date,
        sourceOrder,
        lineIndex,
        batchIndex: part.batchIndex,
        stockItemName: line.stockItemName,
        quantityDelta: signedQuantity,
        batchNumber,
        expiryDate: part.expiryDate,
        godown: part.godown ?? (direction === "out" ? voucher.sourceGodown : voucher.destinationGodown),
        rate,
        amount: round2(part.amount),
        allocation,
      })
    }
  }
}

/**
 * Tally exposes no clock time, so a day's vouchers keep their export order.
 * The result is a reproducible sequence, never a claimed chronological one.
 */
function dateThenExportOrder(
  orderOf: (sourceId: string) => number,
): (a: { date: string; sourceId: string }, b: { date: string; sourceId: string }) => number {
  return (a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    return orderOf(a.sourceId) - orderOf(b.sourceId)
  }
}

export function normaliseTallyDocument(
  document: TallyXmlDocument,
  options: TallyNormaliseOptions = {},
): TallyCutoverPlan {
  const mode: TallyCutoverMode =
    options.mode === "closing" ? "closing" : options.mode === "replay" ? "replay" : "opening"
  const conversionDate =
    options.conversionDate ??
    (mode === "closing" ? document.financialPeriod.to : document.financialPeriod.from) ??
    document.vouchers.map((voucher) => voucher.date).filter((date): date is string => Boolean(date)).sort()[0] ??
    ""
  if (!ISO_DATE_RE.test(conversionDate)) throw new Error("TALLY_CONVERSION_DATE_REQUIRED")

  const currency = (options.currency ?? document.currency ?? "UGX").trim().slice(0, 8) || "UGX"
  const today = ISO_DATE_RE.test(options.today ?? "") ? options.today! : kampalaDate(new Date())
  const companyKey =
    trimText(document.companyGuid, 80) ??
    `C-${stableHash(normaliseTallyKey(document.company ?? "Tally")).toUpperCase()}`
  const company = trimText(document.company)

  const exceptions: TallyException[] = []
  const exceptionCounts: Partial<Record<TallyExceptionCode, number>> = {}
  const exceptionKeys = new Set<string>()
  const addException = (
    code: TallyExceptionCode,
    message: string,
    detail?: string,
    severity: "blocking" | "warning" = "warning",
  ) => {
    const key = `${code}|${detail ?? ""}`
    if (exceptionKeys.has(key)) return
    exceptionKeys.add(key)
    // Counted before the cap so the total stays truthful when the list is cut.
    exceptionCounts[code] = (exceptionCounts[code] ?? 0) + 1
    if (exceptions.length >= MAX_EXCEPTIONS) {
      if (!exceptionKeys.has("EXCEPTION_LIMIT_REACHED|")) {
        exceptionKeys.add("EXCEPTION_LIMIT_REACHED|")
        exceptions.push({
          code: "EXCEPTION_LIMIT_REACHED",
          severity: "warning",
          message: "More exceptions were found than can be listed. Resolve the listed ones and re-preview.",
        })
      }
      return
    }
    exceptions.push({ code, severity, message, detail })
  }

  if (document.truncated) {
    const { reason, limit, recordsProcessed } = document.truncated
    addException(
      "SOURCE_TRUNCATED",
      `The import stopped after ${recordsProcessed.toLocaleString("en-GB")} records because the ${limit.toLocaleString("en-GB")}-record limit was reached (${reason}). The rest of the file was never read, so this plan holds only the start of the export and cannot be applied.`,
      `reason=${reason}; recordsProcessed=${recordsProcessed}; limit=${limit}`,
      "blocking",
    )
  }

  if (!company) addException("COMPANY_MISSING", "The export did not name a company. Source identifiers use a hash of the file's data.")

  if (mode === "closing") {
    const periodEnd = document.financialPeriod.to
    if (!periodEnd) {
      addException(
        "CLOSING_PERIOD_UNKNOWN",
        `This export does not say which date its balances close on. Confirm in Tally that they close on ${conversionDate}; they are imported as the opening balances at that date.`,
      )
    } else if (periodEnd !== conversionDate) {
      addException(
        "CLOSING_PERIOD_MISMATCH",
        `The export closes on ${periodEnd}, but the cut-over date is ${conversionDate}. Export the balances as at ${conversionDate}, or set the cut-over date to ${periodEnd}.`,
        undefined,
        "blocking",
      )
    }
    if (document.vouchers.length > 0) {
      addException(
        "CLOSING_MODE_HISTORY_ONLY",
        `${document.vouchers.length} Day Book voucher${document.vouchers.length === 1 ? "" : "s"} are imported as sales and purchase history only. The ledger and the stock start from the closing position, so the vouchers are neither posted nor used to move stock.`,
      )
    }
  }

  const cutoffDate =
    mode === "replay"
      ? options.cutoffDate ?? document.financialPeriod.to ?? ""
      : ""

  if (mode === "replay") {
    if (!ISO_DATE_RE.test(cutoffDate)) {
      addException(
        "REPLAY_PERIOD_REQUIRED",
        "Full history needs the date the rebuild stops at, and neither this export nor the session says what it is. Set the cutoff date, or export the period ending at the cut-over.",
        undefined,
        "blocking",
      )
    } else {
      if (cutoffDate <= conversionDate) {
        addException(
          "REPLAY_PERIOD_INVALID",
          `The replay cutoff ${cutoffDate} is on or before the ${conversionDate} opening date, so there is no period to replay.`,
          undefined,
          "blocking",
        )
      }
      if (document.financialPeriod.to && document.financialPeriod.to !== cutoffDate) {
        addException(
          "REPLAY_PERIOD_MISMATCH",
          `The export ends on ${document.financialPeriod.to}, but the replay cutoff is ${cutoffDate}. Tally's closing figures belong to ${document.financialPeriod.to}, so they cannot be compared with a replay that stops on another date. Export the period that ends at the cutoff.`,
          undefined,
          "blocking",
        )
      }
    }
  }

  const mapped = mapTallyLedgers(document.ledgers, document.groups, options.accountOverrides)
  const ledgerByKey = new Map<string, TallyLedger>()
  for (const ledger of document.ledgers) {
    const key = normaliseTallyKey(ledger.name)
    if (!key) continue
    if (ledgerByKey.has(key)) {
      addException(
        "DUPLICATE_LEDGER",
        `Ledger "${ledger.name}" appears more than once in the export. Only the first copy is used.`,
        ledger.name,
      )
      continue
    }
    ledgerByKey.set(key, ledger)
  }
  // Everything below treats a positive amount as a debit, the same way the
  // voucher lines do; the masters' own sign is converted once, here.
  const balanceSign = inferBalanceSign(mapped, ledgerByKey)

  const accountsByKey = new Map<string, TallyMappedAccount>()
  for (const account of mapped) accountsByKey.set(normaliseTallyKey(account.sourceName), account)
  for (const account of mapped) {
    if (account.unclassified) {
      addException(
        "UNCLASSIFIED_LEDGER",
        `Ledger "${account.sourceName}" has no recognised Tally group. It was classified as a debit asset; review it in the mapping step.`,
        account.sourceName,
      )
    }
  }

  const extraAccounts: TallyMappedAccount[] = []
  const usageByName = ledgerUsage(document.vouchers)
  const accountFor = (ledgerName: string): TallyMappedAccount => {
    const key = normaliseTallyKey(ledgerName)
    const found = accountsByKey.get(key)
    if (found) return found
    const sourceName = trimText(ledgerName, 200) ?? ledgerName
    // An export of day books alone carries no chart of accounts, so a ledger
    // seen in a voucher has to be read from the name and the side it is used
    // on. Cash and the seeded names resolve by name; the rest from usage.
    const named = classifyTallyLedger({ name: sourceName, isBillWise: false, bills: [] }, new Map())
    const inferred = named.role === "other" ? classifyFromUsage(usageByName.get(key)) : undefined
    const classification = inferred ?? named
    const account: TallyMappedAccount = {
      sourceName,
      name: sourceName,
      code: tallyAccountCode(undefined, sourceName),
      ...classification,
      unclassified: classification.role === "other",
    }
    accountsByKey.set(key, account)
    extraAccounts.push(account)
    if (inferred) {
      addException(
        "LEDGER_INFERRED",
        `Ledger "${sourceName}" is not in the exported masters. It is used only as ${
          classification.role === "sales"
            ? "the credit side of sales"
            : classification.role === "expense"
              ? "the debit side of purchases"
              : classification.role === "receivable"
                ? "the debit side of sales"
                : "the credit side of purchases"
        }, so it was classified as ${classification.role}; review it.`,
        sourceName,
      )
    } else {
      addException(
        "LEDGER_MISSING",
        `Ledger "${sourceName}" appears in a voucher but not in the exported masters. It was created as a debit asset; review it.`,
        sourceName,
      )
    }
    return account
  }

  const movements = new Map<string, number>()
  const addMovement = (ledgerName: string, debit: number, credit: number) => {
    const key = normaliseTallyKey(ledgerName)
    movements.set(key, (movements.get(key) ?? 0) + cents(debit) - cents(credit))
  }

  const vouchers: TallyCutoverVoucher[] = []
  const acceptedVouchers: Array<{ voucher: TallyVoucher; sourceId: string; kind: TallyVoucherKind }> = []
  // A balances-only cut-over takes the closing position for the ledger and the
  // stock, so its vouchers are never posted. They are still read, because the
  // sales and purchases they carry are history the reports need; only the
  // ledger payload is withheld below.
  const sourceVouchers = document.vouchers
  let skippedVouchers = 0
  const usedSourceIds = new Set<string>()
  // Replay: stock movements, their position in the export, and batch numbers
  // already seen with an expiry so one number cannot quietly carry two.
  const replayMovements: TallyCutoverMovement[] = []
  const batchIdentities =
    mode === "replay"
      ? collectReplayBatchIdentities(sourceVouchers, conversionDate, cutoffDate)
      : null
  const batchExpiry: TallyBatchExpiry =
    options.batchExpiry === "not-supplied" ? "not-supplied" : "source"
  const missingExpiry = { receipts: 0, items: new Set<string>() }
  const sourceOrderById = new Map<string, number>()

  // Two source dimensions reach the plan but no Synapse table: the Tally user
  // who entered a voucher, and the cost centre it posts to. Both are real
  // attribution in the export, so dropping them without a word would understate
  // what Tally held; neither changes a ledger balance, so both are disclosed as
  // warnings rather than blocking the voucher. Recorded before the voucher loop
  // so the exception cap cannot hide them behind per-line findings.
  const enteredBy = new Map<string, number>()
  const costCentres = new Map<string, number>()
  for (const voucher of sourceVouchers) {
    const user = voucher.enteredBy?.trim()
    if (user) enteredBy.set(user, (enteredBy.get(user) ?? 0) + 1)
    const centre = voucher.costCentre?.trim()
    if (centre) costCentres.set(centre, (costCentres.get(centre) ?? 0) + 1)
  }
  const describeNames = (counts: Map<string, number>) =>
    [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 5)
      .map(([name]) => name)
      .join(", ")

  if (enteredBy.size > 0) {
    const vouchersNamed = [...enteredBy.values()].reduce((sum, count) => sum + count, 0)
    addException(
      "ENTERED_BY_NOT_MAPPED",
      `${vouchersNamed.toLocaleString("en-GB")} of ${sourceVouchers.length.toLocaleString("en-GB")} vouchers name the Tally user who entered them (${describeNames(enteredBy)}${enteredBy.size > 5 ? ", …" : ""}). Synapse has no mapping from Tally user names to staff accounts, so this attribution is not imported; the vouchers' ledger and stock effects are unaffected.`,
      undefined,
      "warning",
    )
  }
  if (costCentres.size > 0) {
    const vouchersNamed = [...costCentres.values()].reduce((sum, count) => sum + count, 0)
    addException(
      "COST_CENTRE_NOT_MAPPED",
      `${vouchersNamed.toLocaleString("en-GB")} vouchers carry a cost centre (${describeNames(costCentres)}${costCentres.size > 5 ? ", …" : ""}). Synapse has no cost-centre dimension, so the allocation is not imported; the ledger lines and stock movements each voucher carries are imported in full.`,
      undefined,
      "warning",
    )
  }

  if (batchIdentities) {
    let collidingNames = 0
    let receipts = 0
    let displaced = 0
    let ambiguousLines = 0
    for (const entry of batchIdentities.values()) {
      if (entry.expiryCounts.size <= 1) continue
      collidingNames += 1
      receipts += entry.receipts
      displaced += entry.receipts - (entry.expiryCounts.get(entry.primaryExpiry) ?? 0)
      ambiguousLines += entry.outLines - (entry.outWithExpiry.get(entry.primaryExpiry) ?? 0)
    }
    if (collidingNames > 0) {
      addException(
        "REPLAY_BATCH_IDENTITY_RECONSTRUCTED",
        `${collidingNames.toLocaleString("en-GB")} Tally batch name${collidingNames === 1 ? "" : "s"} ${collidingNames === 1 ? "carries" : "carry"} more than one expiry (${receipts.toLocaleString("en-GB")} receipts). The earliest receipt keeps Tally's name; ${displaced.toLocaleString("en-GB")} later receipt${displaced === 1 ? " is" : "s are"} stored under a deterministic Synapse key, and ${ambiguousLines.toLocaleString("en-GB")} sale or stock-count line${ambiguousLines === 1 ? " is" : "s are"} allocated first-expiry-first-out because the name alone cannot say which batch left the shelf. Tally did not record that allocation, so it is disclosed rather than presented as Tally's own.`,
        undefined,
        "warning",
      )
    }
  }

  const identifyVoucher = (
    voucher: TallyVoucher,
    fingerprint: string[],
  ): { sourceId: string; derivedId: string } => {
    const derivedId =
      voucher.guid ??
      voucher.remoteId ??
      `H-${stableHash(
        [
          voucher.type,
          voucher.number ?? "",
          voucher.date ?? "",
          voucher.partyLedgerName ?? "",
          ...fingerprint,
        ].join("|"),
      ).toUpperCase()}`
    if (!voucher.guid && !voucher.remoteId) {
      addException(
        "VOUCHER_GUID_MISSING",
        `Voucher "${voucherLabel(voucher)}" has no Tally identifier. A stable content hash is used so re-runs do not duplicate it.`,
        derivedId,
      )
    }
    return { sourceId: `${companyKey}:${derivedId}`, derivedId }
  }

  for (const [sourceOrder, voucher] of sourceVouchers.entries()) {
    const kind = classifyTallyVoucherType(voucher.type)
    const sourceType = tallyVoucherSourceType(kind)
    // Replay also reads the vouchers that carry stock but post nothing to the
    // ledger; every other mode keeps rejecting them.
    const replayStockVoucher =
      mode === "replay" &&
      (kind === "stock_journal" || kind === "inventory_note" || kind === "order")
    if (!sourceType && !replayStockVoucher) {
      skippedVouchers += 1
      addException(
        "VOUCHER_TYPE_UNSUPPORTED",
        `Voucher "${voucherLabel(voucher)}" of type "${voucher.type}" does not post to the ledger and was not imported.`,
        voucher.guid ?? voucher.remoteId,
      )
      continue
    }

    if (voucher.isCancelled) {
      skippedVouchers += 1
      addException("VOUCHER_CANCELLED", `Cancelled voucher "${voucherLabel(voucher)}" was not imported.`, voucher.guid)
      continue
    }
    if (!voucher.date) {
      skippedVouchers += 1
      addException(
        "VOUCHER_DATE_MISSING",
        `Voucher "${voucherLabel(voucher)}" has no readable date and was not imported.`,
        voucher.guid ?? voucher.remoteId,
      )
      continue
    }
    // Closing mode posts no movements, so an earlier date is only a posting
    // hazard, not a history one.
    if (mode !== "closing" && voucher.date < conversionDate) {
      skippedVouchers += 1
      addException(
        "VOUCHER_BEFORE_CONVERSION",
        `Voucher "${voucherLabel(voucher)}" is dated ${voucher.date}, before the ${conversionDate} cut-over, and was not imported.`,
        voucher.guid ?? voucher.remoteId,
      )
      continue
    }
    if (
      voucher.currency &&
      document.currency &&
      normaliseTallyKey(voucher.currency) !== normaliseTallyKey(document.currency)
    ) {
      skippedVouchers += 1
      addException(
        "MULTI_CURRENCY_UNSUPPORTED",
        `Voucher "${voucherLabel(voucher)}" is in ${voucher.currency}; only ${document.currency} vouchers are imported.`,
        voucher.guid ?? voucher.remoteId,
      )
      continue
    }
    if (mode === "replay" && ISO_DATE_RE.test(cutoffDate) && voucher.date > cutoffDate) {
      skippedVouchers += 1
      addException(
        "REPLAY_VOUCHER_AFTER_CUTOFF",
        `Voucher "${voucherLabel(voucher)}" is dated ${voucher.date}, after the ${cutoffDate} cutoff, and was not replayed.`,
        voucher.guid ?? voucher.remoteId,
        "blocking",
      )
      continue
    }

    if (!sourceType) {
      // Only a replay stock voucher reaches here; every part of it is handled
      // in this branch, and nothing below it posts to the ledger.
      if (kind === "order") {
        skippedVouchers += 1
        addException(
          "REPLAY_ORDER_IGNORED",
          `Order "${voucherLabel(voucher)}" posts no stock and was not replayed.`,
          voucher.guid ?? voucher.remoteId,
        )
        continue
      }
      if (kind === "inventory_note") {
        skippedVouchers += 1
        addException(
          "REPLAY_INVENTORY_NOTE_IGNORED",
          `Delivery and receipt note "${voucherLabel(voucher)}" was not replayed: the invoice that follows it carries the same movement, and applying both would double it. If the note is the only record, correct the invoice in Tally and re-export.`,
          voucher.guid ?? voucher.remoteId,
        )
        continue
      }

      // A stock journal posts no ledger lines; its inventory is the voucher.
      const { sourceId } = identifyVoucher(voucher, [])
      if (usedSourceIds.has(sourceId)) {
        skippedVouchers += 1
        addException("VOUCHER_DUPLICATE", `Duplicate voucher identity ${sourceId} appears more than once; later copies were skipped.`, sourceId)
        continue
      }
      usedSourceIds.add(sourceId)
      sourceOrderById.set(sourceId, sourceOrder)

      captureReplayMovements({
        voucher,
        kind,
        sourceId,
        date: voucher.date,
        sourceOrder,
        addException,
        batchIdentities,
        allowMissingExpiry: batchExpiry === "not-supplied",
        missingExpiry,
        movements: replayMovements,
      })
      continue
    }

    const allLines = [...voucher.ledgerLines, ...voucher.inventoryLines.flatMap((line) => line.ledgers)]
    const lines = allLines
      .filter((line) => line.amount > 0)
      .map((line) => {
        const account = accountFor(line.ledgerName)
        return {
          account,
          debit: line.side === "debit" ? round2(line.amount) : 0,
          credit: line.side === "credit" ? round2(line.amount) : 0,
          description: trimText(line.narration ?? voucher.narration, 300),
        }
      })

    if (lines.length < 2) {
      skippedVouchers += 1
      addException(
        "VOUCHER_ZERO_VALUE",
        `Voucher "${voucherLabel(voucher)}" has fewer than two non-zero ledger lines and was not imported.`,
        voucher.guid ?? voucher.remoteId,
      )
      continue
    }

    const debit = lines.reduce((total, line) => total + cents(line.debit), 0)
    const credit = lines.reduce((total, line) => total + cents(line.credit), 0)
    if (debit !== credit) {
      skippedVouchers += 1
      addException(
        "VOUCHER_UNBALANCED",
        `Voucher "${voucherLabel(voucher)}" does not balance: debit ${money(debit / 100)}, credit ${money(credit / 100)}. It was not imported.`,
        voucher.guid ?? voucher.remoteId,
      )
      continue
    }

    const { sourceId } = identifyVoucher(
      voucher,
      lines.map((line) => `${line.account.code}:${line.debit}:${line.credit}`),
    )
    if (usedSourceIds.has(sourceId)) {
      skippedVouchers += 1
      addException("VOUCHER_DUPLICATE", `Duplicate voucher identity ${sourceId} appears more than once; later copies were skipped.`, sourceId)
      continue
    }
    usedSourceIds.add(sourceId)
    sourceOrderById.set(sourceId, sourceOrder)

    for (const line of lines) addMovement(line.account.sourceName, line.debit, line.credit)

    if (mode === "replay" && voucher.inventoryLines.length > 0) {
      captureReplayMovements({
        voucher,
        kind,
        sourceId,
        date: voucher.date,
        sourceOrder,
        addException,
        batchIdentities,
        allowMissingExpiry: batchExpiry === "not-supplied",
        missingExpiry,
        movements: replayMovements,
      })
    }

    acceptedVouchers.push({ voucher, sourceId, kind })
    if (mode !== "closing") {
      vouchers.push({
        sourceId,
        sourceType,
        kind,
        date: voucher.date,
        number: trimText(voucher.number, 80),
        description:
          trimText(
            `${voucher.type}${voucher.number ? ` ${voucher.number}` : ""}${voucher.narration ? ` — ${voucher.narration}` : ""}`,
            500,
          ) ?? voucher.type,
        currency,
        partyName: trimText(voucher.partyLedgerName, 200),
        lines: lines.map((line) => ({
          accountCode: line.account.code,
          accountName: line.account.name,
          debit: line.debit,
          credit: line.credit,
          description: line.description,
        })),
      })
    }
  }

  if (batchExpiry === "not-supplied" && missingExpiry.receipts > 0) {
    const itemCount = missingExpiry.items.size
    addException(
      "REPLAY_BATCH_EXPIRY_NOT_SUPPLIED",
      `${missingExpiry.receipts.toLocaleString("en-GB")} stock receipt${missingExpiry.receipts === 1 ? "" : "s"} across ${itemCount.toLocaleString("en-GB")} product${itemCount === 1 ? "" : "s"} state no batch expiry date. This import was prepared accepting that: each receipt keeps the batch name Tally states and is stored with no expiry, so imported stock cannot be expiry-tracked, allocated by expiry or recalled by batch expiry. Stock received after the cut-over is unaffected. No date was invented to fill the field.`,
      undefined,
      "warning",
    )
  }

  if (mode === "replay") {
    const orderOf = (sourceId: string) => sourceOrderById.get(sourceId) ?? 0
    const bySequence = dateThenExportOrder(orderOf)
    vouchers.sort(bySequence)
    acceptedVouchers.sort((a, b) =>
      bySequence(
        { date: a.voucher.date ?? "", sourceId: a.sourceId },
        { date: b.voucher.date ?? "", sourceId: b.sourceId },
      ),
    )
    replayMovements.sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1
      if (a.sourceOrder !== b.sourceOrder) return a.sourceOrder - b.sourceOrder
      if (a.lineIndex !== b.lineIndex) return a.lineIndex - b.lineIndex
      return a.batchIndex - b.batchIndex
    })
  }

  const allAccounts = [...mapped, ...extraAccounts]
  const cutoverAccounts: TallyCutoverAccount[] = allAccounts.map((account) => {
    const sourceLedger = ledgerByKey.get(normaliseTallyKey(account.sourceName))
    const closing =
      sourceLedger?.closingBalance === undefined
        ? undefined
        : sourceLedger.closingBalance * balanceSign
    const exportedOpening =
      sourceLedger?.openingBalance === undefined
        ? undefined
        : sourceLedger.openingBalance * balanceSign
    let opening: number | undefined
    let openingMethod: "exported" | "derived" | "closing" | "none" = "none"

    if (mode === "closing") {
      if (closing !== undefined) {
        opening = closing
        openingMethod = "closing"
      } else {
        addException(
          "OPENING_BALANCE_UNAVAILABLE",
          `Ledger "${account.sourceName}" has no closing balance in this export, so its opening is left at zero. Re-export the balances for the cut-over date.`,
          account.sourceName,
        )
      }
    } else if (exportedOpening !== undefined) {
      opening = exportedOpening
      openingMethod = "exported"
    } else if (
      closing !== undefined &&
      document.financialPeriod.from === conversionDate &&
      movements.size > 0
    ) {
      const moved = (movements.get(normaliseTallyKey(account.sourceName)) ?? 0) / 100
      opening = round2(closing - moved)
      openingMethod = "derived"
    } else if (closing !== undefined && document.financialPeriod.from !== conversionDate) {
      addException(
        "OPENING_BALANCE_UNAVAILABLE",
        `Ledger "${account.sourceName}" has a closing balance but no opening balance for the ${conversionDate} cut-over. Its opening is left at zero; choose the Tally period start as the cut-over date, or export opening balances.`,
        account.sourceName,
      )
    }

    const value = round2(opening ?? 0)
    return {
      sourceName: account.sourceName,
      code: account.code,
      name: account.name,
      accountType: account.accountType,
      normalBalance: account.normalBalance,
      role: account.role,
      systemKey: account.systemKey,
      partyType: account.partyType,
      unclassified: account.unclassified,
      sourceGuid: account.sourceGuid,
      openingBalance: Math.abs(value),
      openingSide: value > 0 ? "debit" : value < 0 ? "credit" : "none",
      openingMethod,
      closingBalance: closing,
    }
  })

  const openingLines: TallyCutoverJournalLine[] = cutoverAccounts
    .filter((account) => account.openingSide !== "none" && account.openingBalance > 0)
    .map((account) => ({
      accountCode: account.code,
      accountName: account.name,
      debit: account.openingSide === "debit" ? account.openingBalance : 0,
      credit: account.openingSide === "credit" ? account.openingBalance : 0,
      description: mode === "closing" ? "Tally closing balance" : "Tally opening balance",
    }))

  const openingDebit = openingLines.reduce((total, line) => total + cents(line.debit), 0)
  const openingCredit = openingLines.reduce((total, line) => total + cents(line.credit), 0)
  const openingDifference = round2((openingDebit - openingCredit) / 100)
  if (openingDifference !== 0) {
    addException(
      "OPENING_DIFFERENCE",
      `Opening balances do not balance: debit ${money(openingDebit / 100)}, credit ${money(openingCredit / 100)}, difference ${money(openingDifference)}. No balancing line is added.`,
      undefined,
      "blocking",
    )
  }

  const parties: TallyCutoverParty[] = cutoverAccounts
    .filter((account) => account.partyType !== undefined)
    .map((account) => {
      const ledger = ledgerByKey.get(normaliseTallyKey(account.sourceName))
      const signedOpening = account.openingSide === "debit" ? account.openingBalance : -account.openingBalance
      return {
        kind: account.partyType === "customer" ? "customer" : "supplier",
        name: account.name,
        accountCode: account.code,
        email: trimText(ledger?.email, 200),
        phone: trimText(ledger?.phone, 40),
        address: trimText(ledger?.address, 300),
        openingBalance: account.openingBalance,
        bills: billsForParty(
          ledger?.bills ?? [],
          signedOpening,
          account.partyType === "customer" ? "customer" : "supplier",
          conversionDate,
          (code, message, detail) => addException(code, message, detail),
        ),
      }
    })

  const productSkuOverrides = options.productSkuOverrides ?? {}
  // Replay opens at the conversion date, so a batch is judged against that
  // date rather than today: history may hold stock that has since expired.
  const expiryFloor = mode === "replay" ? conversionDate : today
  const seenStock = new Set<string>()
  const stockItems: TallyCutoverStockItem[] = []
  // Tally's P&L figures come from the export itself, not from the posted
  // opening, so they read the same in either mode.
  let exportedOpeningValue = 0
  let exportedClosingValue = 0
  let itemsWithOpeningValue = 0
  let itemsWithClosingValue = 0
  for (const item of document.stockItems) {
    const key = normaliseTallyKey(item.name)
    if (!key || seenStock.has(key)) continue
    seenStock.add(key)

    // Stock values carry the same ledger sign as the balances, so the export's
    // convention applies to them too.
    const openingValue =
      item.openingValue === undefined ? undefined : item.openingValue * balanceSign
    const closingValue =
      item.closingValue === undefined ? undefined : item.closingValue * balanceSign
    if (openingValue !== undefined) {
      exportedOpeningValue += openingValue
      itemsWithOpeningValue += 1
    }
    if (closingValue !== undefined) {
      exportedClosingValue += closingValue
      itemsWithClosingValue += 1
    }

    const quantity = mode === "closing" ? item.closingQuantity : item.openingQuantity
    const value = mode === "closing" ? closingValue : openingValue
    const rate =
      (mode === "closing" ? undefined : item.openingRate) ??
      (quantity && quantity !== 0 && value !== undefined ? round2(value / quantity) : undefined)
    let batches: TallyCutoverStockBatch[] = item.batches.map((batch) => {
      const expiryDate = batch.expiryDate
      const batchQuantity = batch.quantity
      const receivable =
        Boolean(expiryDate) &&
        Boolean(expiryDate && expiryDate >= expiryFloor) &&
        batchQuantity !== undefined &&
        batchQuantity > 0 &&
        Number.isInteger(batchQuantity)
      return {
        batchName: trimText(batch.batchName, 120),
        expiryDate,
        quantity: batchQuantity,
        receivable,
      }
    })

    const listedBatchQuantity = batches.reduce((total, batch) => total + (batch.quantity ?? 0), 0)
    if (
      mode === "closing" &&
      quantity !== undefined &&
      quantity > 0 &&
      batches.length > 0 &&
      Math.abs(listedBatchQuantity - quantity) >= 0.005
    ) {
      // The master's batch list is dated at the period start. Receiving it as
      // the closing stock would create sellable units Tally never had.
      addException(
        "CLOSING_STOCK_BATCHES_UNAVAILABLE",
        `Stock item "${item.name}" closes at ${quantity} but the export's batches total ${listedBatchQuantity}. Those batches belong to another date, so none is created; supply the closing batches in the StockBatches sheet.`,
        item.name,
      )
      batches = []
    }

    if (quantity !== undefined && quantity > 0) {
      const period = mode === "closing" ? "closing" : "opening"
      const hasExpiry = batches.some((batch) => batch.expiryDate)
      const expired = batches.filter((batch) => batch.expiryDate && batch.expiryDate < expiryFloor)
      if (!hasExpiry) {
        addException(
          "OPENING_STOCK_WITHOUT_EXPIRY",
          `Stock item "${item.name}" has ${period} quantity ${quantity} but no batch expiry. Its value stays in the ledger; no stock batch is created.`,
          item.name,
        )
      }
      if (expired.length > 0) {
        const expiredQuantity = expired.reduce((total, batch) => total + (batch.quantity ?? 0), 0)
        addException(
          "OPENING_STOCK_EXPIRED",
          `Stock item "${item.name}" has ${expired.length} batch${expired.length === 1 ? "" : "es"} totalling ${expiredQuantity} unit${expiredQuantity === 1 ? "" : "s"} whose expiry is on or before ${expiryFloor}. The ledger opening is posted; the expired batches are not received into sellable stock.`,
          item.name,
        )
      }
      if (value === undefined && rate === undefined) {
        addException(
          "OPENING_STOCK_WITHOUT_VALUE",
          `Stock item "${item.name}" has ${period} quantity but no ${period} value or rate. Its stock batch is not created.`,
          item.name,
        )
      }
      if (!Number.isInteger(quantity)) {
        addException(
          "NON_INTEGER_QUANTITY",
          `Stock item "${item.name}" has ${period} quantity ${quantity}, which is not a whole unit. The pharmacy stock ledger only accepts whole units, so no batch is created.`,
          item.name,
        )
      }
      const batchQuantity = batches.reduce((total, batch) => total + (batch.quantity ?? 0), 0)
      if (batches.length > 0 && Math.abs(batchQuantity - quantity) >= 0.005) {
        addException(
          "OPENING_STOCK_QUANTITY_MISMATCH",
          `Stock item "${item.name}" opens at ${quantity} but its batches total ${batchQuantity}. Batches are imported as exported.`,
          item.name,
        )
      }
    } else if (quantity !== undefined && quantity < 0) {
      addException(
        "OPENING_STOCK_WITHOUT_QUANTITY",
        `Stock item "${item.name}" has a negative ${mode === "closing" ? "closing" : "opening"} quantity, which cannot be received. The ledger value is still posted.`,
        item.name,
      )
    }

    stockItems.push({
      sourceName: item.name,
      sku: trimText(productSkuOverrides[key], 60) ?? `TALLY-${stableHash(item.guid || key).toUpperCase()}`,
      name: trimText(item.name, 200) ?? item.name,
      unit: trimText(item.baseUnit, 40),
      quantity,
      rate: rate === undefined ? undefined : round2(rate),
      value: value === undefined ? undefined : round2(value),
      closingQuantity: item.closingQuantity,
      closingValue: closingValue === undefined ? undefined : round2(closingValue),
      batches,
    })
  }

  // Tally's P&L shows the period's opening and closing stock. Report what the
  // export actually carries; an export without closing figures shows none
  // rather than a misleading zero.
  const stock: TallyCutoverStockValuation = {
    openingValue: itemsWithOpeningValue > 0 ? round2(exportedOpeningValue) : null,
    closingValue: itemsWithClosingValue > 0 ? round2(exportedClosingValue) : null,
    itemsWithOpeningValue,
    itemsWithClosingValue,
    itemCount: stockItems.length,
  }
  if (stockItems.length > 0 && itemsWithClosingValue === 0) {
    addException(
      "STOCK_CLOSING_VALUE_MISSING",
      "This export carries opening stock but no closing stock. Tally's closing stock for the period is shown as unavailable rather than zero; export the stock summary, or set the export period to end on the cut-over date.",
    )
  }

  const sales: TallyCutoverSale[] = []
  const purchases: TallyCutoverPurchase[] = []
  let costUnknownReported = false

  for (const { voucher, sourceId } of acceptedVouchers) {
    const kind = classifyTallyVoucherType(voucher.type)
    if (kind !== "sales" && kind !== "purchase") continue
    if (!voucher.date) continue
    const derivedId = sourceId.slice(companyKey.length + 1)

    const amountLines = voucher.inventoryLines.filter((line) => line.amount > 0)
    if (amountLines.length === 0) {
      addException(
        kind === "sales" ? "SALE_LINES_MISSING" : "PURCHASE_LINE_SKIPPED",
        `Voucher "${voucherLabel(voucher)}" has no stock line with a positive amount and was posted to the ledger only.`,
        sourceId,
      )
      continue
    }
    // A stock line Tally exported without a quantity is still a line the
    // voucher carries. It cannot become a sales or purchase line, but dropping
    // it without a word would understate the voucher, so it is named here.
    const quantityless = amountLines.filter(
      (line) => line.quantity === undefined || !Number.isFinite(line.quantity) || line.quantity <= 0,
    )
    if (quantityless.length > 0) {
      const total = round2(quantityless.reduce((sum, line) => sum + cents(line.amount), 0) / 100)
      addException(
        "STOCK_LINE_WITHOUT_QUANTITY",
        `Voucher "${voucherLabel(voucher)}" has ${quantityless.length} stock line${quantityless.length === 1 ? "" : "s"} worth ${money(total)} with no positive quantity (${quantityless
          .slice(0, 5)
          .map((line) => line.stockItemName)
          .join(", ")}${quantityless.length > 5 ? ", …" : ""}). Those lines are in the ledger but not the ${
          kind === "sales" ? "sales" : "purchases"
        } report.`,
        sourceId,
      )
    }
    const inventoryLines = amountLines.filter(
      (line) => line.quantity !== undefined && Number.isFinite(line.quantity) && line.quantity > 0,
    )
    if (inventoryLines.length === 0) continue

    const cashLines =
      kind === "sales"
        ? voucher.ledgerLines.filter((line) => line.side === "debit")
        : voucher.ledgerLines.filter((line) => line.side === "credit")
    const paymentLine = cashLines
      .map((line) => ({ line, method: paymentMethodFromLine(line, accountFor) }))
      .find((entry) => entry.method !== undefined)

    const partyLine = voucher.ledgerLines.find((line) => {
      const account = accountFor(line.ledgerName)
      return kind === "sales"
        ? account.role === "receivable" || account.partyType === "customer"
        : account.role === "payable" || account.partyType === "supplier"
    })
    // Tally's own PARTYLEDGERNAME can name the cash ledger on a cash sale or a
    // cash purchase; the line classified as the party is the better name. When
    // it names only cash, a purchase's debit line is the only place its
    // supplier is named, and naming the supplier "Cash" would be wrong.
    const namedParty = trimText(voucher.partyLedgerName, 200)
    const namedPartyIsCash =
      namedParty === undefined || isCashOrBankRole(accountFor(namedParty).role)
    const counterpartyLine =
      partyLine === undefined && kind === "purchase" && namedPartyIsCash
        ? voucher.ledgerLines.find(
            (line) => line.side === "debit" && !isCashOrBankRole(accountFor(line.ledgerName).role),
          )
        : undefined
    if (counterpartyLine) {
      addException(
        "PARTY_INFERRED",
        `Purchase "${voucherLabel(voucher)}" names "${counterpartyLine.ledgerName}" as its supplier only through the ledger line it debits, because the export has no ledger masters. Confirm it before applying.`,
        sourceId,
      )
    }
    const partyName =
      trimText(partyLine?.ledgerName, 200) ??
      trimText(counterpartyLine?.ledgerName, 200) ??
      namedParty

    const itemLines = inventoryLines.map((line) => {
      const quantity = Math.trunc(line.quantity ?? 0)
      const lineTotal = round2(line.amount)
      const unitPrice = line.rate !== undefined ? round2(line.rate) : round2(lineTotal / quantity)
      return { line, quantity, unitPrice, lineTotal, whole: Number.isInteger(line.quantity) }
    })
    const fractional = itemLines.filter((item) => !item.whole)
    if (fractional.length > 0) {
      // Truncating would mirror fewer units than Tally sold, so the line is
      // withheld and named instead.
      addException(
        kind === "sales" ? "SALE_LINE_SKIPPED" : "PURCHASE_LINE_SKIPPED",
        `Voucher "${voucherLabel(voucher)}" has ${fractional.length} stock line${fractional.length === 1 ? "" : "s"} with a quantity that is not a whole unit; those lines were not mirrored.`,
        sourceId,
      )
    }
    const usable = itemLines.filter(
      (item) => item.whole && item.quantity > 0 && item.lineTotal > 0,
    )
    if (usable.length === 0) continue

    const total = round2(usable.reduce((sum, item) => sum + cents(item.lineTotal), 0) / 100)
    const tax = round2(
      voucher.ledgerLines
        .filter((line) => {
          const account = accountFor(line.ledgerName)
          return kind === "sales"
            ? account.role === "vat_output" && line.side === "credit"
            : account.role === "vat_input" && line.side === "debit"
        })
        .reduce((sum, line) => sum + cents(line.amount), 0) / 100,
    )

    if (kind === "sales") {
      if (!paymentLine?.method) {
        addException(
          "CREDIT_SALE_NOT_MIRRORED",
          `Sale "${voucherLabel(voucher)}" has no cash, card, mobile-money or bank receipt. It is in the ledger and customer balance but not the sales report.`,
          sourceId,
        )
        continue
      }
      const discount = round2(
        voucher.ledgerLines
          .filter((line) => {
            const account = accountFor(line.ledgerName)
            return account.systemKey === "SALES_DISCOUNTS" && line.side === "debit"
          })
          .reduce((sum, line) => sum + cents(line.amount), 0) / 100,
      )
      if (!costUnknownReported) {
        costUnknownReported = true
        addException(
          "COST_UNKNOWN",
          "Tally sales vouchers do not state a cost of sale. A replay derives it from the batches each sale removed at their purchase rates; a line the replay cannot cost keeps the product's recorded cost instead, and this warning names that policy.",
        )
      }
      sales.push({
        sourceId,
        date: voucher.date,
        transactionNumber: `TALLY-${voucher.number?.trim() || derivedId.slice(-8)}`,
        partyName,
        paymentMethod: paymentLine.method,
        total,
        tax,
        discount,
        items: usable.map((item) => ({
          stockItemName: item.line.stockItemName,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          lineTotal: item.lineTotal,
          lineIndex: voucher.inventoryLines.indexOf(item.line),
        })),
      })
    } else {
      if (!partyName) {
        addException(
          "PARTY_MISSING",
          `Purchase "${voucherLabel(voucher)}" has no supplier ledger. It is in the ledger but not the purchases report.`,
          sourceId,
        )
        continue
      }
      purchases.push({
        sourceId,
        date: voucher.date,
        purchaseNumber: `TALLY-${voucher.number?.trim() || derivedId.slice(-8)}`,
        partyName,
        total,
        tax,
        amountPaid: paymentLine?.method && paymentLine.line.amount > 0 ? round2(Math.min(total, paymentLine.line.amount)) : 0,
        paymentMethod: paymentLine?.method,
        items: usable.map((item) => ({
          stockItemName: item.line.stockItemName,
          quantity: item.quantity,
          unitCost: item.unitPrice,
          lineTotal: item.lineTotal,
        })),
      })
    }
  }

  return {
    company,
    companyKey,
    currency,
    conversionDate,
    ...(mode === "replay"
      ? {
          cutoffDate,
          ordering: "date-then-export-order" as const,
          movements: replayMovements,
        }
      : {}),
    batchExpiry,
    mode,
    accounts: cutoverAccounts,
    parties,
    stockItems,
    stock,
    opening: {
      date: conversionDate,
      currency,
      lines: openingLines,
      totalDebit: round2(openingDebit / 100),
      totalCredit: round2(openingCredit / 100),
      difference: openingDifference,
    },
    vouchers,
    sales,
    purchases,
    exceptions,
    exceptionCounts,
    counts: {
      ledgers: document.ledgers.length,
      groups: document.groups.length,
      stockItems: document.stockItems.length,
      vouchers: sourceVouchers.length,
      postedVouchers: vouchers.length,
      skippedVouchers,
      sales: sales.length,
      purchases: purchases.length,
      openingLines: openingLines.length,
    },
    warnings: document.warnings,
  }
}
