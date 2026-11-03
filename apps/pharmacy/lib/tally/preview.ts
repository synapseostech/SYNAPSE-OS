/**
 * The review payload a prepared plan returns.
 *
 * Preview and the chunked extraction both stage a plan, and both hand the
 * operator the same tables to review, so the shape is built in one place. Only
 * the first `PREVIEW_LIMIT` of each list is sent; the totals say how many were
 * staged, so a truncated table never reads as a short one.
 */

import type { TallyCutoverPlan } from "@synapse/db/tally-normalise"

export const PREVIEW_LIMIT = 200

export function buildTallyPreview(plan: TallyCutoverPlan) {
  return {
    accounts: plan.accounts.slice(0, PREVIEW_LIMIT).map((account) => ({
      code: account.code,
      name: account.name,
      sourceName: account.sourceName,
      accountType: account.accountType,
      normalBalance: account.normalBalance,
      role: account.role,
      systemKey: account.systemKey,
      partyType: account.partyType,
      openingBalance: account.openingBalance,
      openingSide: account.openingSide,
      openingMethod: account.openingMethod,
      unclassified: account.unclassified,
    })),
    accountTotal: plan.accounts.length,
    parties: plan.parties.slice(0, PREVIEW_LIMIT).map((party) => ({
      kind: party.kind,
      name: party.name,
      accountCode: party.accountCode,
      openingBalance: party.openingBalance,
      billCount: party.bills.length,
      nextDueDate: party.bills.map((bill) => bill.dueDate).filter(Boolean).sort()[0],
    })),
    partyTotal: plan.parties.length,
    stockItems: plan.stockItems.slice(0, PREVIEW_LIMIT).map((item) => ({
      sku: item.sku,
      name: item.name,
      quantity: item.quantity,
      unit: item.unit,
      openingValue: item.value,
      closingValue: item.closingValue,
      batchCount: item.batches.length,
      receivableBatches: item.batches.filter((batch) => batch.receivable).length,
      expiredBatches: item.batches.filter(
        (batch) => Boolean(batch.expiryDate) && !batch.receivable,
      ).length,
    })),
    stockItemTotal: plan.stockItems.length,
    vouchers: plan.vouchers.slice(0, PREVIEW_LIMIT).map((voucher) => ({
      sourceId: voucher.sourceId,
      kind: voucher.kind,
      date: voucher.date,
      number: voucher.number,
      partyName: voucher.partyName,
      total: voucher.lines.reduce((sum, line) => sum + line.debit, 0),
    })),
    voucherTotal: plan.vouchers.length,
    salesTotal: plan.sales.length,
    purchasesTotal: plan.purchases.length,
  }
}
