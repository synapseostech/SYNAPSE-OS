/** FEFO cart allocation helpers — pure, client-safe. */

export type BatchLike = {
  id: string
  batchNumber: string
  quantity: number
  expiryDate: string | null
  manufacturer?: string | null
  costPrice?: number | null
  sellingPrice?: number | null
}

export type BatchAllocation = {
  batchId: string
  batchNumber: string
  expiryDate: string | null
  manufacturer: string | null
  quantity: number
  costPrice: number | null
  sellingPrice: number | null
}

export type ExpiryTone = "ok" | "warn" | "critical" | "expired" | "unknown"

/** Kampala calendar date YYYY-MM-DD */
export function kampalaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

export function daysUntilExpiry(expiryDate: string | null, today = kampalaToday()): number | null {
  if (!expiryDate) return null
  const exp = expiryDate.slice(0, 10)
  const t0 = Date.parse(`${today}T00:00:00Z`)
  const t1 = Date.parse(`${exp}T00:00:00Z`)
  if (Number.isNaN(t0) || Number.isNaN(t1)) return null
  return Math.round((t1 - t0) / 86_400_000)
}

/** green >180d, amber 90–180d, red <90d (and expired). */
export function expiryTone(expiryDate: string | null, today = kampalaToday()): ExpiryTone {
  const days = daysUntilExpiry(expiryDate, today)
  if (days == null) return "unknown"
  if (days < 0) return "expired"
  if (days < 90) return "critical"
  if (days <= 180) return "warn"
  return "ok"
}

export function expiryBadgeClass(tone: ExpiryTone): string {
  switch (tone) {
    case "ok":
      return "text-[#1FA6A6]"
    case "warn":
      return "text-[#E8B84B]"
    case "critical":
    case "expired":
      return "text-[#F97316]"
    default:
      return "text-muted-foreground"
  }
}

export function expiryToneLabel(tone: ExpiryTone): string {
  switch (tone) {
    case "ok":
      return "In date"
    case "warn":
      return "Expires within 180 days"
    case "critical":
      return "Expires within 90 days"
    case "expired":
      return "Expired"
    default:
      return "Expiry unknown"
  }
}

/**
 * Allocate `qtyNeeded` base units across FEFO batches (earliest expiry first).
 * Skips expired / empty batches. May return partial allocation if stock is short.
 */
export function allocateFefoBatches(
  batches: BatchLike[],
  qtyNeeded: number,
  today = kampalaToday(),
): BatchAllocation[] {
  if (qtyNeeded <= 0) return []
  const sorted = [...batches]
    .filter((b) => b.quantity > 0)
    .filter((b) => {
      const days = daysUntilExpiry(b.expiryDate, today)
      return days == null || days >= 0
    })
    .sort((a, b) => {
      const ae = a.expiryDate ?? "9999-12-31"
      const be = b.expiryDate ?? "9999-12-31"
      return ae.localeCompare(be)
    })

  let remaining = qtyNeeded
  const out: BatchAllocation[] = []
  for (const b of sorted) {
    if (remaining <= 0) break
    const take = Math.min(b.quantity, remaining)
    if (take <= 0) continue
    out.push({
      batchId: b.id,
      batchNumber: b.batchNumber,
      expiryDate: b.expiryDate,
      manufacturer: b.manufacturer ?? null,
      quantity: take,
      costPrice: b.costPrice ?? null,
      sellingPrice: b.sellingPrice ?? null,
    })
    remaining -= take
  }
  return out
}

export const DISCOUNT_REASONS = [
  { value: "damaged_pack", label: "Damaged pack" },
  { value: "loyalty", label: "Loyalty" },
  { value: "staff", label: "Staff" },
  { value: "doctor_referral", label: "Doctor referral" },
  { value: "other", label: "Other" },
] as const

export type DiscountReasonValue = (typeof DISCOUNT_REASONS)[number]["value"]
