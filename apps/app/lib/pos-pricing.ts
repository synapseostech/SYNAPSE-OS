/**
 * Cart-discount allocation for the mobile till.
 *
 * The phone shows one discount field for the whole cart, but the sale route and
 * `complete_pharmacy_sale` tax each line separately. Putting the whole discount
 * on the first line — what this screen used to do — changes the taxable base
 * whenever the cart mixes `standard` with `exempt` or `zero_rated` products: a
 * discount on an exempt line pays no VAT, the same discount on a standard line
 * does. Allocating it in proportion to each line's value makes the VAT the
 * customer is quoted independent of cart order.
 *
 * Money rounds to two decimals and the rounding remainder lands on the last
 * line that can absorb it, so the allocation always sums exactly to the
 * discount. No imports: this file must load under both Metro and `node --test`.
 */

/** Money rounds half away from zero at 2dp, matching `@synapse/db/pos-tax`. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Split `discount` across `lineNets` in proportion to their value.
 *
 * Returns one amount per line, each no larger than that line's net. A discount
 * at or above the cart total is clamped to it, so no line goes negative. When
 * every line is zero, or the discount is zero, the result is all zeros.
 */
export function allocateCartDiscount(lineNets: readonly number[], discount: number): number[] {
  const nets = lineNets.map((net) => {
    const value = Number(net)
    return Number.isFinite(value) && value > 0 ? roundMoney(value) : 0
  })
  const base = roundMoney(nets.reduce((sum, net) => sum + net, 0))
  const wanted = Math.min(Math.max(0, roundMoney(Number(discount) || 0)), base)
  if (wanted <= 0 || base <= 0) return nets.map(() => 0)

  const allocated = nets.map((net) => roundMoney((net * wanted) / base))
  let remainder = roundMoney(wanted - roundMoney(allocated.reduce((sum, value) => sum + value, 0)))

  // Rounding can leave a cent either way. Sweep it onto the last lines with
  // room; `wanted <= base` guarantees the room exists.
  for (let i = allocated.length - 1; i >= 0 && remainder !== 0; i -= 1) {
    if (remainder > 0) {
      const add = Math.min(roundMoney(nets[i]! - allocated[i]!), remainder)
      allocated[i] = roundMoney(allocated[i]! + add)
      remainder = roundMoney(remainder - add)
    } else {
      const take = Math.min(allocated[i]!, -remainder)
      allocated[i] = roundMoney(allocated[i]! - take)
      remainder = roundMoney(remainder + take)
    }
  }

  return allocated
}
