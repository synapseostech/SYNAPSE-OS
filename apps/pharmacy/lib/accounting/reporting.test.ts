import { describe, expect, it } from "vitest"
import { summarizeCurrencies, type AccountBalance } from "./reporting"

function row(
  code: string,
  accountType: AccountBalance["account_type"],
  normalBalance: AccountBalance["normal_balance"],
  balance: number,
  currency = "UGX",
): AccountBalance {
  return {
    currency,
    account_id: code,
    code,
    name: code,
    account_type: accountType,
    normal_balance: normalBalance,
    debit: 0,
    credit: 0,
    balance,
  }
}

describe("summarizeCurrencies", () => {
  it("nets debit-balance sales discounts against revenue and balances earnings", () => {
    const rows = [
      row("4000", "income", "credit", 1000),
      row("4010", "income", "debit", 100),
      row("5000", "expense", "debit", 400),
      row("1000", "asset", "debit", 600),
      row("2000", "liability", "credit", 100),
      row("3000", "equity", "credit", 0),
    ]

    expect(summarizeCurrencies(rows, rows)).toEqual([
      {
        currency: "UGX",
        revenue: 900,
        expenses: 400,
        netIncome: 500,
        assets: 600,
        liabilities: 100,
        equity: 500,
        inputVat: 0,
        outputVat: 0,
      },
    ])
  })

  it("keeps balances in separate currencies", () => {
    const rows = [
      row("4000", "income", "credit", 100, "UGX"),
      row("4000", "income", "credit", 25, "USD"),
    ]

    expect(summarizeCurrencies(rows, rows).map(({ currency, revenue }) => [currency, revenue])).toEqual([
      ["UGX", 100],
      ["USD", 25],
    ])
  })
})
