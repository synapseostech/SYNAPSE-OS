import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  buildReplayEvents,
  reconcileReplay,
  simulateReplay,
  type TallyReplaySimulation,
} from "./tally-replay.ts"
import type {
  TallyCutoverMovement,
  TallyCutoverPlan,
  TallyCutoverStockItem,
  TallyCutoverVoucher,
} from "./tally-normalise.ts"

function basePlan(overrides: Partial<TallyCutoverPlan> = {}): TallyCutoverPlan {
  return {
    company: "Test Pharmacy",
    companyKey: "test-pharmacy",
    currency: "UGX",
    conversionDate: "2026-04-01",
    cutoffDate: "2026-04-30",
    ordering: "date-then-export-order",
    mode: "replay",
    accounts: [],
    parties: [],
    stockItems: [],
    stock: {
      openingValue: null,
      closingValue: null,
      itemsWithOpeningValue: 0,
      itemsWithClosingValue: 0,
      itemCount: 0,
    },
    opening: {
      date: "2026-04-01",
      currency: "UGX",
      lines: [],
      totalDebit: 0,
      totalCredit: 0,
      difference: 0,
    },
    vouchers: [],
    sales: [],
    purchases: [],
    movements: [],
    exceptions: [],
    counts: {
      ledgers: 0,
      groups: 0,
      stockItems: 0,
      vouchers: 0,
      postedVouchers: 0,
      skippedVouchers: 0,
      sales: 0,
      purchases: 0,
      openingLines: 0,
    },
    warnings: [],
    ...overrides,
  }
}

function stockItem(overrides: Partial<TallyCutoverStockItem> = {}): TallyCutoverStockItem {
  return {
    sourceName: "Paracetamol 500mg",
    sku: "PARA-500",
    name: "Paracetamol 500mg",
    unit: "Strip",
    batches: [],
    ...overrides,
  }
}

let movementCounter = 0
function movement(overrides: Partial<TallyCutoverMovement> = {}): TallyCutoverMovement {
  movementCounter += 1
  return {
    movementId: `v1:L0:B${movementCounter}`,
    sourceId: "v1",
    kind: "purchase",
    movementKind: "purchase_in",
    date: "2026-04-02",
    sourceOrder: 0,
    lineIndex: 0,
    batchIndex: movementCounter,
    stockItemName: "Paracetamol 500mg",
    quantityDelta: 10,
    batchNumber: `B-${movementCounter}`,
    expiryDate: "2027-12-31",
    rate: 100,
    amount: 1000,
    allocation: "explicit",
    ...overrides,
  }
}

function voucher(sourceId: string, date: string, overrides: Partial<TallyCutoverVoucher> = {}): TallyCutoverVoucher {
  return {
    sourceId,
    sourceType: "Voucher",
    kind: "journal",
    date,
    description: sourceId,
    currency: "UGX",
    lines: [],
    ...overrides,
  }
}

function itemState(simulation: TallyReplaySimulation, name: string) {
  return simulation.state.items.find((item) => item.stockItemName === name)
}

describe("buildReplayEvents", () => {
  it("puts opening first and orders the rest by date, then export order", () => {
    const plan = basePlan({
      vouchers: [voucher("later", "2026-04-10"), voucher("same-day-first", "2026-04-05"), voucher("earlier", "2026-04-02")],
      movements: [
        movement({ sourceId: "later", date: "2026-04-10", sourceOrder: 0 }),
        movement({ sourceId: "movement-only", date: "2026-04-03", sourceOrder: 2 }),
      ],
    })

    const events = buildReplayEvents(plan)

    assert.deepEqual(
      events.map((event) => event.eventId),
      ["opening", "earlier", "movement-only", "same-day-first", "later"],
    )
    assert.equal(events[0]?.type, "opening")
  })

  it("keeps same-day vouchers in the order the export carried them", () => {
    const plan = basePlan({
      vouchers: [
        voucher("first", "2026-04-05"),
        voucher("second", "2026-04-05"),
        voucher("third", "2026-04-05"),
      ],
    })

    assert.deepEqual(
      buildReplayEvents(plan).slice(1).map((event) => event.eventId),
      ["first", "second", "third"],
    )
  })

  it("carries opening stock as the first movements", () => {
    const plan = basePlan({
      stockItems: [
        stockItem({
          quantity: 12,
          value: 1200,
          batches: [
            { batchName: "B-001", expiryDate: "2027-02-28", quantity: 12, receivable: true },
            { batchName: "B-000", expiryDate: "2025-01-01", quantity: 4, receivable: false },
          ],
        }),
      ],
    })

    const [opening] = buildReplayEvents(plan)
    assert.equal(opening?.movements.length, 1)
    assert.equal(opening?.movements[0]?.quantityDelta, 12)
    assert.equal(opening?.movements[0]?.amount, 1200)
    assert.equal(opening?.movements[0]?.movementKind, "opening")
  })
})

describe("simulateReplay", () => {
  it("adds stock in and takes it out, tracking batches", () => {
    const plan = basePlan({
      vouchers: [voucher("buy", "2026-04-02"), voucher("sell", "2026-04-03")],
      movements: [
        movement({ sourceId: "buy", date: "2026-04-02", sourceOrder: 0, quantityDelta: 10 }),
        movement({
          sourceId: "sell",
          date: "2026-04-03",
          sourceOrder: 1,
          kind: "sales",
          movementKind: "sale_out",
          quantityDelta: -4,
          batchNumber: undefined,
          allocation: "fefo",
          rate: 150,
          amount: 600,
        }),
      ],
    })

    const simulation = simulateReplay(plan)
    const item = itemState(simulation, "Paracetamol 500mg")

    assert.equal(item?.quantity, 6)
    assert.equal(simulation.findings.length, 0)
  })

  it("records what the stock a sale removed cost, at the batch's own value", () => {
    const plan = basePlan({
      movements: [
        movement({
          sourceId: "buy",
          date: "2026-04-02",
          batchNumber: "B-COST",
          expiryDate: "2027-01-01",
          quantityDelta: 10,
          rate: 120,
          amount: 1200,
        }),
        movement({
          movementId: "sell:L0:B0",
          sourceId: "sell",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-03",
          batchNumber: "B-COST",
          quantityDelta: -4,
          rate: 300,
          amount: 1200,
        }),
      ],
    })

    const simulation = simulateReplay(plan)

    assert.deepEqual(simulation.lineCosts["sell:L0"], { amount: 480, complete: true })
  })

  it("leaves a sale line uncosted when part of it had no stock to come from", () => {
    const plan = basePlan({
      movements: [
        movement({
          sourceId: "buy",
          date: "2026-04-02",
          batchNumber: "B-SHORT",
          expiryDate: "2027-01-01",
          quantityDelta: 2,
          rate: 100,
          amount: 200,
        }),
        movement({
          movementId: "sell:L0:B0",
          sourceId: "sell",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-03",
          batchNumber: "B-SHORT",
          quantityDelta: -5,
          rate: 300,
          amount: 1500,
        }),
      ],
    })

    const simulation = simulateReplay(plan, { allowNegativeStock: true })

    // The two units that did come off the batch cost 200; the rest never
    // existed, so the line carries no quotable cost at all.
    assert.deepEqual(simulation.lineCosts["sell:L0"], { amount: 200, complete: false })
  })

  it("satisfies an unnamed sale from the soonest-expiring batch received by then", () => {
    const plan = basePlan({
      movements: [
        movement({
          movementId: "in-late-expiry",
          date: "2026-04-02",
          batchNumber: "B-LATE",
          expiryDate: "2028-01-01",
          quantityDelta: 5,
        }),
        movement({
          movementId: "in-soon-expiry",
          date: "2026-04-02",
          batchNumber: "B-SOON",
          expiryDate: "2026-07-01",
          quantityDelta: 5,
        }),
        movement({
          movementId: "sale",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-03",
          batchNumber: undefined,
          allocation: "fefo",
          quantityDelta: -3,
          amount: 300,
        }),
      ],
    })

    const item = itemState(simulateReplay(plan), "Paracetamol 500mg")
    const soon = item?.batches.find((batch) => batch.batchNumber === "B-SOON")
    const late = item?.batches.find((batch) => batch.batchNumber === "B-LATE")

    assert.equal(soon?.quantity, 2)
    assert.equal(late?.quantity, 5)
  })

  it("does not sell an expired batch while a live one is on hand", () => {
    const plan = basePlan({
      movements: [
        movement({
          movementId: "in-expired",
          date: "2026-04-02",
          batchNumber: "B-OLD",
          expiryDate: "2026-04-10",
          quantityDelta: 5,
        }),
        movement({
          movementId: "in-live",
          date: "2026-04-02",
          batchNumber: "B-NEW",
          expiryDate: "2027-04-10",
          quantityDelta: 5,
        }),
        movement({
          movementId: "sale",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-20",
          batchNumber: undefined,
          allocation: "fefo",
          quantityDelta: -3,
          amount: 300,
        }),
      ],
    })

    const simulation = simulateReplay(plan)
    const item = itemState(simulation, "Paracetamol 500mg")

    assert.equal(item?.batches.find((batch) => batch.batchNumber === "B-NEW")?.quantity, 2)
    assert.equal(item?.batches.find((batch) => batch.batchNumber === "B-OLD")?.quantity, 5)
    assert.equal(simulation.findings.length, 0)
  })

  it("says so when the only stock left is expired", () => {
    const plan = basePlan({
      movements: [
        movement({
          movementId: "in-expired",
          date: "2026-04-02",
          batchNumber: "B-OLD",
          expiryDate: "2026-04-10",
          quantityDelta: 5,
        }),
        movement({
          movementId: "sale",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-20",
          batchNumber: undefined,
          allocation: "fefo",
          quantityDelta: -2,
          amount: 200,
        }),
      ],
    })

    const simulation = simulateReplay(plan)

    assert.deepEqual(
      simulation.findings.map((finding) => finding.code),
      ["REPLAY_EXPIRED_BATCH_CONSUMED"],
    )
    assert.equal(simulation.findings[0]?.severity, "warning")
    assert.equal(simulation.findings[0]?.date, "2026-04-20")
  })

  it("blocks a sale larger than the stock on hand", () => {
    const plan = basePlan({
      movements: [
        movement({ date: "2026-04-02", quantityDelta: 2 }),
        movement({
          movementId: "sale",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-03",
          batchNumber: undefined,
          allocation: "fefo",
          quantityDelta: -5,
          amount: 500,
        }),
      ],
    })

    const simulation = simulateReplay(plan)

    assert.equal(itemState(simulation, "Paracetamol 500mg")?.quantity, -3)
    assert.deepEqual(
      simulation.findings.map((finding) => [finding.code, finding.severity]),
      [["REPLAY_NEGATIVE_STOCK", "blocking"]],
    )
    assert.equal(simulation.findings[0]?.movementId, "sale")
  })

  it("downgrades negative stock to a warning only when the session allows it", () => {
    const plan = basePlan({
      movements: [
        movement({
          movementId: "sale",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-03",
          batchNumber: undefined,
          allocation: "fefo",
          quantityDelta: -2,
          amount: 200,
        }),
      ],
    })

    assert.equal(simulateReplay(plan).findings[0]?.severity, "blocking")
    assert.equal(
      simulateReplay(plan, { allowNegativeStock: true }).findings[0]?.severity,
      "warning",
    )
  })

  it("takes a named batch instead of another, and says when that batch is unknown", () => {
    const plan = basePlan({
      movements: [
        movement({
          movementId: "in-a",
          date: "2026-04-02",
          batchNumber: "B-A",
          expiryDate: "2026-06-01",
          quantityDelta: 5,
        }),
        movement({
          movementId: "in-b",
          date: "2026-04-02",
          batchNumber: "B-B",
          expiryDate: "2028-06-01",
          quantityDelta: 5,
        }),
        movement({
          movementId: "sale-named",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-03",
          batchNumber: "B-B",
          allocation: "explicit",
          quantityDelta: -2,
          amount: 200,
        }),
        movement({
          movementId: "sale-unknown",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-04",
          batchNumber: "B-MISSING",
          allocation: "explicit",
          quantityDelta: -1,
          amount: 100,
        }),
      ],
    })

    const simulation = simulateReplay(plan)
    const item = itemState(simulation, "Paracetamol 500mg")

    // The unnamed-batch line falls back to FEFO, which takes from B-A first.
    assert.equal(item?.batches.find((batch) => batch.batchNumber === "B-A")?.quantity, 4)
    assert.equal(item?.batches.find((batch) => batch.batchNumber === "B-B")?.quantity, 3)
    assert.equal(item?.quantity, 7)
    assert.deepEqual(
      simulation.findings.map((finding) => finding.code),
      ["REPLAY_UNKNOWN_BATCH_FOR_OUT"],
    )
  })

  it("applies a physical count as a delta to the quantity at that point", () => {
    const plan = basePlan({
      movements: [
        movement({ date: "2026-04-02", quantityDelta: 10 }),
        movement({
          movementId: "count",
          kind: "stock_journal",
          movementKind: "physical_adjust",
          date: "2026-04-05",
          batchNumber: "B-1",
          quantityDelta: 7,
          rate: 100,
          amount: 700,
        }),
      ],
    })

    assert.equal(itemState(simulateReplay(plan), "Paracetamol 500mg")?.quantity, 7)
  })

  it("posts ledger lines to account balances", () => {
    const plan = basePlan({
      vouchers: [
        voucher("sale", "2026-04-03", {
          kind: "sales",
          lines: [
            { accountCode: "1000", accountName: "Cash", debit: 1_500, credit: 0 },
            { accountCode: "4000", accountName: "Sales", debit: 0, credit: 1_500 },
          ],
        }),
      ],
      accounts: [
        {
          sourceName: "Cash",
          code: "1000",
          name: "Cash",
          accountType: "asset",
          normalBalance: "debit",
          role: "cash",
          unclassified: false,
          openingBalance: 1_000,
          openingSide: "debit",
          openingMethod: "exported",
          closingBalance: 2_500,
        },
        {
          sourceName: "Sales",
          code: "4000",
          name: "Sales",
          accountType: "income",
          normalBalance: "credit",
          role: "sales",
          unclassified: false,
          openingBalance: 0,
          openingSide: "none",
          openingMethod: "exported",
          closingBalance: -1_500,
        },
      ],
      opening: {
        date: "2026-04-01",
        currency: "UGX",
        lines: [
          { accountCode: "1000", accountName: "Cash", debit: 1_000, credit: 0 },
          { accountCode: "3000", accountName: "Capital", debit: 0, credit: 1_000 },
        ],
        totalDebit: 1_000,
        totalCredit: 1_000,
        difference: 0,
      },
    })

    const simulation = simulateReplay(plan)

    assert.equal(simulation.state.accounts["1000"], 2_500)
    assert.equal(simulation.state.accounts["4000"], -1_500)

    const reconciliation = reconcileReplay(simulation, plan)
    const accounts = new Map(
      reconciliation.rows
        .filter((row) => row.scope === "account")
        .map((row) => [row.key, row.status]),
    )

    assert.equal(reconciliation.blocking, 0)
    assert.equal(accounts.get("1000 Cash"), "match")
    assert.equal(accounts.get("4000 Sales"), "match")
    // No exported closing figure for Capital, so it is never called a match.
    assert.equal(
      reconciliation.rows.find((row) => row.key.startsWith("3000"))?.status,
      "not-available",
    )
  })
})

describe("reconcileReplay", () => {
  it("compares each item's closing quantity and value with Tally's", () => {
    const plan = basePlan({
      stockItems: [
        stockItem({ closingQuantity: 6, closingValue: 600 }),
        stockItem({ sourceName: "Amoxicillin", sku: "AMOX", name: "Amoxicillin", closingQuantity: 3, closingValue: 300 }),
      ],
      movements: [
        movement({ stockItemName: "Paracetamol 500mg", date: "2026-04-02", quantityDelta: 6, amount: 600 }),
        movement({ stockItemName: "Amoxicillin", date: "2026-04-02", quantityDelta: 2, amount: 200 }),
      ],
      stock: {
        openingValue: null,
        closingValue: 900,
        itemsWithOpeningValue: 0,
        itemsWithClosingValue: 2,
        itemCount: 2,
      },
    })

    const reconciliation = reconcileReplay(simulateReplay(plan), plan)
    const rows = new Map(reconciliation.rows.map((row) => [row.key, row]))

    assert.equal(rows.get("Paracetamol 500mg")?.status, "match")
    assert.equal(rows.get("Amoxicillin")?.status, "difference")
    assert.equal(rows.get("Amoxicillin")?.difference, -1)
    assert.equal(rows.get("stock value")?.status, "difference")
    assert.equal(rows.get("stock value")?.difference, -100)
    // Amoxicillin's quantity and value differ, and so does the stock total.
    assert.equal(reconciliation.blocking, 3)
  })

  it("reports a figure the export does not carry as not-available, never as a pass", () => {
    const plan = basePlan({
      stockItems: [stockItem({ closingQuantity: undefined, closingValue: undefined })],
      movements: [movement({ date: "2026-04-02", quantityDelta: 6, amount: 600 })],
    })

    const reconciliation = reconcileReplay(simulateReplay(plan), plan)
    const quantity = reconciliation.rows.find((row) => row.key === "Paracetamol 500mg")
    const value = reconciliation.rows.find((row) => row.key === "Paracetamol 500mg (value)")
    const total = reconciliation.rows.find((row) => row.key === "stock value")

    assert.equal(quantity?.status, "not-available")
    assert.equal(quantity?.expected, null)
    assert.equal(value, undefined)
    assert.equal(total?.status, "not-available")
    assert.equal(reconciliation.blocking, 0)
  })

  it("names the sequence a blocking stock finding happened at", () => {
    const plan = basePlan({
      stockItems: [stockItem({ closingQuantity: 1 })],
      movements: [
        movement({
          movementId: "sale",
          sourceId: "sale",
          kind: "sales",
          movementKind: "sale_out",
          date: "2026-04-09",
          batchNumber: undefined,
          allocation: "fefo",
          quantityDelta: -1,
          amount: 100,
        }),
      ],
    })

    const row = reconcileReplay(simulateReplay(plan), plan).rows.find(
      (entry) => entry.key === "Paracetamol 500mg",
    )

    assert.equal(row?.status, "difference")
    assert.deepEqual(row?.firstDivergence, {
      date: "2026-04-09",
      sourceId: "sale",
      movementId: "sale",
    })
  })
})
