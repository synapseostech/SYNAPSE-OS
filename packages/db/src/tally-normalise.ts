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
  type TallyMappedAccount,
  type TallyNormalBalance,
  type TallyVoucherKind,
} from "./tally-map"
import type {
  TallyBillAllocation,
  TallyLedger,
  TallyLedgerLine,
  TallyVoucher,
  TallyXmlDocument,
  TallyXmlRowWarning,
} from "./tally-xml-rows"

export type TallyExceptionCode =
  | "COMPANY_MISSING"
  | "CONVERSION_DATE_REQUIRED"
  | "UNCLASSIFIED_LEDGER"
  | "LEDGER_MISSING"
  | "DUPLICATE_LEDGER"
  | "OPENING_DIFFERENCE"
  | "OPENING_BALANCE_UNAVAILABLE"
  | "OPENING_STOCK_WITHOUT_EXPIRY"
  | "OPENING_STOCK_EXPIRED"
  | "OPENING_STOCK_WITHOUT_VALUE"
  | "OPENING_STOCK_WITHOUT_QUANTITY"
  | "OPENING_STOCK_QUANTITY_MISMATCH"
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
  | "CREDIT_SALE_NOT_MIRRORED"
  | "COST_UNKNOWN"
  | "PURCHASE_LINE_SKIPPED"
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
  openingMethod: "exported" | "derived" | "none"
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
  quantity?: number
  rate?: number
  value?: number
  batches: TallyCutoverStockBatch[]
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

export type TallyCutoverSaleItem = {
  stockItemName: string
  quantity: number
  unitPrice: number
  lineTotal: number
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
  accounts: TallyCutoverAccount[]
  parties: TallyCutoverParty[]
  stockItems: TallyCutoverStockItem[]
  opening: TallyCutoverOpening
  vouchers: TallyCutoverVoucher[]
  sales: TallyCutoverSale[]
  purchases: TallyCutoverPurchase[]
  exceptions: TallyException[]
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

export type TallyNormaliseOptions = {
  conversionDate?: string
  currency?: string
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
  /** Today in Africa/Kampala (YYYY-MM-DD). Defaults to the current date. */
  today?: string
}

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

function paymentMethodFromLine(
  line: TallyLedgerLine,
  accountFor: (name: string) => TallyMappedAccount,
): "CASH" | "CARD" | "MOBILE_MONEY" | "BANK_TRANSFER" | undefined {
  if (line.amount <= 0) return undefined
  const account = accountFor(line.ledgerName)
  return isCashOrBankRole(account.role) ? paymentMethodForRole(account.role) : undefined
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

export function normaliseTallyDocument(
  document: TallyXmlDocument,
  options: TallyNormaliseOptions = {},
): TallyCutoverPlan {
  const conversionDate =
    options.conversionDate ??
    document.financialPeriod.from ??
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

  if (!company) addException("COMPANY_MISSING", "The export did not name a company. Source identifiers use a hash of the file's data.")

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
  const accountFor = (ledgerName: string): TallyMappedAccount => {
    const key = normaliseTallyKey(ledgerName)
    const found = accountsByKey.get(key)
    if (found) return found
    const sourceName = trimText(ledgerName, 200) ?? ledgerName
    const account: TallyMappedAccount = {
      sourceName,
      name: sourceName,
      code: tallyAccountCode(undefined, sourceName),
      accountType: "asset",
      normalBalance: "debit",
      role: "other",
      unclassified: true,
    }
    accountsByKey.set(key, account)
    extraAccounts.push(account)
    addException(
      "LEDGER_MISSING",
      `Ledger "${sourceName}" appears in a voucher but not in the exported masters. It was created as a debit asset; review it.`,
      sourceName,
    )
    return account
  }

  const movements = new Map<string, number>()
  const addMovement = (ledgerName: string, debit: number, credit: number) => {
    const key = normaliseTallyKey(ledgerName)
    movements.set(key, (movements.get(key) ?? 0) + cents(debit) - cents(credit))
  }

  const vouchers: TallyCutoverVoucher[] = []
  const acceptedVouchers: Array<{ voucher: TallyVoucher; sourceId: string; kind: TallyVoucherKind }> = []
  let skippedVouchers = 0
  const usedSourceIds = new Set<string>()

  for (const voucher of document.vouchers) {
    const kind = classifyTallyVoucherType(voucher.type)
    const sourceType = tallyVoucherSourceType(kind)
    if (!sourceType) {
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
    if (voucher.date < conversionDate) {
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

    const derivedId =
      voucher.guid ??
      voucher.remoteId ??
      `H-${stableHash(
        [
          voucher.type,
          voucher.number ?? "",
          voucher.date,
          voucher.partyLedgerName ?? "",
          ...lines.map((line) => `${line.account.code}:${line.debit}:${line.credit}`),
        ].join("|"),
      ).toUpperCase()}`
    if (!voucher.guid && !voucher.remoteId) {
      addException(
        "VOUCHER_GUID_MISSING",
        `Voucher "${voucherLabel(voucher)}" has no Tally identifier. A stable content hash is used so re-runs do not duplicate it.`,
        derivedId,
      )
    }

    const sourceId = `${companyKey}:${derivedId}`
    if (usedSourceIds.has(sourceId)) {
      skippedVouchers += 1
      addException("VOUCHER_DUPLICATE", `Duplicate voucher identity ${sourceId} appears more than once; later copies were skipped.`, sourceId)
      continue
    }
    usedSourceIds.add(sourceId)

    for (const line of lines) addMovement(line.account.sourceName, line.debit, line.credit)

    acceptedVouchers.push({ voucher, sourceId, kind })
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

  const allAccounts = [...mapped, ...extraAccounts]
  const cutoverAccounts: TallyCutoverAccount[] = allAccounts.map((account) => {
    const sourceLedger = ledgerByKey.get(normaliseTallyKey(account.sourceName))
    const closing = sourceLedger?.closingBalance
    let opening: number | undefined
    let openingMethod: "exported" | "derived" | "none" = "none"

    if (sourceLedger?.openingBalance !== undefined) {
      opening = sourceLedger.openingBalance
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
      description: "Tally opening balance",
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
  const seenStock = new Set<string>()
  const stockItems: TallyCutoverStockItem[] = []
  for (const item of document.stockItems) {
    const key = normaliseTallyKey(item.name)
    if (!key || seenStock.has(key)) continue
    seenStock.add(key)

    const quantity = item.openingQuantity
    const value = item.openingValue
    const rate =
      item.openingRate ??
      (quantity && quantity !== 0 && value !== undefined ? round2(value / quantity) : undefined)
    const batches: TallyCutoverStockBatch[] = item.batches.map((batch) => {
      const expiryDate = batch.expiryDate
      const batchQuantity = batch.quantity
      const receivable =
        Boolean(expiryDate) &&
        Boolean(expiryDate && expiryDate >= today) &&
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

    if (quantity !== undefined && quantity > 0) {
      const hasExpiry = batches.some((batch) => batch.expiryDate)
      const expired = batches.filter((batch) => batch.expiryDate && batch.expiryDate < today)
      if (!hasExpiry) {
        addException(
          "OPENING_STOCK_WITHOUT_EXPIRY",
          `Stock item "${item.name}" has opening quantity ${quantity} but no batch expiry. Its opening value stays in the ledger; no stock batch is created.`,
          item.name,
        )
      }
      if (expired.length > 0) {
        const expiredQuantity = expired.reduce((total, batch) => total + (batch.quantity ?? 0), 0)
        addException(
          "OPENING_STOCK_EXPIRED",
          `Stock item "${item.name}" has ${expired.length} batch${expired.length === 1 ? "" : "es"} totalling ${expiredQuantity} unit${expiredQuantity === 1 ? "" : "s"} whose expiry is on or before ${today}. The ledger opening is posted; the expired batches are not received into sellable stock.`,
          item.name,
        )
      }
      if (value === undefined && rate === undefined) {
        addException(
          "OPENING_STOCK_WITHOUT_VALUE",
          `Stock item "${item.name}" has opening quantity but no opening value or rate. Its stock batch is not created.`,
          item.name,
        )
      }
      if (!Number.isInteger(quantity)) {
        addException(
          "NON_INTEGER_QUANTITY",
          `Stock item "${item.name}" opens at ${quantity}, which is not a whole unit. The pharmacy stock ledger only accepts whole units, so no batch is created.`,
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
    } else if (item.openingQuantity !== undefined && item.openingQuantity < 0) {
      addException(
        "OPENING_STOCK_WITHOUT_QUANTITY",
        `Stock item "${item.name}" has a negative opening quantity, which cannot be received. The ledger opening is still posted.`,
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
      batches,
    })
  }

  const sales: TallyCutoverSale[] = []
  const purchases: TallyCutoverPurchase[] = []
  let costUnknownReported = false

  for (const { voucher, sourceId } of acceptedVouchers) {
    const kind = classifyTallyVoucherType(voucher.type)
    if (kind !== "sales" && kind !== "purchase") continue
    if (!voucher.date) continue
    const derivedId = sourceId.slice(companyKey.length + 1)

    const inventoryLines = voucher.inventoryLines.filter((line) => line.amount > 0 && line.quantity !== undefined && line.quantity > 0)
    if (inventoryLines.length === 0) {
      addException(
        kind === "sales" ? "SALE_LINES_MISSING" : "PURCHASE_LINE_SKIPPED",
        `Voucher "${voucherLabel(voucher)}" has no stock lines and was posted to the ledger only.`,
        sourceId,
      )
      continue
    }

    const cashLines =
      kind === "sales"
        ? voucher.ledgerLines.filter((line) => line.side === "debit")
        : voucher.ledgerLines.filter((line) => line.side === "credit")
    const paymentLine = cashLines
      .map((line) => ({ line, method: paymentMethodFromLine(line, accountFor) }))
      .find((entry) => entry.method !== undefined)

    const partyLine = voucher.ledgerLines.find((line) => {
      const account = accountFor(line.ledgerName)
      return kind === "sales" ? account.role === "receivable" : account.role === "payable"
    })
    const partyName = trimText(voucher.partyLedgerName, 200) ?? trimText(partyLine?.ledgerName, 200)

    const itemLines = inventoryLines.map((line) => {
      const quantity = Math.trunc(line.quantity ?? 0)
      const lineTotal = round2(line.amount)
      const unitPrice = line.rate !== undefined ? round2(line.rate) : round2(lineTotal / quantity)
      return { line, quantity, unitPrice, lineTotal }
    })
    const skippedLines = itemLines.filter((item) => item.quantity <= 0 || item.lineTotal <= 0)
    if (skippedLines.length > 0) {
      addException(
        kind === "sales" ? "SALE_LINE_SKIPPED" : "PURCHASE_LINE_SKIPPED",
        `Voucher "${voucherLabel(voucher)}" has stock lines that are not whole positive units; those lines were not mirrored.`,
        sourceId,
      )
    }
    const usable = itemLines.filter((item) => item.quantity > 0 && item.lineTotal > 0)
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
          "Tally sales vouchers do not carry a cost of sale. Imported sales show revenue and gross profit in the ledger, but the operational profit report cannot reconstruct historical cost.",
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
    accounts: cutoverAccounts,
    parties,
    stockItems,
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
    counts: {
      ledgers: document.ledgers.length,
      groups: document.groups.length,
      stockItems: document.stockItems.length,
      vouchers: document.vouchers.length,
      postedVouchers: vouchers.length,
      skippedVouchers,
      sales: sales.length,
      purchases: purchases.length,
      openingLines: openingLines.length,
    },
    warnings: document.warnings,
  }
}
