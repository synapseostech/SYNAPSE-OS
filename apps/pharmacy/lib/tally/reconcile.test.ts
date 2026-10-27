import { describe, expect, it } from "vitest"
import type { TallyCutoverPlan } from "@synapse/db/tally-normalise"
import { TALLY_SYSTEM_ACCOUNT_CODES } from "@synapse/db/tally-map"
import { reconcileTallyPlan } from "./reconcile"
import type { TallyApplyCounts } from "./apply"

const INVENTORY = TALLY_SYSTEM_ACCOUNT_CODES.INVENTORY

const counts: TallyApplyCounts = {
  accounts: 4,
  parties: 0,
  products: 2,
  openingJournal: 1,
  openingStock: 1,
  journals: 3,
  sales: 1,
  purchases: 1,
}

function plan(overrides: Partial<TallyCutoverPlan> = {}): TallyCutoverPlan {
  return {
    companyKey: "test",
    currency: "UGX",
    conversionDate: "2026-04-01",
    accounts: [],
    parties: [],
    stockItems: [
      {
        name: "Test Item A",
        sku: "T1",
        unit: "unit",
        value: 500,
        batches: [
          { batchName: "B-1", expiryDate: "2027-01-01", quantity: 5, receivable: true },
          { batchName: "B-2", expiryDate: "2020-01-01", quantity: 5, receivable: false },
        ],
      },
    ] as unknown as TallyCutoverPlan["stockItems"],
    opening: {
      date: "2026-04-01",
      totalDebit: 1000,
      totalCredit: 1000,
      difference: 0,
      lines: [
        { accountCode: INVENTORY, accountName: "Inventory", debit: 500, credit: 0 },
      ],
    } as unknown as TallyCutoverPlan["opening"],
    vouchers: [],
    sales: [],
    purchases: [],
    exceptions: [],
    counts: {
      ledgers: 4,
      groups: 2,
      stockItems: 1,
      vouchers: 3,
      postedVouchers: 3,
      skippedVouchers: 0,
      sales: 1,
      purchases: 1,
      openingLines: 1,
    },
    warnings: [],
    ...overrides,
  }
}

const byId = (checks: ReturnType<typeof reconcileTallyPlan>) =>
  Object.fromEntries(checks.map((entry) => [entry.id, entry]))

describe("reconcileTallyPlan", () => {
  it("reports every comparable check as OK when the run matched the plan", () => {
    const checks = byId(reconcileTallyPlan(plan(), counts))
    expect(checks["opening-balance"]!.status).toBe("ok")
    expect(checks["opening-stock-value"]!.status).toBe("ok")
    expect(checks.journals!.status).toBe("ok")
    expect(checks.sales!.status).toBe("ok")
    expect(checks.purchases!.status).toBe("ok")
    // One receivable batch in the fixture, one stock receipt counted.
    expect(checks["opening-stock"]!.status).toBe("ok")
  })

  it("shows a missing voucher as a difference without adjusting anything", () => {
    const checks = byId(reconcileTallyPlan(plan(), { ...counts, journals: 2 }))
    expect(checks.journals).toMatchObject({ status: "difference", difference: -1 })
  })

  it("shows the reporting mirror falling short of the plan", () => {
    const checks = byId(reconcileTallyPlan(plan(), { ...counts, sales: 0, purchases: 3 }))
    expect(checks.sales).toMatchObject({ status: "difference", difference: -1 })
    expect(checks.purchases).toMatchObject({ status: "difference", difference: 2 })
  })

  it("reports an opening journal that does not balance", () => {
    const checks = byId(
      reconcileTallyPlan(
        plan({
          opening: {
            date: "2026-04-01",
            totalDebit: 1000,
            totalCredit: 900,
            difference: 100,
            lines: [],
          } as unknown as TallyCutoverPlan["opening"],
        }),
        counts,
      ),
    )
    // Debit minus credit: the journal overstates its debit side by 100.
    expect(checks["opening-balance"]).toMatchObject({ status: "difference", difference: 100 })
  })

  it("compares opening stock value against the inventory ledger line", () => {
    const checks = byId(
      reconcileTallyPlan(plan(), { ...counts, openingStock: 0 }),
    )
    expect(checks["opening-stock-value"]!.status).toBe("ok")
    expect(checks["opening-stock"]).toMatchObject({ status: "difference", difference: -1 })
  })

  it("marks cost of goods as unavailable instead of inventing it", () => {
    const checks = byId(reconcileTallyPlan(plan(), counts))
    expect(checks["cost-of-goods"]).toMatchObject({
      status: "not-available",
      expected: null,
      actual: null,
      difference: null,
    })
  })
})
