/**
 * Column mapping for bank statement CSVs.
 *
 * The portal reads the file with PapaParse and the mobile API with the
 * workspace's RFC-4180 reader, so the readers differ but the interpretation —
 * which headers are accepted, how dates and amounts are read, which rows are
 * rejected — lives here and cannot drift between the two surfaces.
 */

export type BankStatementRow = {
  lineNumber: number
  date: string
  description: string
  reference: string | null
  amount: number
  currency: string
}

export type BankStatementRecord = {
  /** The source line, so a rejection names the row the user can find. */
  lineNumber: number
  values: string[]
}

function normalizedHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}

function findHeader(headers: string[], aliases: string[]): number | undefined {
  const normalizedAliases = new Set(aliases.map(normalizedHeader))
  const index = headers.findIndex((header) => normalizedAliases.has(normalizedHeader(header)))
  return index === -1 ? undefined : index
}

export function parseStatementDate(value: string): string | null {
  const trimmed = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const parsed = new Date(`${trimmed}T00:00:00.000Z`)
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === trimmed
      ? trimmed
      : null
  }

  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(trimmed)
  if (!match) return null
  const [, dayText, monthText, yearText] = match
  if (!dayText || !monthText || !yearText) return null
  const day = Number(dayText)
  const month = Number(monthText)
  const year = Number(yearText)
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return `${yearText}-${monthText.padStart(2, '0')}-${dayText.padStart(2, '0')}`
}

export function parseStatementAmount(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parenthesized = /^\(.*\)$/.test(trimmed)
  const numberText = parenthesized ? trimmed.slice(1, -1) : trimmed
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(numberText)) return null
  const numeric = Number(numberText.replace(/,/g, ''))
  if (!Number.isFinite(numeric)) return null
  return parenthesized ? -Math.abs(numeric) : numeric
}

/**
 * The only matches offered: same currency and same amount. The matching RPC
 * enforces this too; the UI filters with it so a line never offers a
 * candidate the server would reject.
 */
export function exactBankCandidates<C extends { currency: string; amount: number | string }>(
  line: { currency: string; amount: number | string },
  candidates: C[],
): C[] {
  return candidates.filter(
    (candidate) =>
      candidate.currency === line.currency && Number(candidate.amount) === Number(line.amount),
  )
}

/**
 * Map header-keyed records onto statement rows. Positive amounts are deposits,
 * negative amounts are withdrawals; separate Debit and Credit columns become a
 * signed amount. Every rejection names the source line.
 */
export function mapBankStatementRecords(
  header: string[],
  records: BankStatementRecord[],
  defaultCurrency: string,
): BankStatementRow[] {
  const dateIndex = findHeader(header, ['date', 'transaction date', 'booking date', 'value date'])
  const descriptionIndex = findHeader(header, [
    'description',
    'details',
    'narration',
    'memo',
    'transaction',
  ])
  const amountIndex = findHeader(header, ['amount', 'transaction amount', 'value'])
  const debitIndex = findHeader(header, ['debit', 'withdrawal', 'withdrawals'])
  const creditIndex = findHeader(header, ['credit', 'deposit', 'deposits'])
  const referenceIndex = findHeader(header, ['reference', 'ref', 'transaction reference'])
  const currencyIndex = findHeader(header, ['currency', 'ccy'])

  if (
    dateIndex === undefined ||
    descriptionIndex === undefined ||
    (amountIndex === undefined && !(debitIndex !== undefined && creditIndex !== undefined))
  ) {
    throw new Error(
      'CSV needs Date, Description and Amount columns (or separate Debit and Credit columns).',
    )
  }

  const currency = defaultCurrency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new Error('The pharmacy accounting currency is not valid.')
  }

  return records.map((record) => {
    const field = (index: number | undefined) => (index === undefined ? '' : record.values[index] ?? '')

    const date = parseStatementDate(field(dateIndex))
    const description = field(descriptionIndex).trim()
    let amount: number | null
    if (amountIndex !== undefined) {
      amount = parseStatementAmount(field(amountIndex))
    } else {
      const debitText = field(debitIndex)
      const creditText = field(creditIndex)
      const debit = parseStatementAmount(debitText)
      const credit = parseStatementAmount(creditText)
      if ((debitText.trim() && debit == null) || (creditText.trim() && credit == null)) {
        throw new Error(
          `CSV row ${record.lineNumber} has a non-numeric debit or credit amount.`,
        )
      }
      const debitAmount = debit ?? 0
      const creditAmount = credit ?? 0
      if (debitAmount < 0 || creditAmount < 0 || (debitAmount > 0 && creditAmount > 0)) {
        throw new Error(`CSV row ${record.lineNumber} must have a debit or a credit value, not both.`)
      }
      amount = creditAmount > 0 ? creditAmount : debitAmount > 0 ? -debitAmount : null
    }

    const rowCurrency =
      (currencyIndex !== undefined ? field(currencyIndex).trim().toUpperCase() : '') || currency
    if (
      !date ||
      !description ||
      amount == null ||
      amount === 0 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001
    ) {
      throw new Error(
        `CSV row ${record.lineNumber} has an invalid date, description, or non-zero amount (max 2 decimals).`,
      )
    }
    if (!/^[A-Z]{3}$/.test(rowCurrency)) {
      throw new Error(`CSV row ${record.lineNumber} has an invalid currency code.`)
    }

    return {
      lineNumber: record.lineNumber,
      date,
      description: description.slice(0, 500),
      reference: referenceIndex !== undefined ? field(referenceIndex).trim().slice(0, 200) || null : null,
      amount: Math.round(amount * 100) / 100,
      currency: rowCurrency,
    }
  })
}
