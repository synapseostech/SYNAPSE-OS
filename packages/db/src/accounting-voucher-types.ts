/**
 * Tally-style voucher semantics for hand-typed entries.
 *
 * The ledger RPC only checks that a journal balances. Tally also fixes the
 * shape of each voucher type, and a payment posted backwards is a real
 * bookkeeping error that still balances. These rules are enforced server-side
 * before the RPC is called.
 */

export const VOUCHER_TYPES = [
  "journal",
  "payment",
  "receipt",
  "contra",
  "credit_note",
  "debit_note",
] as const

export type VoucherType = (typeof VOUCHER_TYPES)[number]

export const VOUCHER_TYPE_LABELS: Record<VoucherType, string> = {
  journal: "Journal",
  payment: "Payment",
  receipt: "Receipt",
  contra: "Contra",
  credit_note: "Credit note",
  debit_note: "Debit note",
}

export const VOUCHER_TYPE_HELP: Record<VoucherType, string> = {
  journal: "Any balanced adjustment that no other voucher type describes.",
  payment: "Money leaves a cash or bank account and settles an expense, supplier or other account.",
  receipt: "Money arrives in a cash or bank account from a customer or another account.",
  contra: "Money moves between cash and bank accounts only. Nothing is earned or spent.",
  credit_note: "A customer is credited for a return or an overcharge, reducing what they owe.",
  debit_note: "A supplier is debited for a return or an overcharge, reducing what we owe.",
}

export type VoucherAccountRole = "cash" | "bank" | "receivable" | "payable" | "other"

const MONEY_SYSTEM_KEYS = new Set([
  "CASH_ON_HAND",
  "BANK",
  "MOBILE_MONEY_CLEARING",
  "CARD_CLEARING",
])

export type VoucherAccount = {
  id: string
  code: string
  name: string
  system_key?: string | null
}

export type VoucherLine = {
  account_id: string
  debit: number
  credit: number
}

export type VoucherCheck = { ok: true } | { ok: false; error: string }

export function isVoucherType(value: unknown): value is VoucherType {
  return typeof value === "string" && (VOUCHER_TYPES as readonly string[]).includes(value)
}

export function voucherAccountRole(account: VoucherAccount | undefined): VoucherAccountRole {
  const key = account?.system_key?.trim().toUpperCase()
  if (!key) return "other"
  if (key === "CASH_ON_HAND") return "cash"
  if (MONEY_SYSTEM_KEYS.has(key)) return "bank"
  if (key === "ACCOUNTS_RECEIVABLE") return "receivable"
  if (key === "ACCOUNTS_PAYABLE") return "payable"
  return "other"
}

export function isMoneyRole(role: VoucherAccountRole): boolean {
  return role === "cash" || role === "bank"
}

/**
 * The journal RPC writes its audit row only when source_type is exactly
 * "manual", so the voucher type travels in source_id instead. Bare ids were
 * written before typed vouchers existed and read as journals.
 */
export function manualVoucherSourceId(type: VoucherType, idempotencyKey: string): string {
  return type === "journal" ? idempotencyKey : `manual:${type}:${idempotencyKey}`
}

/** What the day book shows; wider than what a person can type by hand. */
export type VoucherKind = VoucherType | "sales" | "purchase" | "other"

export const VOUCHER_KIND_LABELS: Record<VoucherKind, string> = {
  ...VOUCHER_TYPE_LABELS,
  sales: "Sales",
  purchase: "Purchase",
  other: "Other",
}

const OPERATIONAL_SOURCES: Record<string, VoucherKind> = {
  sale: "sales",
  purchase: "purchase",
  customer_receipt: "receipt",
  supplier_payment: "payment",
}

/** Voucher kinds the day book can filter, in the order the pickers show them. */
export const DAY_BOOK_KINDS = [
  "journal",
  "payment",
  "receipt",
  "contra",
  "credit_note",
  "debit_note",
  "sales",
  "purchase",
] as const

export type DayBookKind = (typeof DAY_BOOK_KINDS)[number]

export function isDayBookKind(value: unknown): value is DayBookKind {
  return typeof value === "string" && (DAY_BOOK_KINDS as readonly string[]).includes(value)
}

/**
 * PostgREST filter for one voucher kind. Hand-typed journals written before
 * typed vouchers kept a bare idempotency key as their source id, so a journal
 * filter has to include rows that do not carry the "manual:" prefix.
 */
export function dayBookKindFilter(kind: DayBookKind): string {
  const parts: string[] = []
  if (kind === "journal") {
    parts.push("source_id.like.manual:journal:%")
    parts.push("and(source_type.eq.manual,source_id.not.like.manual:%)")
    parts.push("source_type.eq.tally_journal")
    return parts.join(",")
  }
  if (kind === "sales") {
    return "source_type.eq.sale,source_type.eq.tally_sale"
  }
  if (kind === "purchase") {
    return "source_type.eq.purchase,source_type.eq.tally_purchase"
  }
  if (kind === "receipt") {
    return `source_id.like.manual:receipt:%,source_type.eq.customer_receipt,source_type.eq.tally_receipt`
  }
  if (kind === "payment") {
    return `source_id.like.manual:payment:%,source_type.eq.supplier_payment,source_type.eq.tally_payment`
  }
  return `source_id.like.manual:${kind}:%,source_type.eq.tally_${kind}`
}

export function voucherKindFromSource(sourceType: string, sourceId: string): VoucherKind {
  const tally = /^tally_(sales?|purchase|journal|payment|receipt|contra|credit_note|debit_note)$/.exec(
    sourceType,
  )
  if (tally) return tally[1] === "sale" || tally[1] === "sales" ? "sales" : (tally[1] as VoucherKind)
  if (sourceType !== "manual") return OPERATIONAL_SOURCES[sourceType] ?? "other"
  const match = /^manual:(journal|payment|receipt|contra|credit_note|debit_note):/.exec(sourceId)
  return match ? (match[1] as VoucherType) : "journal"
}

function accountFor(line: VoucherLine, accounts: Map<string, VoucherAccount>): VoucherAccount | undefined {
  return accounts.get(line.account_id.toLowerCase())
}

function label(account: VoucherAccount | undefined): string {
  return account ? `${account.code} ${account.name}` : "an unknown account"
}

function moneyLineCheck(
  type: "payment" | "receipt",
  lines: VoucherLine[],
  accounts: Map<string, VoucherAccount>,
): VoucherCheck {
  const money = lines
    .map((line) => ({ line, account: accountFor(line, accounts) }))
    .filter((entry) => isMoneyRole(voucherAccountRole(entry.account)))

  if (money.length === 0) {
    return {
      ok: false,
      error: `A ${type} voucher needs a cash or bank line. Add the account the money ${
        type === "payment" ? "left" : "arrived in"
      }.`,
    }
  }
  if (money.length > 1) {
    return {
      ok: false,
      error: `A ${type} voucher takes exactly one cash or bank line; use a contra voucher to move money between accounts.`,
    }
  }

  const moneyLine = money[0]!.line
  const wantsCredit = type === "payment"
  if (wantsCredit && moneyLine.credit <= 0) {
    return {
      ok: false,
      error: `A payment voucher moves money out, so ${label(money[0]!.account)} must be the credit line.`,
    }
  }
  if (!wantsCredit && moneyLine.debit <= 0) {
    return {
      ok: false,
      error: `A receipt voucher brings money in, so ${label(money[0]!.account)} must be the debit line.`,
    }
  }
  if (lines.length < 2) {
    return { ok: false, error: `A ${type} voucher needs at least one line against the cash or bank account.` }
  }
  return { ok: true }
}

function partyNoteCheck(
  type: "credit_note" | "debit_note",
  lines: VoucherLine[],
  accounts: Map<string, VoucherAccount>,
): VoucherCheck {
  const isCredit = type === "credit_note"
  const wanted: VoucherAccountRole = isCredit ? "receivable" : "payable"
  const party = lines
    .map((line) => ({ line, account: accountFor(line, accounts) }))
    .filter((entry) => voucherAccountRole(entry.account) === wanted)

  if (party.length === 0) {
    return {
      ok: false,
      error: isCredit
        ? "A credit note needs the customer's accounts receivable line so the customer's balance comes down."
        : "A debit note needs the supplier's accounts payable line so what we owe comes down.",
    }
  }
  if (party.length > 1) {
    return {
      ok: false,
      error: `A ${isCredit ? "credit" : "debit"} note settles one ${isCredit ? "customer" : "supplier"} at a time; post one per account.`,
    }
  }

  const partyLine = party[0]!.line
  if (isCredit && partyLine.credit <= 0) {
    return {
      ok: false,
      error: `A credit note reduces what the customer owes, so ${label(party[0]!.account)} must be the credit line.`,
    }
  }
  if (!isCredit && partyLine.debit <= 0) {
    return {
      ok: false,
      error: `A debit note reduces what we owe the supplier, so ${label(party[0]!.account)} must be the debit line.`,
    }
  }
  if (lines.length < 2) {
    return {
      ok: false,
      error: `A ${isCredit ? "credit" : "debit"} note needs the ${isCredit ? "sales or expense" : "purchase or expense"} line it reverses.`,
    }
  }
  return { ok: true }
}

function contraCheck(lines: VoucherLine[], accounts: Map<string, VoucherAccount>): VoucherCheck {
  const nonMoney = lines.filter((line) => !isMoneyRole(voucherAccountRole(accountFor(line, accounts))))
  if (nonMoney.length > 0) {
    const account = accountFor(nonMoney[0]!, accounts)
    return {
      ok: false,
      error: `A contra voucher only moves money between cash and bank accounts. ${label(account)} is neither; use a payment or receipt instead.`,
    }
  }
  const debits = lines.filter((line) => line.debit > 0).length
  const credits = lines.filter((line) => line.credit > 0).length
  if (debits === 0 || credits === 0) {
    return { ok: false, error: "A contra voucher needs a debit on the receiving account and a credit on the paying account." }
  }
  return { ok: true }
}

export function validateVoucher(
  type: VoucherType,
  lines: VoucherLine[],
  accounts: Map<string, VoucherAccount>,
): VoucherCheck {
  switch (type) {
    case "payment":
    case "receipt":
      return moneyLineCheck(type, lines, accounts)
    case "contra":
      return contraCheck(lines, accounts)
    case "credit_note":
    case "debit_note":
      return partyNoteCheck(type, lines, accounts)
    case "journal":
      return { ok: true }
  }
}
