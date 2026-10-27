/**
 * Post-import reconciliation.
 *
 * Reconciles the reviewed plan against what the apply run actually wrote. It
 * only reports differences: no adjusting entry, no stock correction, no silent
 * plug. A pharmacy decides what to do with a difference.
 */

import type { TallyCutoverPlan } from "@synapse/db/tally-normalise"
import { TALLY_SYSTEM_ACCOUNT_CODES } from "@synapse/db/tally-map"
import type { TallyApplyCounts } from "./apply"

export type TallyReconcileCheck = {
  id: string
  label: string
  expected: number | null
  actual: number | null
  difference: number | null
  status: "ok" | "difference" | "not-available"
  note?: string
}

function check(
  id: string,
  label: string,
  expected: number | null,
  actual: number | null,
  note?: string,
): TallyReconcileCheck {
  if (expected === null || actual === null) {
    return { id, label, expected, actual, difference: null, status: "not-available", note }
  }
  const difference = Math.round((actual - expected + Number.EPSILON) * 100) / 100
  return {
    id,
    label,
    expected,
    actual,
    difference,
    status: difference === 0 ? "ok" : "difference",
    note,
  }
}

function countableBatches(plan: TallyCutoverPlan): number {
  return plan.stockItems.reduce(
    (total, item) => total + item.batches.filter((batch) => batch.receivable).length,
    0,
  )
}

export function reconcileTallyPlan(
  plan: TallyCutoverPlan,
  counts: TallyApplyCounts,
): TallyReconcileCheck[] {
  const inventoryCode = TALLY_SYSTEM_ACCOUNT_CODES.INVENTORY
  const inventoryOpening = plan.opening.lines
    .filter((line) => line.accountCode === inventoryCode)
    .reduce((total, line) => total + line.debit - line.credit, 0)
  const stockOpeningValue = plan.stockItems.reduce(
    (total, item) => total + (item.value ?? 0),
    0,
  )

  return [
    check(
      "opening-balance",
      "Opening journal debit against credit",
      plan.opening.totalCredit,
      plan.opening.totalDebit,
      "A difference means the export was not balanced and the opening journal was not posted.",
    ),
    check(
      "opening-stock-value",
      "Opening stock value against the inventory ledger line",
      inventoryOpening,
      stockOpeningValue,
      "Tally keeps stock value and ledger value apart; a difference is reported, never adjusted.",
    ),
    // Counts, not arrays: reconcile also runs against the static plan, which
    // carries no voucher rows.
    check("journals", "Vouchers posted to the ledger", plan.counts.postedVouchers, counts.journals),
    check("sales", "Sales mirrored for reports", plan.counts.sales, counts.sales),
    check("purchases", "Purchases mirrored for reports", plan.counts.purchases, counts.purchases),
    check("opening-stock", "Opening batches received", countableBatches(plan), counts.openingStock),
    check(
      "cost-of-goods",
      "Cost of goods sold",
      null,
      null,
      "Tally's stock summary is not part of the export, so historical margin stays unknown until the pharmacy supplies it.",
    ),
  ]
}
