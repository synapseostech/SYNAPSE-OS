import { describe, it } from "node:test"
import assert from "node:assert/strict"

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
} from "./tally-map.ts"
import type { TallyGroup, TallyLedger } from "./tally-xml-rows.ts"

function ledger(name: string, parent?: string, overrides: Partial<TallyLedger> = {}): TallyLedger {
  return {
    name,
    parent,
    isBillWise: false,
    bills: [],
    ...overrides,
  }
}

const groups: TallyGroup[] = [
  { name: "Current Assets", parent: "Assets" },
  { name: "Sundry Debtors", parent: "Current Assets" },
  { name: "Sundry Creditors", parent: "Current Liabilities" },
  { name: "Current Liabilities", parent: "Liabilities" },
  { name: "Kampala Retail Debtors", parent: "Sundry Debtors" },
  { name: "Cash-in-hand", parent: "Current Assets" },
]

describe("normaliseTallyKey", () => {
  it("removes case, diacritics, punctuation and spacing differences", () => {
    assert.equal(normaliseTallyKey("  Café  &  Co.  "), "CAFE AND CO")
    assert.equal(normaliseTallyKey("Cash-in-hand"), "CASH IN HAND")
    assert.equal(normaliseTallyKey("Sundry   Debtors"), "SUNDRY DEBTORS")
  })
})

describe("classifyTallyLedger", () => {
  it("classifies a custom ledger by walking up to a predefined Tally group", () => {
    const groupMap = new Map(groups.map((group) => [normaliseTallyKey(group.name), group]))
    const result = classifyTallyLedger(ledger("Test Customer A", "Kampala Retail Debtors"), groupMap)

    assert.deepEqual(result, {
      accountType: "asset",
      normalBalance: "debit",
      role: "receivable",
      systemKey: undefined,
      partyType: "customer",
      unclassified: false,
    })
  })

  it("classifies a supplier under a nested Sundry Creditors group", () => {
    const groupMap = new Map(groups.map((group) => [normaliseTallyKey(group.name), group]))
    const result = classifyTallyLedger(ledger("Test Supplier A", "Sundry Creditors"), groupMap)

    assert.equal(result.accountType, "liability")
    assert.equal(result.normalBalance, "credit")
    assert.equal(result.partyType, "supplier")
  })

  it("maps exact seeded ledger names to their system key and seeded type", () => {
    const groupMap = new Map(groups.map((group) => [normaliseTallyKey(group.name), group]))
    const result = classifyTallyLedger(ledger("Sales", "Sales Accounts"), groupMap)

    assert.equal(result.systemKey, "SALES_REVENUE")
    assert.equal(result.accountType, "income")
    assert.equal(result.normalBalance, "credit")
  })

  it("flags a ledger whose group chain is unknown and defaults it to a debit asset", () => {
    const groupMap = new Map(groups.map((group) => [normaliseTallyKey(group.name), group]))
    const result = classifyTallyLedger(ledger("Mystery Ledger", "Some Custom Group"), groupMap)

    assert.equal(result.unclassified, true)
    assert.equal(result.accountType, "asset")
    assert.equal(result.normalBalance, "debit")
    assert.equal(result.role, "other")
  })

  it("honours overrides, including removing system and party mapping", () => {
    const groupMap = new Map(groups.map((group) => [normaliseTallyKey(group.name), group]))
    const result = classifyTallyLedger(ledger("Sales", "Sales Accounts"), groupMap, {
      systemKey: null,
      partyType: null,
      accountType: "liability",
      normalBalance: "credit",
    })

    assert.equal(result.systemKey, undefined)
    assert.equal(result.partyType, undefined)
    assert.equal(result.accountType, "liability")
    assert.equal(result.normalBalance, "credit")
  })
})

describe("mapTallyLedgers", () => {
  it("assigns each seeded system code at most once and gives duplicates a custom code", () => {
    const mapped = mapTallyLedgers(
      [ledger("Cash", "Cash-in-hand", { guid: "g1" }), ledger("Cash", "Cash-in-hand", { guid: "g2" })],
      groups,
    )

    // Duplicate names are collapsed by normalised name, so use two distinct names that map to the same key.
    const duplicate = mapTallyLedgers(
      [ledger("Cash", "Cash-in-hand", { guid: "g1" }), ledger("Cash In Hand", "Cash-in-hand", { guid: "g2" })],
      groups,
    )

    assert.equal(mapped.length, 1)
    assert.equal(mapped[0].code, "1000")
    assert.deepEqual(
      duplicate.map((account) => account.code),
      ["1000", tallyAccountCode("g2", "Cash In Hand")],
    )
    assert.notEqual(duplicate[1].code, "1000")
  })

  it("generates deterministic custom codes from the GUID, or the name when absent", () => {
    const withGuid = mapTallyLedgers([ledger("Test Expense A", "Indirect Expenses", { guid: "abc" })], groups)
    const withoutGuid = mapTallyLedgers([ledger("Test Expense A", "Indirect Expenses")], groups)

    assert.equal(withGuid[0].code, tallyAccountCode("abc", "Test Expense A"))
    assert.equal(withoutGuid[0].code, tallyAccountCode(undefined, "Test Expense A"))
    assert.match(withGuid[0].code, /^T-[0-9A-F]{8}$/)
    assert.equal(withGuid[0].code, withGuid[0].code)
  })

  it("skips blank and duplicate ledger names", () => {
    const mapped = mapTallyLedgers(
      [ledger("Test Expense A", "Indirect Expenses"), ledger(" test expense a ", "Indirect Expenses"), ledger("  ")],
      groups,
    )
    assert.equal(mapped.length, 1)
  })

  it("applies a rename override without changing the source name used for matching", () => {
    const key = normaliseTallyKey("Test Expense A")
    const mapped = mapTallyLedgers([ledger("Test Expense A", "Indirect Expenses")], groups, {
      [key]: { name: "Renamed Expense" },
    })
    assert.equal(mapped[0].sourceName, "Test Expense A")
    assert.equal(mapped[0].name, "Renamed Expense")
  })
})

describe("voucher classification", () => {
  it("recognises Tally voucher types and their posting source types", () => {
    const cases: Array<[string, string, string | undefined]> = [
      ["Sales", "sales", "tally_sale"],
      ["Purchase", "purchase", "tally_purchase"],
      ["Receipt", "receipt", "tally_receipt"],
      ["Payment", "payment", "tally_payment"],
      ["Contra", "contra", "tally_contra"],
      ["Journal", "journal", "tally_journal"],
      ["Credit Note", "credit_note", "tally_credit_note"],
      ["Debit Note", "debit_note", "tally_debit_note"],
      ["Sales Order", "order", undefined],
      ["Stock Journal", "stock_journal", undefined],
      ["Delivery Note", "inventory_note", undefined],
      ["Attendance", "other", undefined],
    ]

    for (const [raw, kind, sourceType] of cases) {
      assert.equal(classifyTallyVoucherType(raw), kind, raw)
      assert.equal(tallyVoucherSourceType(kind as never), sourceType, raw)
    }
  })

  it("does not mistake a credit note for a sale", () => {
    assert.equal(classifyTallyVoucherType("Credit Note"), "credit_note")
    assert.equal(classifyTallyVoucherType("Debit Note"), "debit_note")
  })
})

describe("payment roles", () => {
  it("maps only settled cash and bank roles to a POS payment method", () => {
    assert.equal(paymentMethodForRole("cash"), "CASH")
    assert.equal(paymentMethodForRole("bank"), "BANK_TRANSFER")
    assert.equal(paymentMethodForRole("mobile_money"), "MOBILE_MONEY")
    assert.equal(paymentMethodForRole("card"), "CARD")
    assert.equal(paymentMethodForRole("overdraft"), "BANK_TRANSFER")
    assert.equal(paymentMethodForRole("receivable"), undefined)
    assert.equal(isCashOrBankRole("cash"), true)
    assert.equal(isCashOrBankRole("receivable"), false)
  })
})

describe("stableHash", () => {
  it("is stable and differs for different inputs", () => {
    assert.equal(stableHash("same"), stableHash("same"))
    assert.notEqual(stableHash("same"), stableHash("different"))
    assert.match(stableHash("same"), /^[0-9a-f]{8}$/)
  })
})
