/**
 * Quick receive: scan a pack, type quantity, batch, expiry and cost, scan the
 * next. Pure helpers for the screen and its tests.
 */
import { parseCountInput, parseExpiryInput } from './stock-take'

export type QuickReceiveLine = {
  key: string
  productId: string
  productName: string
  batchNumber: string
  expiryDate: string
  quantity: number
  costPrice: number | null
}

export type QuickReceiveDraft = {
  quantity: string
  batchNumber: string
  expiry: string
  cost: string
}

export type DraftCheck =
  | { ok: true; quantity: number; batchNumber: string; expiryDate: string; costPrice: number | null }
  | { ok: false; field: keyof QuickReceiveDraft; message: string }

export function checkDraft(draft: QuickReceiveDraft, today: string): DraftCheck {
  const quantity = parseCountInput(draft.quantity)
  if (quantity === null || Number.isNaN(quantity) || quantity <= 0) {
    return { ok: false, field: 'quantity', message: 'Enter how many arrived (e.g. 10 or 3x20)' }
  }
  const batchNumber = draft.batchNumber.trim().replace(/\s+/g, ' ').toUpperCase()
  if (!batchNumber) return { ok: false, field: 'batchNumber', message: 'Enter the batch number on the pack' }
  if (batchNumber === 'NEG-STOCK') return { ok: false, field: 'batchNumber', message: 'Use the batch number on the pack' }
  const expiryDate = parseExpiryInput(draft.expiry)
  if (!expiryDate) return { ok: false, field: 'expiry', message: 'Expiry as MM/YY, e.g. 03/28' }
  if (expiryDate <= today) return { ok: false, field: 'expiry', message: 'This stock has already expired' }
  let costPrice: number | null = null
  if (draft.cost.trim()) {
    const cost = Number(draft.cost.replace(/,/g, ''))
    if (!Number.isFinite(cost) || cost < 0) return { ok: false, field: 'cost', message: 'Cost must be a number' }
    costPrice = cost
  }
  return { ok: true, quantity, batchNumber, expiryDate, costPrice }
}

export function lineKey(productId: string, batchNumber: string): string {
  return `${productId}|${batchNumber.trim().toUpperCase()}`
}

/** Scanning the same product and batch again adds to the line instead of duplicating it. */
export function addLine(lines: QuickReceiveLine[], line: Omit<QuickReceiveLine, 'key'>): QuickReceiveLine[] {
  const key = lineKey(line.productId, line.batchNumber)
  const existing = lines.find((l) => l.key === key)
  if (!existing) return [{ ...line, key }, ...lines]
  return lines.map((l) =>
    l.key === key
      ? {
          ...l,
          quantity: l.quantity + line.quantity,
          expiryDate: line.expiryDate,
          costPrice: line.costPrice ?? l.costPrice,
        }
      : l,
  )
}

export function receiveTotals(lines: QuickReceiveLine[]): { lines: number; units: number; cost: number } {
  return {
    lines: lines.length,
    units: lines.reduce((total, l) => total + l.quantity, 0),
    cost: lines.reduce((total, l) => total + l.quantity * (l.costPrice ?? 0), 0),
  }
}

export function toReceivingBody(lines: QuickReceiveLine[], supplierRef: string) {
  return {
    supplierRef: supplierRef.trim() || undefined,
    lines: lines.map((l) => ({
      productId: l.productId,
      batchNumber: l.batchNumber,
      quantity: l.quantity,
      expiryDate: l.expiryDate,
      costPrice: l.costPrice ?? undefined,
    })),
  }
}

/** Keep only the lines the server refused, so the receiver can fix and resend them. */
export function remainingAfterSubmit(
  lines: QuickReceiveLine[],
  results: Array<{ productId: string; ok: boolean; error?: string }>,
): Array<QuickReceiveLine & { error?: string }> {
  // The receiving route answers line by line, in order.
  return lines
    .map((line, index) => ({ line, result: results[index] }))
    .filter(({ result }) => !result?.ok)
    .map(({ line, result }) => ({ ...line, error: result?.error ?? 'Not received' }))
}
