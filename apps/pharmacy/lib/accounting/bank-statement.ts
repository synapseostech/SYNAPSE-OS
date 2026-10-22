import Papa from "papaparse"

export type BankStatementRow = {
  lineNumber: number
  date: string
  description: string
  reference: string | null
  amount: number
  currency: string
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")
}

function findHeader(headers: string[], aliases: string[]): string | undefined {
  const normalizedAliases = new Set(aliases.map(normalizedHeader))
  return headers.find((header) => normalizedAliases.has(normalizedHeader(header)))
}

function parseDate(value: string): string | null {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === trimmed ? trimmed : null
  }

  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed)
  if (!match) return null
  const [, dayText, monthText, yearText] = match
  const day = Number(dayText)
  const month = Number(monthText)
  const year = Number(yearText)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${yearText}-${monthText.padStart(2, "0")}-${dayText.padStart(2, "0")}`
}

function parseAmount(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parenthesized = /^\(.*\)$/.test(trimmed)
  const numberText = parenthesized ? trimmed.slice(1, -1) : trimmed
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(numberText)) return null
  const numeric = Number(numberText.replace(/,/g, ""))
  if (!Number.isFinite(numeric)) return null
  return parenthesized ? -Math.abs(numeric) : numeric
}

export function parseBankStatementCsv(csv: string, defaultCurrency: string): BankStatementRow[] {
  const parsed = Papa.parse<Record<string, string>>(csv, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
  })
  if (parsed.errors.length > 0) {
    throw new Error(`CSV could not be parsed: ${parsed.errors[0].message}`)
  }

  const headers = parsed.meta.fields ?? []
  const dateHeader = findHeader(headers, ["date", "transaction date", "booking date", "value date"])
  const descriptionHeader = findHeader(headers, ["description", "details", "narration", "memo", "transaction"])
  const amountHeader = findHeader(headers, ["amount", "transaction amount", "value"])
  const debitHeader = findHeader(headers, ["debit", "withdrawal", "withdrawals"])
  const creditHeader = findHeader(headers, ["credit", "deposit", "deposits"])
  const referenceHeader = findHeader(headers, ["reference", "ref", "transaction reference"])
  const currencyHeader = findHeader(headers, ["currency", "ccy"])

  if (!dateHeader || !descriptionHeader || (!amountHeader && !(debitHeader && creditHeader))) {
    throw new Error("CSV needs Date, Description and Amount columns (or separate Debit and Credit columns).")
  }

  const currency = defaultCurrency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error("The pharmacy accounting currency is not valid.")
  }

  return parsed.data.map((row, index) => {
    const date = parseDate(row[dateHeader] ?? "")
    const description = (row[descriptionHeader] ?? "").trim()
    let amount: number | null
    if (amountHeader) {
      amount = parseAmount(row[amountHeader] ?? "")
    } else {
      const debitText = row[debitHeader!] ?? ""
      const creditText = row[creditHeader!] ?? ""
      const debit = parseAmount(debitText)
      const credit = parseAmount(creditText)
      if ((debitText.trim() && debit == null) || (creditText.trim() && credit == null)) {
        throw new Error(`CSV row ${index + 2} has a non-numeric debit or credit amount.`)
      }
      const debitAmount = debit ?? 0
      const creditAmount = credit ?? 0
      if (debitAmount < 0 || creditAmount < 0 || (debitAmount > 0 && creditAmount > 0)) {
        throw new Error(`CSV row ${index + 2} must have a debit or a credit value, not both.`)
      }
      amount = creditAmount > 0 ? creditAmount : debitAmount > 0 ? -debitAmount : null
    }

    const rowCurrency = (currencyHeader ? row[currencyHeader]?.trim().toUpperCase() : "") || currency
    if (!date || !description || amount == null || amount === 0 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      throw new Error(`CSV row ${index + 2} has an invalid date, description, or non-zero amount (max 2 decimals).`)
    }
    if (!/^[A-Z]{3}$/.test(rowCurrency)) {
      throw new Error(`CSV row ${index + 2} has an invalid currency code.`)
    }

    return {
      lineNumber: index + 2,
      date,
      description: description.slice(0, 500),
      reference: referenceHeader ? (row[referenceHeader]?.trim().slice(0, 200) || null) : null,
      amount: Math.round(amount * 100) / 100,
      currency: rowCurrency,
    }
  })
}
