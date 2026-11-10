import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { readTallyArchive } from "@synapse/db/tally-archive"
import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import { consolidateTallyParts } from "./consolidate"

/**
 * Runs against the customer's own package, not a fixture. Set
 * SADIO_TALLY_ARCHIVE to the ZIP path to execute it; without it the suite is
 * skipped so an ordinary test run never depends on a file outside the repo.
 */
const archivePath = process.env.SADIO_TALLY_ARCHIVE
const suite = archivePath ? describe : describe.skip

const PERIOD = { from: "2025-10-01", to: "2026-10-31" }
const TODAY = "2026-11-09"

let cached: ReturnType<typeof readArchive> | undefined

function readArchive() {
  if (cached) return cached
  const bytes = new Uint8Array(readFileSync(archivePath!))
  const parts: Parameters<typeof consolidateTallyParts>[0] = []
  cached = readTallyArchive(bytes, {
    onDocument: (document) => parts.push(document),
  }).then((report) => ({ report, parts, sha256: createHash("sha256").update(bytes).digest("hex") }))
  return cached
}

suite("the SADIO PHARMACY archive", () => {
  it("verifies every declared file and voucher against the manifest", { timeout: 180_000 }, async () => {
    const { report, sha256 } = await readArchive()

    expect(sha256).toBe("0ece85f2a4d8b81ef280330e175a5d85561377b8cf0a164a5318478f71675a34")
    expect(report.reconciliation).toEqual({
      status: "verified",
      manifestVouchers: 26_064,
      parsedVouchers: 26_064,
      controlCharactersStripped: 285_850,
      manifestFiles: 13,
      exportFiles: 13,
      unmatchedManifestRows: [],
      missingFiles: [],
      undeclaredFiles: [],
      problems: [],
    })
    expect(report.company).toEqual({ name: "SADIO PHARMACY", source: "EXPORT_SUMMARY.txt" })
    expect(report.ignored).toEqual([])
    expect(report.totalBytes).toBe(237_445_945)
    expect(report.files).toHaveLength(15)

    const exports = report.files.filter((file) => file.role === "export")
    expect(exports.map((file) => file.vouchers)).toEqual([
      508, 1_660, 1_634, 1_903, 1_678, 2_176, 2_289, 2_192, 2_483, 2_513, 2_367, 2_281, 2_380,
    ])
    expect(exports.map((file) => file.inventoryLines)).toEqual([
      908, 3_207, 3_052, 3_790, 3_297, 3_728, 4_108, 3_840, 4_408, 4_594, 3_992, 3_642, 4_161,
    ])
    expect(exports.reduce((sum, file) => sum + file.batchAllocations!, 0)).toBe(46_727)
    expect(exports.flatMap((file) => file.discrepancies)).toEqual([])
  })

  it("accounts for every voucher and stock line exactly once", { timeout: 180_000 }, async () => {
    const { parts, report } = await readArchive()
    const { document } = consolidateTallyParts(parts, { period: PERIOD, company: "SADIO PHARMACY" })
    const plan = normaliseTallyDocument(document, {
      mode: "replay",
      conversionDate: PERIOD.from,
      today: TODAY,
    })

    expect(plan.counts).toEqual({
      ledgers: 0,
      groups: 0,
      stockItems: 0,
      vouchers: report.reconciliation.parsedVouchers,
      postedVouchers: 25_609,
      skippedVouchers: 0,
      sales: 24_288,
      purchases: 1_319,
      openingLines: 0,
    })
    expect(plan.ordering).toBe("date-then-export-order")

    const movements = plan.movements ?? []
    const byKind = movements.reduce<Record<string, number>>((counts, movement) => {
      counts[movement.movementKind] = (counts[movement.movementKind] ?? 0) + 1
      return counts
    }, {})
    expect(byKind).toEqual({ sale_out: 40_547, physical_adjust: 1_646 })

    const exceptions = plan.exceptionCounts ?? {}
    expect(exceptions).toEqual({
      ENTERED_BY_NOT_MAPPED: 1,
      COST_CENTRE_NOT_MAPPED: 1,
      LEDGER_MISSING: 1,
      LEDGER_INFERRED: 30,
      REPLAY_MOVEMENT_EXPIRY_MISSING: 4_529,
      REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER: 1,
      REPLAY_MOVEMENT_WITHOUT_QUANTITY: 5,
      COST_UNKNOWN: 1,
      PARTY_INFERRED: 1_319,
      STOCK_LINE_WITHOUT_QUANTITY: 3,
    })

    // The three arithmetic identities the report relies on.
    const inventoryLines = report.files
      .filter((file) => file.role === "export")
      .reduce((sum, file) => sum + (file.inventoryLines ?? 0), 0)
    expect(movements.length + 4_529 + 5).toBe(inventoryLines)
    expect(plan.sales.length).toBe(24_288)
  })

  it("imports every receipt without an expiry when the operator states the export has none", { timeout: 180_000 }, async () => {
    const { parts, report } = await readArchive()
    const { document } = consolidateTallyParts(parts, { period: PERIOD, company: "SADIO PHARMACY" })
    const plan = normaliseTallyDocument(document, {
      mode: "replay",
      conversionDate: PERIOD.from,
      today: TODAY,
      batchExpiry: "not-supplied",
    })

    expect(plan.batchExpiry).toBe("not-supplied")
    // Accepting the absent expiry removes that blocker only. The five
    // quantity-less lines still block, because no policy can supply a quantity.
    const blocking = plan.exceptions.filter((entry) => entry.severity === "blocking")
    expect(blocking).toHaveLength(5)
    expect(blocking.every((entry) => entry.code === "REPLAY_MOVEMENT_WITHOUT_QUANTITY")).toBe(true)
    expect(
      plan.exceptions.some((entry) => entry.code === "REPLAY_MOVEMENT_EXPIRY_MISSING"),
    ).toBe(false)

    // Purchases and stock journals are the receipts that carry a batch; a
    // physical adjustment is a count, so it never needed an expiry.
    const receipts = (plan.movements ?? []).filter(
      (movement) =>
        (movement.movementKind === "purchase_in" ||
          movement.movementKind === "stock_journal_in") &&
        movement.expiryDate === undefined,
    )
    expect(receipts).toHaveLength(4_529)
    expect(receipts.filter((movement) => movement.movementKind === "purchase_in")).toHaveLength(
      4_526,
    )
    // The batch name Tally states is kept on every receipt; only the date is absent.
    expect(receipts.every((movement) => Boolean(movement.batchNumber))).toBe(true)
    expect(receipts.some((movement) => movement.batchNumber === "Primary Batch")).toBe(true)

    const inventoryLines = report.files
      .filter((file) => file.role === "export")
      .reduce((sum, file) => sum + (file.inventoryLines ?? 0), 0)
    expect((plan.movements ?? []).length).toBe(inventoryLines - 5)

    const aggregate = plan.exceptions.filter(
      (entry) => entry.code === "REPLAY_BATCH_EXPIRY_NOT_SUPPLIED",
    )
    expect(aggregate).toHaveLength(1)
    expect(aggregate[0]?.severity).toBe("warning")
    expect(aggregate[0]?.message).toMatch(/^4,529 stock receipts across 1,387 products/)
  })

  it("discloses the attribution the export carries but Synapse cannot store", { timeout: 180_000 }, async () => {
    const { parts } = await readArchive()
    const { document } = consolidateTallyParts(parts, { period: PERIOD, company: "SADIO PHARMACY" })
    const plan = normaliseTallyDocument(document, {
      mode: "replay",
      conversionDate: PERIOD.from,
      today: TODAY,
    })

    const enteredBy = plan.exceptions.find((entry) => entry.code === "ENTERED_BY_NOT_MAPPED")
    expect(enteredBy?.severity).toBe("warning")
    expect(enteredBy?.message).toContain("26,064 of 26,064 vouchers")

    const costCentre = plan.exceptions.find((entry) => entry.code === "COST_CENTRE_NOT_MAPPED")
    expect(costCentre?.severity).toBe("warning")
    expect(costCentre?.message).toContain("18,006 vouchers")
  })
})
