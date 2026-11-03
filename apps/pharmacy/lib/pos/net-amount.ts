/**
 * What `pharmacy_transactions.net_amount` means, stated once.
 *
 * A legacy order transaction is described by three columns:
 *
 *   total_amount  sum of line totals, before discount and before tax
 *   discount      what was taken off that sum
 *   tax           tax charged on the discounted base
 *
 * `net_amount` is the fourth: what the customer owes and pays, which is
 * `total_amount - discount + tax`. It is tax-inclusive by definition; the
 * tax-exclusive figure is `total_amount - discount`.
 *
 * The column has not always meant this. `lib/tally/apply.ts` wrote the
 * pre-tax total into it, while the edit route wrote the tax-inclusive one, so
 * a row's meaning depended on which writer produced it. Readers cannot tell
 * which writer a historical row came from, which is why `app/api/admin/reports`
 * derives its revenue basis from `total_amount - discount` instead of trusting
 * this column, and must keep doing so.
 *
 * New writes go through `netAmountFor` so the two cannot drift apart again.
 * Existing rows are left exactly as they are — reinterpreting them in place
 * would rewrite sales that have already been reported on.
 */
import { roundMoney } from "@synapse/db/pos-tax"

export type SaleAmounts = {
  /** Sum of line totals, before discount and before tax. */
  totalAmount: number
  discount: number
  tax: number
}

/** What the customer owes for the sale, rounded the way reports round money. */
export function netAmountFor({ totalAmount, discount, tax }: SaleAmounts): number {
  return roundMoney(Number(totalAmount || 0) - Number(discount || 0) + Number(tax || 0))
}

/**
 * The tax-exclusive sales basis. Readers use this rather than `net_amount`,
 * because a historical row may carry either meaning.
 */
export function taxExclusiveBasis({ totalAmount, discount }: Pick<SaleAmounts, "totalAmount" | "discount">): number {
  return roundMoney(Number(totalAmount || 0) - Number(discount || 0))
}
