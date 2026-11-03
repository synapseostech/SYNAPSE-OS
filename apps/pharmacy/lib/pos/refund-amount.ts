/**
 * How much money to hand back for a legacy `pharmacy_transactions` refund.
 *
 * The header columns are what the customer actually paid:
 * `total_amount - discount + tax`. Line prices are tax- and
 * discount-exclusive, so summing them alone under-refunds a taxed sale and,
 * worse, over-refunds a discounted one — the customer receives more cash than
 * they ever handed over.
 */
import { roundMoney } from "./partial-payment"

export type RefundLine = { id: string; quantity: number; unit_price: number }
export type RefundRequest = { id: string; quantity: number }

/**
 * Refund for the requested lines. A request covering every line returns the
 * header figure exactly; a partial request receives its proportional share of
 * the paid amount, so the parts can never exceed what was paid.
 */
export function allocateRefundAmount(params: {
  lines: readonly RefundLine[]
  refunded: readonly RefundRequest[]
  discount?: number | null
  tax?: number | null
}): number {
  const discount = Math.max(0, Number(params.discount) || 0)
  const tax = Math.max(0, Number(params.tax) || 0)

  const quantities = params.lines.map((line) => Math.max(0, Number(line.quantity) || 0))
  const lineValues = params.lines.map((line, index) =>
    Math.max(0, roundMoney(quantities[index]! * (Number(line.unit_price) || 0))),
  )
  const base = roundMoney(lineValues.reduce((sum, value) => sum + value, 0))
  if (base <= 0) return 0

  const paid = Math.max(0, roundMoney(base - discount + tax))

  const refundedBase = params.refunded.reduce((sum, request) => {
    const index = params.lines.findIndex((line) => line.id === request.id)
    if (index < 0) return sum
    const qty = Math.min(Math.max(0, Number(request.quantity) || 0), quantities[index]!)
    if (qty <= 0 || quantities[index] === 0) return sum
    return sum + (lineValues[index]! / quantities[index]!) * qty
  }, 0)

  if (refundedBase <= 0) return 0
  // Every line requested: return the header figure, not a rounded share of it.
  if (refundedBase >= base - 0.005) return paid
  return Math.min(paid, roundMoney((paid * refundedBase) / base))
}
