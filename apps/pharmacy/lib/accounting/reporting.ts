export type AccountBalance = {
  currency: string
  account_id: string
  code: string
  name: string
  account_type: "asset" | "liability" | "equity" | "income" | "expense"
  normal_balance: "debit" | "credit"
  debit: number
  credit: number
  balance: number
}

export type CurrencySummary = {
  currency: string
  revenue: number
  expenses: number
  netIncome: number
  assets: number
  liabilities: number
  equity: number
  inputVat: number
  outputVat: number
}

export function summarizeCurrencies(
  trialBalance: AccountBalance[],
  periodActivity: AccountBalance[],
): CurrencySummary[] {
  const currencies = new Set([
    ...trialBalance.map((row) => row.currency),
    ...periodActivity.map((row) => row.currency),
  ])

  return Array.from(currencies).sort().map((currency) => {
    const balanceRows = trialBalance.filter((row) => row.currency === currency)
    const activityRows = periodActivity.filter((row) => row.currency === currency)
    const sumType = (rows: AccountBalance[], type: AccountBalance["account_type"]) =>
      rows.filter((row) => row.account_type === type).reduce((sum, row) => sum + Number(row.balance), 0)
    const revenue = activityRows
      .filter((row) => row.account_type === "income")
      .reduce((sum, row) => sum + Number(row.balance) * (row.normal_balance === "credit" ? 1 : -1), 0)
    const expenses = sumType(activityRows, "expense")
    const accumulatedEarnings = balanceRows
      .filter((row) => row.account_type === "income")
      .reduce((sum, row) => sum + Number(row.balance) * (row.normal_balance === "credit" ? 1 : -1), 0) -
      sumType(balanceRows, "expense")

    return {
      currency,
      revenue,
      expenses,
      netIncome: revenue - expenses,
      assets: sumType(balanceRows, "asset"),
      liabilities: sumType(balanceRows, "liability"),
      equity: sumType(balanceRows, "equity") + accumulatedEarnings,
      inputVat: activityRows.find((row) => row.code === "1300")?.balance ?? 0,
      outputVat: activityRows.find((row) => row.code === "2100")?.balance ?? 0,
    }
  })
}
