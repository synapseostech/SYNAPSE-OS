import { describe, expect, it } from "vitest"

import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import { simulateReplay } from "@synapse/db/tally-replay"
import { parseTallyXmlRows } from "@synapse/db/tally-xml-rows"

import {
  COLLIDING_BATCH,
  FULL_HISTORY_COMPANY,
  FULL_HISTORY_EXPECTATIONS,
  FULL_HISTORY_PERIOD,
  buildFullHistoryXml,
} from "./full-history-fixture"

const SYNTHETIC_BATCH = /^TALLY-RPL-[0-9A-F]{16}$/

function replay() {
  const document = parseTallyXmlRows(buildFullHistoryXml())
  return normaliseTallyDocument(document, {
    mode: "replay",
    conversionDate: FULL_HISTORY_PERIOD.from,
    cutoffDate: FULL_HISTORY_PERIOD.to,
    today: "2025-10-01",
  })
}

describe("synthetic full-history export", () => {
  it("parses as one company with every synthesised voucher", () => {
    const document = parseTallyXmlRows(buildFullHistoryXml())
    expect(document.company).toBe(FULL_HISTORY_COMPANY)
    expect(document.vouchers).toHaveLength(8)
    expect(document.vouchers.filter((voucher) => voucher.inventoryLines.length > 0)).toHaveLength(8)
  })

  it("replays every movement in date order without dropping one", () => {
    const plan = replay()
    const blocking = plan.exceptions.filter((exception) => exception.severity === "blocking")
    expect(blocking).toEqual([])

    const movements = plan.movements ?? []
    expect(movements).toHaveLength(FULL_HISTORY_EXPECTATIONS.length)

    expect(
      movements.map((movement) => ({
        date: movement.date,
        kind: movement.movementKind,
        item: movement.stockItemName,
        quantity: movement.quantityDelta,
        batch: movement.batchNumber,
        expiry: movement.expiryDate,
        allocation: movement.allocation,
      })),
    ).toEqual(
      FULL_HISTORY_EXPECTATIONS.map((expected) => ({
        date: expected.date,
        kind: expected.kind,
        item: expected.item,
        quantity: expected.quantity,
        batch: expected.syntheticBatch ? expect.stringMatching(SYNTHETIC_BATCH) : expected.batch,
        expiry: expected.expiry,
        allocation: expected.allocation,
      })),
    )
  })

  it("keeps Tally's own batch name on the earliest receipt and discloses the split", () => {
    const plan = replay()
    const inbound = (plan.movements ?? []).filter(
      (movement) => movement.movementKind === "purchase_in" && movement.stockItemName === COLLIDING_BATCH.item,
    )

    expect(inbound).toHaveLength(2)
    expect(inbound[0].batchNumber).toBe(COLLIDING_BATCH.name)
    expect(inbound[0].expiryDate).toBe(COLLIDING_BATCH.primaryExpiry)
    expect(inbound[1].batchNumber).toMatch(SYNTHETIC_BATCH)
    expect(inbound[1].expiryDate).toBe(COLLIDING_BATCH.laterExpiry)

    const disclosure = plan.exceptions.find((exception) => exception.code === "REPLAY_BATCH_IDENTITY_RECONSTRUCTED")
    expect(disclosure?.severity).toBe("warning")
    expect(plan.exceptions.some((exception) => exception.code === "BATCH_EXPIRY_CONFLICT")).toBe(false)
  })

  it("lets a sale that names only the shared batch name allocate first-expiry-first-out", () => {
    const plan = replay()
    const sale = (plan.movements ?? []).find(
      (movement) => movement.movementKind === "sale_out" && movement.stockItemName === COLLIDING_BATCH.item,
    )

    expect(sale?.batchNumber).toBeUndefined()
    expect(sale?.allocation).toBe("fefo")

    const named = (plan.movements ?? []).find(
      (movement) => movement.movementKind === "sale_out" && movement.stockItemName !== COLLIDING_BATCH.item,
    )
    expect(named?.batchNumber).toBe("PARA-2401")
    expect(named?.allocation).toBe("explicit")
  })

  it("records the historical cost of each replayed sale line from the batch that left", () => {
    const plan = replay()
    const simulation = simulateReplay(plan)
    const sales = (plan.movements ?? []).filter((movement) => movement.movementKind === "sale_out")

    expect(sales).toHaveLength(2)
    expect(
      sales.map((movement) => simulation.lineCosts[`${movement.sourceId}:L${movement.lineIndex}`]),
    ).toEqual([
      { amount: 15000, complete: true },
      { amount: 15000, complete: true },
    ])
  })

  it("carries both sides of a stock journal and the physical count", () => {
    const plan = replay()
    const movements = plan.movements ?? []

    const out = movements.find((movement) => movement.movementKind === "stock_journal_out")
    const inbound = movements.find((movement) => movement.movementKind === "stock_journal_in")
    expect(out?.quantityDelta).toBe(-10)
    expect(out?.batchNumber).toBe(COLLIDING_BATCH.name)
    expect(inbound?.quantityDelta).toBe(10)
    expect(inbound?.batchNumber).toBe("AMOX-REPACK")

    const count = movements.find((movement) => movement.movementKind === "physical_adjust")
    expect(count?.quantityDelta).toBe(120)
    expect(count?.batchNumber).toMatch(SYNTHETIC_BATCH)
  })
})
