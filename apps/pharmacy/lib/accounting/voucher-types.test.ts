import { describe, expect, it } from "vitest"
import {
  manualVoucherSourceId,
  validateVoucher,
  voucherAccountRole,
  voucherKindFromSource,
  type VoucherAccount,
} from "./voucher-types"

const CASH: VoucherAccount = { id: "cash", code: "1000", name: "Cash on hand", system_key: "CASH_ON_HAND" }
const BANK: VoucherAccount = { id: "bank", code: "1010", name: "Bank account", system_key: "BANK" }
const MOBILE: VoucherAccount = {
  id: "mobile",
  code: "1020",
  name: "Mobile money clearing",
  system_key: "MOBILE_MONEY_CLEARING",
}
const RECEIVABLE: VoucherAccount = {
  id: "ar",
  code: "1100",
  name: "Accounts receivable",
  system_key: "ACCOUNTS_RECEIVABLE",
}
const PAYABLE: VoucherAccount = {
  id: "ap",
  code: "2000",
  name: "Accounts payable",
  system_key: "ACCOUNTS_PAYABLE",
}
const SALES: VoucherAccount = { id: "sales", code: "4000", name: "Sales revenue", system_key: "SALES_REVENUE" }
const CUSTOM: VoucherAccount = { id: "custom", code: "T-1A2B3C4D", name: "Shop fittings", system_key: null }

const accounts = new Map(
  [CASH, BANK, MOBILE, RECEIVABLE, PAYABLE, SALES, CUSTOM].map((account) => [account.id, account]),
)

const line = (account_id: string, debit: number, credit: number) => ({ account_id, debit, credit })

describe("voucherAccountRole", () => {
  it("reads roles from the seeded system keys only", () => {
    expect(voucherAccountRole(CASH)).toBe("cash")
    expect(voucherAccountRole(BANK)).toBe("bank")
    expect(voucherAccountRole(MOBILE)).toBe("bank")
    expect(voucherAccountRole(RECEIVABLE)).toBe("receivable")
    expect(voucherAccountRole(PAYABLE)).toBe("payable")
    expect(voucherAccountRole(SALES)).toBe("other")
    expect(voucherAccountRole(CUSTOM)).toBe("other")
    expect(voucherAccountRole(undefined)).toBe("other")
  })
})

describe("validateVoucher", () => {
  it("accepts a payment out of the bank against an expense", () => {
    expect(
      validateVoucher("payment", [line("custom", 500, 0), line("bank", 0, 500)], accounts),
    ).toEqual({ ok: true })
  })

  it("refuses a payment whose bank line is on the debit side", () => {
    const result = validateVoucher("payment", [line("bank", 500, 0), line("custom", 0, 500)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/must be the credit line/)
  })

  it("refuses a payment with no cash or bank line", () => {
    const result = validateVoucher("payment", [line("custom", 500, 0), line("sales", 0, 500)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/needs a cash or bank line/)
  })

  it("refuses a payment using two money accounts", () => {
    const result = validateVoucher("payment", [line("cash", 500, 0), line("bank", 0, 500)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/contra voucher/)
  })

  it("accepts a receipt into mobile money", () => {
    expect(
      validateVoucher("receipt", [line("mobile", 900, 0), line("receivable", 0, 900)], accounts),
    ).toEqual({ ok: true })
  })

  it("refuses a receipt whose money line is credited", () => {
    const result = validateVoucher("receipt", [line("receivable", 900, 0), line("cash", 0, 900)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/must be the debit line/)
  })

  it("accepts a contra between cash and bank", () => {
    expect(
      validateVoucher("contra", [line("bank", 1000, 0), line("cash", 0, 1000)], accounts),
    ).toEqual({ ok: true })
  })

  it("refuses a contra touching an income account", () => {
    const result = validateVoucher("contra", [line("sales", 1000, 0), line("cash", 0, 1000)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/4000 Sales revenue is neither/)
  })

  it("accepts a credit note that credits the customer", () => {
    expect(
      validateVoucher("credit_note", [line("sales", 300, 0), line("ar", 0, 300)], accounts),
    ).toEqual({ ok: true })
  })

  it("refuses a credit note that debits the customer", () => {
    const result = validateVoucher("credit_note", [line("ar", 300, 0), line("sales", 0, 300)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/must be the credit line/)
  })

  it("accepts a debit note that debits the supplier", () => {
    expect(
      validateVoucher("debit_note", [line("ap", 700, 0), line("custom", 0, 700)], accounts),
    ).toEqual({ ok: true })
  })

  it("refuses a debit note with no supplier line", () => {
    const result = validateVoucher("debit_note", [line("custom", 700, 0), line("bank", 0, 700)], accounts)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/accounts payable line/)
  })

  it("leaves a plain journal to the balance check", () => {
    expect(validateVoucher("journal", [line("custom", 1, 0), line("sales", 0, 1)], accounts)).toEqual({
      ok: true,
    })
  })
})

describe("source ids", () => {
  it("keeps a journal's idempotency key untouched", () => {
    expect(manualVoucherSourceId("journal", "abc")).toBe("abc")
  })

  it("records the voucher type for typed vouchers", () => {
    expect(manualVoucherSourceId("receipt", "abc")).toBe("manual:receipt:abc")
  })

  it("reads a bare id back as a journal", () => {
    expect(voucherKindFromSource("manual", "abc")).toBe("journal")
  })

  it("reads typed vouchers and Tally history back", () => {
    expect(voucherKindFromSource("manual", "manual:contra:abc")).toBe("contra")
    expect(voucherKindFromSource("tally_receipt", "x")).toBe("receipt")
    expect(voucherKindFromSource("tally_sale", "x")).toBe("sales")
    expect(voucherKindFromSource("sale", "x")).toBe("sales")
    expect(voucherKindFromSource("sale_reversal", "x")).toBe("other")
  })
})
