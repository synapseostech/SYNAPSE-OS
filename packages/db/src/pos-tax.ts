/**
 * Authoritative pharmacy sale tax.
 *
 * The POS reads its tax settings from `pharmacy_settings` and the per-product
 * VAT category from `pharmacy_products.vat_category`; this module is the one
 * place both the web POS and the mobile sale route compute tax, so the till,
 * the database row and the reports cannot disagree.
 *
 * Two configurations are supported, in priority order:
 *
 *  1. VAT on (`vat_enabled`): the rate is `vat_rate`, and only lines whose
 *     product is `standard` are taxed. `exempt` and `zero_rated` lines are not.
 *     The column defaults to `exempt`, so a product nobody has classified pays
 *     nothing rather than being assumed taxable.
 *  2. Legacy flat rate (`tax_rate`): one rate on the whole discounted base.
 *     This is what the POS has always done, kept so an existing tenant's totals
 *     do not move when this module lands.
 *
 * Nothing here invents a rate: with no settings row, or VAT off and no legacy
 * rate, the tax is zero. An out-of-range rate is reported as invalid
 * configuration instead of being silently coerced, because a till that quietly
 * charges the wrong tax is worse than one that refuses the sale.
 */

export type VatCategory = "standard" | "exempt" | "zero_rated"

export interface PharmacyTaxSettings {
  vatEnabled?: boolean | null
  vatRate?: number | string | null
  taxRate?: number | string | null
}

export interface TaxableLine {
  /** Line total after discount, before tax. */
  netAmount: number
  /** `pharmacy_products.vat_category`; unknown values are treated as exempt. */
  vatCategory?: string | null
}

export type TaxSource = "vat" | "legacy" | "none"

/**
 * One sale line's tax, in the shape persisted on `pharmacy_pos_sale_items`.
 *
 * Tax is rounded per line and the sale total is the sum of the lines. That is
 * the rule `complete_pharmacy_sale` implements, so the till, the row and the
 * receipt cannot disagree: rounding a whole-sale base instead would leave the
 * header a cent away from the lines that make it up.
 */
export interface LineTax {
  netAmount: number
  vatCategory: VatCategory
  /** Percentage charged on this line; 0 when it is not taxable. */
  ratePct: number
  /** The part of `netAmount` the rate applies to. */
  taxableAmount: number
  taxAmount: number
}

export interface ComputedSaleTax {
  ok: true
  source: TaxSource
  /** Percentage, e.g. 18 for 18%. */
  ratePct: number
  /** The part of the sale the rate was applied to. */
  taxableBase: number
  taxAmount: number
  /** Per-line breakdown, in the order the lines were supplied. */
  lines: LineTax[]
}

export interface InvalidTaxConfiguration {
  ok: false
  code: "INVALID_TAX_CONFIGURATION"
  field: "vat_rate" | "tax_rate"
  detail: string
}

export type SaleTaxComputation = ComputedSaleTax | InvalidTaxConfiguration

/** Money rounds half away from zero at 2dp, which is how the reports total it. */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round((value + Number.EPSILON) * 100) / 100
}

function asRate(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const rate = Number(value)
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) return null
  return rate
}

function normaliseCategory(value: unknown): VatCategory {
  return value === "standard" || value === "zero_rated" ? value : "exempt"
}

export function computePharmacySaleTax(
  settings: PharmacyTaxSettings | null | undefined,
  lines: readonly TaxableLine[],
): SaleTaxComputation {
  const netOf = (line: TaxableLine) => {
    const net = Number(line?.netAmount ?? 0)
    return Number.isFinite(net) && net > 0 ? net : 0
  }

  if (settings?.vatEnabled === true) {
    const rate = asRate(settings.vatRate)
    if (rate === null) {
      return {
        ok: false,
        code: "INVALID_TAX_CONFIGURATION",
        field: "vat_rate",
        detail: "VAT is enabled but vat_rate is missing or outside 0–100.",
      }
    }
    const computed = lines.map((line): LineTax => {
      const category = normaliseCategory(line?.vatCategory)
      const net = roundMoney(netOf(line))
      const taxable = category === "standard" ? net : 0
      return {
        netAmount: net,
        vatCategory: category,
        ratePct: category === "standard" ? rate : 0,
        taxableAmount: taxable,
        taxAmount: roundMoney((taxable * rate) / 100),
      }
    })
    return {
      ok: true,
      source: "vat",
      ratePct: rate,
      taxableBase: roundMoney(computed.reduce((sum, l) => sum + l.taxableAmount, 0)),
      taxAmount: roundMoney(computed.reduce((sum, l) => sum + l.taxAmount, 0)),
      lines: computed,
    }
  }

  const legacyRaw = settings?.taxRate
  const legacyRate = asRate(legacyRaw)
  if (legacyRate === null) {
    if (legacyRaw !== null && legacyRaw !== undefined && legacyRaw !== "") {
      return {
        ok: false,
        code: "INVALID_TAX_CONFIGURATION",
        field: "tax_rate",
        detail: "tax_rate is outside 0–100.",
      }
    }
    return { ok: true, source: "none", ratePct: 0, taxableBase: 0, taxAmount: 0, lines: untaxedLines(lines) }
  }
  if (legacyRate === 0) {
    return { ok: true, source: "none", ratePct: 0, taxableBase: 0, taxAmount: 0, lines: untaxedLines(lines) }
  }
  const computed = lines.map((line): LineTax => {
    const net = roundMoney(netOf(line))
    return {
      netAmount: net,
      vatCategory: normaliseCategory(line?.vatCategory),
      ratePct: legacyRate,
      taxableAmount: net,
      taxAmount: roundMoney((net * legacyRate) / 100),
    }
  })
  return {
    ok: true,
    source: "legacy",
    ratePct: legacyRate,
    taxableBase: roundMoney(computed.reduce((sum, l) => sum + l.taxableAmount, 0)),
    taxAmount: roundMoney(computed.reduce((sum, l) => sum + l.taxAmount, 0)),
    lines: computed,
  }
}

/**
 * Lines for a sale with no tax configured. The category is still recorded, so
 * a later rate change does not rewrite what an untaxed sale was made of.
 */
export function untaxedLines(lines: readonly TaxableLine[]): LineTax[] {
  return lines.map((line) => {
    const net = roundMoney(Number(line?.netAmount ?? 0) || 0)
    return {
      netAmount: net,
      vatCategory: normaliseCategory(line?.vatCategory),
      ratePct: 0,
      taxableAmount: 0,
      taxAmount: 0,
    }
  })
}

/**
 * A client-supplied tax is accepted only when it agrees with the server
 * computation. The 0.01 window absorbs floating-point drift, not a real
 * difference: one cent in UGX is already below what the receipt can show.
 */
export function taxAmountMatches(clientValue: unknown, expected: number, tolerance = 0.01): boolean {
  const supplied = Number(clientValue)
  if (!Number.isFinite(supplied)) return false
  return Math.abs(supplied - expected) < tolerance
}
