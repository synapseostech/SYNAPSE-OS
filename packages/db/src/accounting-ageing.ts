/**
 * Ageing for receivables and payables.
 *
 * The ledger stores no invoice-to-payment link, so a repayment cannot be tied
 * to the invoice it settled. Applying repayments oldest-first is the common
 * small-ledger convention and is stated in the UI; it is an estimate, not a
 * claim about which invoice the customer meant to settle.
 */

export const AGEING_BUCKETS = [
  { id: "current", label: "Not due" },
  { id: "d1_30", label: "1–30 days" },
  { id: "d31_60", label: "31–60 days" },
  { id: "d61_90", label: "61–90 days" },
  { id: "d90_plus", label: "Over 90 days" },
] as const

export type AgeingBucketId = (typeof AGEING_BUCKETS)[number]["id"]

export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00.000Z`)
  const to = Date.parse(`${toIso}T00:00:00.000Z`)
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.round((to - from) / 86_400_000)
}

export function ageingBucket(daysOverdue: number): AgeingBucketId {
  if (daysOverdue <= 0) return "current"
  if (daysOverdue <= 30) return "d1_30"
  if (daysOverdue <= 60) return "d31_60"
  if (daysOverdue <= 90) return "d61_90"
  return "d90_plus"
}

export type OpenInvoice = {
  id: string
  amount: number
  /** Defaults to the invoice date when the ledger carries no due date. */
  dueDate: string
}

export type SettledInvoice = OpenInvoice & { outstanding: number }

/**
 * Allocates settled amounts to invoices oldest first and returns each
 * invoice's remaining balance. Invoices with nothing left are dropped.
 */
export function applySettlements(
  invoices: OpenInvoice[],
  settledTotal: number,
): SettledInvoice[] {
  let remainingSettlement = Math.round(Math.max(0, settledTotal) * 100)
  const ordered = [...invoices].sort((a, b) => (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0))
  const result: SettledInvoice[] = []

  for (const invoice of ordered) {
    const cents = Math.round(invoice.amount * 100)
    if (cents <= 0) continue
    const applied = Math.min(cents, remainingSettlement)
    remainingSettlement -= applied
    const outstanding = (cents - applied) / 100
    if (outstanding > 0) result.push({ ...invoice, outstanding })
  }

  return result
}

export type AgeingRow = {
  partyName: string
  reference: string
  date: string
  dueDate: string | null
  amount: number
  daysOverdue: number
  bucket: AgeingBucketId
}

export type AgeingSummary = {
  buckets: Record<AgeingBucketId, number>
  total: number
  rows: AgeingRow[]
}

export function summariseAgeing(
  rows: Array<Omit<AgeingRow, "bucket" | "daysOverdue"> & { dueDate: string; asOf: string }>,
): AgeingSummary {
  const buckets = Object.fromEntries(AGEING_BUCKETS.map((bucket) => [bucket.id, 0])) as Record<
    AgeingBucketId,
    number
  >
  let total = 0

  const aged: AgeingRow[] = rows.map((row) => {
    const daysOverdue = daysBetween(row.dueDate, row.asOf)
    const bucket = ageingBucket(daysOverdue)
    const amount = Math.round(row.amount * 100) / 100
    buckets[bucket] = Math.round((buckets[bucket] + amount) * 100) / 100
    total = Math.round((total + amount) * 100) / 100
    return {
      partyName: row.partyName,
      reference: row.reference,
      date: row.date,
      dueDate: row.dueDate,
      amount,
      daysOverdue,
      bucket,
    }
  })

  return { buckets, total, rows: aged.sort((a, b) => b.daysOverdue - a.daysOverdue) }
}
