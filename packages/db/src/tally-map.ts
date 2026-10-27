/**
 * Tally master mapping.
 *
 * Tally groups are a tree, and Tally's predefined groups are the only stable
 * signal for a ledger's accounting type. This module classifies a ledger by
 * walking its parent group chain, maps the names the ledger seed already knows
 * to their seeded `system_key`, and gives every other ledger a deterministic
 * code. It never asks Tally for anything it did not export.
 */

import type { TallyGroup, TallyLedger } from "./tally-xml-rows"

export type TallyAccountType = "asset" | "liability" | "equity" | "income" | "expense"
export type TallyNormalBalance = "debit" | "credit"

export type TallyAccountRole =
  | "cash"
  | "bank"
  | "overdraft"
  | "mobile_money"
  | "card"
  | "receivable"
  | "payable"
  | "inventory"
  | "vat_input"
  | "vat_output"
  | "sales"
  | "cogs"
  | "expense"
  | "equity"
  | "other"

export type TallyAccountClassification = {
  accountType: TallyAccountType
  normalBalance: TallyNormalBalance
  role: TallyAccountRole
}

export type TallyLedgerClassification = TallyAccountClassification & {
  systemKey?: string
  partyType?: "customer" | "supplier"
  unclassified: boolean
}

export type TallyMappedAccount = TallyLedgerClassification & {
  sourceName: string
  name: string
  code: string
  sourceGuid?: string
}

export type TallyAccountOverride = {
  name?: string
  accountType?: TallyAccountType
  normalBalance?: TallyNormalBalance
  systemKey?: string | null
  partyType?: "customer" | "supplier" | null
}

export type TallyAccountOverrides = Record<string, TallyAccountOverride>

export type TallyVoucherKind =
  | "sales"
  | "purchase"
  | "receipt"
  | "payment"
  | "contra"
  | "journal"
  | "credit_note"
  | "debit_note"
  | "stock_journal"
  | "inventory_note"
  | "order"
  | "other"

const SYSTEM_ACCOUNTS: Record<string, TallyAccountClassification & { code: string }> = {
  CASH_ON_HAND: { code: "1000", accountType: "asset", normalBalance: "debit", role: "cash" },
  BANK: { code: "1010", accountType: "asset", normalBalance: "debit", role: "bank" },
  MOBILE_MONEY_CLEARING: {
    code: "1020",
    accountType: "asset",
    normalBalance: "debit",
    role: "mobile_money",
  },
  CARD_CLEARING: { code: "1030", accountType: "asset", normalBalance: "debit", role: "card" },
  ACCOUNTS_RECEIVABLE: {
    code: "1100",
    accountType: "asset",
    normalBalance: "debit",
    role: "receivable",
  },
  INVENTORY: { code: "1200", accountType: "asset", normalBalance: "debit", role: "inventory" },
  INPUT_VAT: { code: "1300", accountType: "asset", normalBalance: "debit", role: "vat_input" },
  ACCOUNTS_PAYABLE: {
    code: "2000",
    accountType: "liability",
    normalBalance: "credit",
    role: "payable",
  },
  OUTPUT_VAT: { code: "2100", accountType: "liability", normalBalance: "credit", role: "vat_output" },
  OPENING_BALANCE_EQUITY: {
    code: "3000",
    accountType: "equity",
    normalBalance: "credit",
    role: "equity",
  },
  RETAINED_EARNINGS: { code: "3100", accountType: "equity", normalBalance: "credit", role: "equity" },
  SALES_REVENUE: { code: "4000", accountType: "income", normalBalance: "credit", role: "sales" },
  SALES_DISCOUNTS: { code: "4010", accountType: "income", normalBalance: "debit", role: "other" },
  COST_OF_GOODS_SOLD: { code: "5000", accountType: "expense", normalBalance: "debit", role: "cogs" },
  OPERATING_EXPENSES: { code: "5100", accountType: "expense", normalBalance: "debit", role: "expense" },
}

const GROUP_CLASSIFICATIONS: Record<string, TallyAccountClassification> = {
  "CASH IN HAND": { accountType: "asset", normalBalance: "debit", role: "cash" },
  CASH: { accountType: "asset", normalBalance: "debit", role: "cash" },
  "BANK ACCOUNTS": { accountType: "asset", normalBalance: "debit", role: "bank" },
  "BANK ACCOUNT": { accountType: "asset", normalBalance: "debit", role: "bank" },
  BANK: { accountType: "asset", normalBalance: "debit", role: "bank" },
  "BANK OD ACCOUNT": { accountType: "liability", normalBalance: "credit", role: "overdraft" },
  "BANK OD A C": { accountType: "liability", normalBalance: "credit", role: "overdraft" },
  "BANK OCC ACCOUNT": { accountType: "liability", normalBalance: "credit", role: "overdraft" },
  "BANK OVERDRAFT": { accountType: "liability", normalBalance: "credit", role: "overdraft" },
  "MOBILE MONEY": { accountType: "asset", normalBalance: "debit", role: "mobile_money" },
  "CARD CLEARING": { accountType: "asset", normalBalance: "debit", role: "card" },
  "SUNDRY DEBTORS": { accountType: "asset", normalBalance: "debit", role: "receivable" },
  "SUNDRY CREDITORS": { accountType: "liability", normalBalance: "credit", role: "payable" },
  "STOCK IN HAND": { accountType: "asset", normalBalance: "debit", role: "inventory" },
  "STOCK IN HAND ACCOUNT": { accountType: "asset", normalBalance: "debit", role: "inventory" },
  "FIXED ASSETS": { accountType: "asset", normalBalance: "debit", role: "other" },
  "CURRENT ASSETS": { accountType: "asset", normalBalance: "debit", role: "other" },
  "CURRENT LIABILITIES": { accountType: "liability", normalBalance: "credit", role: "other" },
  "CAPITAL ACCOUNT": { accountType: "equity", normalBalance: "credit", role: "equity" },
  "LOANS LIABILITY": { accountType: "liability", normalBalance: "credit", role: "other" },
  LOANS: { accountType: "liability", normalBalance: "credit", role: "other" },
  "LOANS AND ADVANCES ASSET": { accountType: "asset", normalBalance: "debit", role: "other" },
  "LOANS AND ADVANCES": { accountType: "asset", normalBalance: "debit", role: "other" },
  "DUTIES AND TAXES": { accountType: "liability", normalBalance: "credit", role: "other" },
  PROVISIONS: { accountType: "liability", normalBalance: "credit", role: "other" },
  "SALES ACCOUNTS": { accountType: "income", normalBalance: "credit", role: "sales" },
  SALES: { accountType: "income", normalBalance: "credit", role: "sales" },
  "PURCHASE ACCOUNTS": { accountType: "expense", normalBalance: "debit", role: "cogs" },
  PURCHASES: { accountType: "expense", normalBalance: "debit", role: "cogs" },
  "DIRECT INCOMES": { accountType: "income", normalBalance: "credit", role: "other" },
  "DIRECT EXPENSES": { accountType: "expense", normalBalance: "debit", role: "expense" },
  "INDIRECT INCOMES": { accountType: "income", normalBalance: "credit", role: "other" },
  "INDIRECT EXPENSES": { accountType: "expense", normalBalance: "debit", role: "expense" },
  "SUSPENSE ACCOUNT": { accountType: "asset", normalBalance: "debit", role: "other" },
  SUSPENSE: { accountType: "asset", normalBalance: "debit", role: "other" },
  "BRANCH DIVISIONS": { accountType: "asset", normalBalance: "debit", role: "other" },
  "BRANCH DIVISION": { accountType: "asset", normalBalance: "debit", role: "other" },
  INVESTMENTS: { accountType: "asset", normalBalance: "debit", role: "other" },
  "SECURED LOANS": { accountType: "liability", normalBalance: "credit", role: "other" },
  "UNSECURED LOANS": { accountType: "liability", normalBalance: "credit", role: "other" },
  "DEPOSITS ASSET": { accountType: "asset", normalBalance: "debit", role: "other" },
  "ADVANCE TAX": { accountType: "asset", normalBalance: "debit", role: "other" },
  "MISCELLANEOUS EXPENSES ASSET": { accountType: "asset", normalBalance: "debit", role: "other" },
  "DEFERRED TAX ASSET": { accountType: "asset", normalBalance: "debit", role: "other" },
  "DEFERRED TAX LIABILITY": { accountType: "liability", normalBalance: "credit", role: "other" },
  "PROFIT AND LOSS ACCOUNT": { accountType: "equity", normalBalance: "credit", role: "equity" },
  "PROFIT AND LOSS A C": { accountType: "equity", normalBalance: "credit", role: "equity" },
  "PROFIT AND LOSS": { accountType: "equity", normalBalance: "credit", role: "equity" },
  "OPENING BALANCE": { accountType: "equity", normalBalance: "credit", role: "equity" },
}

/** Exact ledger names the seeded chart already owns. Anything else becomes a custom account. */
const SYSTEM_KEYS_BY_NAME: Record<string, string> = {
  CASH: "CASH_ON_HAND",
  "CASH IN HAND": "CASH_ON_HAND",
  "CASH ON HAND": "CASH_ON_HAND",
  "CASH A C": "CASH_ON_HAND",
  BANK: "BANK",
  "BANK ACCOUNT": "BANK",
  "BANK A C": "BANK",
  "MOBILE MONEY": "MOBILE_MONEY_CLEARING",
  "MOBILE MONEY CLEARING": "MOBILE_MONEY_CLEARING",
  "MOBILE MONEY ACCOUNT": "MOBILE_MONEY_CLEARING",
  CARD: "CARD_CLEARING",
  "CARD CLEARING": "CARD_CLEARING",
  "ACCOUNTS RECEIVABLE": "ACCOUNTS_RECEIVABLE",
  "SUNDRY DEBTORS": "ACCOUNTS_RECEIVABLE",
  "ACCOUNTS PAYABLE": "ACCOUNTS_PAYABLE",
  "SUNDRY CREDITORS": "ACCOUNTS_PAYABLE",
  INVENTORY: "INVENTORY",
  "STOCK IN HAND": "INVENTORY",
  "INPUT VAT": "INPUT_VAT",
  "VAT INPUT": "INPUT_VAT",
  "INPUT VAT RECEIVABLE": "INPUT_VAT",
  "INPUT TAX": "INPUT_VAT",
  "OUTPUT VAT": "OUTPUT_VAT",
  "VAT OUTPUT": "OUTPUT_VAT",
  "VAT PAYABLE": "OUTPUT_VAT",
  "OUTPUT VAT PAYABLE": "OUTPUT_VAT",
  "SALES TAX": "OUTPUT_VAT",
  "OPENING BALANCE EQUITY": "OPENING_BALANCE_EQUITY",
  "OPENING BALANCE DIFFERENCE": "OPENING_BALANCE_EQUITY",
  "RETAINED EARNINGS": "RETAINED_EARNINGS",
  SALES: "SALES_REVENUE",
  "SALES ACCOUNTS": "SALES_REVENUE",
  "SALES REVENUE": "SALES_REVENUE",
  REVENUE: "SALES_REVENUE",
  "SALES DISCOUNTS": "SALES_DISCOUNTS",
  "DISCOUNT ALLOWED": "SALES_DISCOUNTS",
  "COST OF GOODS SOLD": "COST_OF_GOODS_SOLD",
  COGS: "COST_OF_GOODS_SOLD",
  "OPERATING EXPENSES": "OPERATING_EXPENSES",
}

export function normaliseTallyKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

/** FNV-1a, used only for stable, non-secret identifiers. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

export function tallyAccountCode(guid: string | undefined, name: string): string {
  return `T-${stableHash(guid?.trim() || normaliseTallyKey(name)).toUpperCase()}`
}

function groupChain(
  groupName: string | undefined,
  groups: Map<string, TallyGroup>,
): { classification?: TallyAccountClassification; matchedGroup?: string } {
  if (!groupName) return {}
  const seen = new Set<string>()
  let current = normaliseTallyKey(groupName)
  for (let depth = 0; depth < 32 && current && !seen.has(current); depth += 1) {
    seen.add(current)
    const classification = GROUP_CLASSIFICATIONS[current]
    if (classification) return { classification, matchedGroup: current }
    const parent = groups.get(current)?.parent
    current = parent ? normaliseTallyKey(parent) : ""
  }
  return {}
}

function roleToParty(role: TallyAccountRole): "customer" | "supplier" | undefined {
  if (role === "receivable") return "customer"
  if (role === "payable") return "supplier"
  return undefined
}

export function classifyTallyLedger(
  ledger: TallyLedger,
  groups: Map<string, TallyGroup>,
  override?: TallyAccountOverride,
): TallyLedgerClassification {
  const key = normaliseTallyKey(ledger.name)
  const chain = groupChain(ledger.parent, groups)
  const requestedSystemKey = override?.systemKey === null ? undefined : override?.systemKey
  const nameSystemKey = override?.systemKey === null ? undefined : SYSTEM_KEYS_BY_NAME[key]
  const systemKey = requestedSystemKey ?? nameSystemKey
  const system = systemKey ? SYSTEM_ACCOUNTS[systemKey] : undefined

  const base: TallyAccountClassification = system
    ? { accountType: system.accountType, normalBalance: system.normalBalance, role: system.role }
    : chain.classification ?? { accountType: "asset", normalBalance: "debit", role: "other" }

  const accountType = override?.accountType ?? base.accountType
  const role = system?.role ?? base.role
  const normalBalance =
    override?.normalBalance ??
    (override?.accountType && !override?.normalBalance
      ? accountType === "asset" || accountType === "expense"
        ? "debit"
        : "credit"
      : base.normalBalance)

  const partyType =
    override?.partyType === null
      ? undefined
      : override?.partyType ?? roleToParty(role)

  return {
    accountType,
    normalBalance,
    role,
    systemKey,
    partyType,
    unclassified: !system && !chain.classification,
  }
}

function uniqueCode(base: string, assigned: Set<string>, reserved: Set<string>): string {
  if (!assigned.has(base) && !reserved.has(base)) {
    assigned.add(base)
    return base
  }
  let suffix = 2
  while (assigned.has(`${base}-${suffix}`) || reserved.has(`${base}-${suffix}`)) suffix += 1
  const code = `${base}-${suffix}`
  assigned.add(code)
  return code
}

export function mapTallyLedgers(
  ledgers: TallyLedger[],
  groups: TallyGroup[],
  overrides: TallyAccountOverrides = {},
): TallyMappedAccount[] {
  const groupMap = new Map<string, TallyGroup>()
  for (const group of groups) groupMap.set(normaliseTallyKey(group.name), group)

  const reservedCodes = new Set(Object.values(SYSTEM_ACCOUNTS).map((account) => account.code))
  const assignedCodes = new Set<string>()
  const seen = new Set<string>()
  const mapped: TallyMappedAccount[] = []

  for (const ledger of ledgers) {
    const sourceName = ledger.name.trim()
    const key = normaliseTallyKey(sourceName)
    if (!key || seen.has(key)) continue
    seen.add(key)

    const override = overrides[key]
    const classification = classifyTallyLedger(ledger, groupMap, override)
    const system = classification.systemKey ? SYSTEM_ACCOUNTS[classification.systemKey] : undefined
    const canUseSystemCode = system && !assignedCodes.has(system.code)
    const code = canUseSystemCode
      ? (assignedCodes.add(system.code), system.code)
      : uniqueCode(tallyAccountCode(ledger.guid, sourceName), assignedCodes, reservedCodes)
    const name = (override?.name?.trim() || sourceName).replace(/\s+/g, " ").slice(0, 200)

    mapped.push({
      sourceName,
      name,
      code,
      sourceGuid: ledger.guid,
      ...classification,
    })
  }

  return mapped
}

export function classifyTallyVoucherType(raw: string): TallyVoucherKind {
  const key = normaliseTallyKey(raw)
  if (!key) return "other"
  if (key.includes("CREDIT NOTE") || key === "CREDITNOTE") return "credit_note"
  if (key.includes("DEBIT NOTE") || key === "DEBITNOTE") return "debit_note"
  if (key.includes("SALES ORDER") || key.includes("PURCHASE ORDER") || key === "ORDER") return "order"
  if (
    key.includes("DELIVERY NOTE") ||
    key.includes("RECEIPT NOTE") ||
    key.includes("REJECTION") ||
    key.includes("STOCK JOURNAL") ||
    key.includes("PHYSICAL STOCK")
  ) {
    return key.includes("STOCK JOURNAL") || key.includes("PHYSICAL STOCK")
      ? "stock_journal"
      : "inventory_note"
  }
  if (key.includes("SALES")) return "sales"
  if (key.includes("PURCHASE")) return "purchase"
  if (key.includes("RECEIPT")) return "receipt"
  if (key.includes("PAYMENT")) return "payment"
  if (key.includes("CONTRA")) return "contra"
  if (key.includes("JOURNAL") || key === "JV" || key === "JOURNAL VOUCHER") return "journal"
  return "other"
}

export function tallyVoucherSourceType(kind: TallyVoucherKind): string | undefined {
  switch (kind) {
    case "sales":
      return "tally_sale"
    case "purchase":
      return "tally_purchase"
    case "receipt":
      return "tally_receipt"
    case "payment":
      return "tally_payment"
    case "contra":
      return "tally_contra"
    case "journal":
      return "tally_journal"
    case "credit_note":
      return "tally_credit_note"
    case "debit_note":
      return "tally_debit_note"
    default:
      return undefined
  }
}

export function paymentMethodForRole(role: TallyAccountRole): "CASH" | "CARD" | "MOBILE_MONEY" | "BANK_TRANSFER" | undefined {
  switch (role) {
    case "cash":
      return "CASH"
    case "card":
      return "CARD"
    case "mobile_money":
      return "MOBILE_MONEY"
    case "bank":
    case "overdraft":
      return "BANK_TRANSFER"
    default:
      return undefined
  }
}

export function isCashOrBankRole(role: TallyAccountRole): boolean {
  return role === "cash" || role === "bank" || role === "mobile_money" || role === "card" || role === "overdraft"
}

export const TALLY_SYSTEM_ACCOUNT_CODES = Object.fromEntries(
  Object.entries(SYSTEM_ACCOUNTS).map(([key, account]) => [key, account.code]),
) as Record<string, string>
