import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import { reconcileReplay, simulateReplay } from "@synapse/db/tally-replay"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"
import { consolidateTallyParts } from "./consolidate"
import { describeStagedDocument, type TallyStagedDescription } from "./manifest"
import { readTallyDocument } from "./source"
import { applyTallyStockSheet, buildTallyStockSheet, readTallyStockSheet } from "./stock-sheet"

/**
 * Runs against a real export folder, not a fixture. Set SADIO_TALLY_EXPORT_DIR
 * to the folder holding `2-masters-*.xml` and the `3-daybook-*.xml` files;
 * without it the suite is skipped so an ordinary run never depends on files
 * outside the repo.
 *
 * The assertions below pin one specific export. If the folder changes, the
 * hash fails first and every count under it needs re-reading against the new
 * files — they are evidence about that export, not invariants of the importer.
 */
const exportDir = process.env.SADIO_TALLY_EXPORT_DIR
const suite = exportDir ? describe : describe.skip

const COMPANY = "SADIO PHARMACY"
const PERIOD = { from: "2025-10-01", to: "2026-11-30" }
const TODAY = "2026-11-11"

const EXPORT_SHA256 = "334007d9270be3012e49fd50b073da6fe877b2cd119ebc64671b89f42d8d02d4"
const FILES = 15
const DAYBOOKS = 14

type Part = {
  file: string
  bytes: number
  sha256: string
  document: TallyXmlDocument
  staged: TallyStagedDescription
}

type Consolidated = ReturnType<typeof consolidateTallyParts>

let cached:
  | Promise<{
      parts: Part[]
      document: TallyXmlDocument
      report: Consolidated["report"]
      plan: ReturnType<typeof normaliseTallyDocument>
    }>
  | undefined

function readFolder() {
  if (cached) return cached
  cached = (async () => {
    const names = readdirSync(exportDir!)
      .filter((name) => /^[23]-.+\.xml$/i.test(name))
      .sort()
    const parts: Part[] = []
    for (const file of names) {
      const path = join(exportDir!, file)
      const bytes = readFileSync(path)
      const { document } = readTallyDocument(new Uint8Array(bytes), file)
      // The portal only asks the operator for a period when the file states
      // none; giving every file the session's period would collapse the day
      // books onto one chunk id.
      let staged = describeStagedDocument(document, { company: COMPANY })
      if (!staged.ok && staged.code === "TALLY_PERIOD_MISSING") {
        staged = describeStagedDocument(document, { company: COMPANY, requestedPeriod: PERIOD })
      }
      parts.push({
        file,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        document,
        staged,
      })
    }
    const { document, report } = consolidateTallyParts(
      parts.map((part) => part.document),
      { period: PERIOD, company: COMPANY },
    )
    const plan = normaliseTallyDocument(document, {
      mode: "replay",
      conversionDate: PERIOD.from,
      today: TODAY,
    })
    return { parts, document, report, plan }
  })()
  return cached
}

function movementCounts(plan: ReturnType<typeof normaliseTallyDocument>) {
  return (plan.movements ?? []).reduce<Record<string, number>>((acc, movement) => {
    acc[movement.movementKind] = (acc[movement.movementKind] ?? 0) + 1
    return acc
  }, {})
}

function replay(document: TallyXmlDocument, batchExpiry?: "not-supplied") {
  return normaliseTallyDocument(document, {
    mode: "replay",
    conversionDate: PERIOD.from,
    today: TODAY,
    ...(batchExpiry ? { batchExpiry } : {}),
  })
}

suite("the SADIO PHARMACY export folder", () => {
  it("stages all 15 files once and merges them into one company", { timeout: 300_000 }, async () => {
    const { parts, report } = await readFolder()
    const folderHash = createHash("sha256")
      .update(parts.map((part) => `${part.file}:${part.sha256}`).join("\n"))
      .digest("hex")
    expect(folderHash).toBe(EXPORT_SHA256)

    const problems = parts.flatMap((part) =>
      part.staged.ok
        ? []
        : [`${part.file}: ${part.staged.code} — ${part.staged.message}`],
    )
    expect(problems).toEqual([])
    expect(parts).toHaveLength(FILES)

    const chunkIds = parts.map((part) => (part.staged.ok ? part.staged.chunkId : "?"))
    expect(new Set(chunkIds).size).toBe(FILES)

    const masters = parts.filter((part) => part.staged.ok && part.staged.kind === "masters")
    const daybooks = parts.filter((part) => part.staged.ok && part.staged.kind === "vouchers")
    expect(masters).toHaveLength(1)
    expect(daybooks).toHaveLength(DAYBOOKS)
    expect(masters[0]!.staged).toMatchObject({
      kind: "masters",
      recordsRead: 2112,
      range: PERIOD,
    })
    // The masters file predates the company record the exporter now writes, so
    // the operator's entry is what names the company; the day books state it.
    expect(masters[0]!.staged.ok && masters[0]!.staged.companySource).toBe("operator")
    for (const daybook of daybooks) {
      expect(daybook.staged.ok && daybook.staged.companySource).toBe("file")
    }

    expect(report.masters).toEqual({
      groups: 29,
      ledgers: 56,
      stockGroups: 0,
      stockItems: 2025,
      units: 1,
      godowns: 1,
      total: 2112,
      duplicates: 0,
      conflicts: 0,
    })
    expect(report.vouchers).toMatchObject({
      read: 26_395,
      unique: 26_395,
      duplicates: 0,
      cancelled: 0,
      undated: 0,
      keyless: 0,
    })
    const types = Object.fromEntries(report.vouchers.types.map((entry) => [entry.type, entry.count]))
    expect(types).toEqual({
      "Cash Sale": 24_600,
      Purchase: 1_326,
      "Physical Stock": 465,
      "Credit Sale": 2,
      Payment: 1,
      "Stock Journal": 1,
    })
    expect(report.dates).toMatchObject({ first: "2025-10-17", last: "2026-11-04" })
    expect(report.problems).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.truncated).toBeUndefined()
  })

  it("accounts for every voucher, including those it cannot post", { timeout: 300_000 }, async () => {
    const { document, plan } = await readFolder()

    expect(plan.counts).toEqual({
      ledgers: 56,
      groups: 29,
      stockItems: 2025,
      vouchers: 26_395,
      postedVouchers: 25_929,
      // 465 Physical Stock and 1 Stock Journal. The unaccepted run refuses the
      // stock journal's receipt line for having no expiry, so it builds no
      // movement and is not counted as adjusted.
      adjustedVouchers: 465,
      skippedVouchers: 0,
      sales: 24_602,
      purchases: 1_325,
      openingLines: 0,
    })

    // Neither mode drops them: replay folds all 466 into the rebuilt movement
    // history, opening applies them as dated adjustments after the opening
    // stock, and every one of the 26,395 vouchers is accounted for either way.
    const opening = normaliseTallyDocument(document, {
      mode: "opening",
      conversionDate: PERIOD.from,
      today: TODAY,
      batchExpiry: "not-supplied",
    })
    expect(opening.counts.adjustedVouchers).toBe(466)
    expect(opening.counts.skippedVouchers).toBe(0)
    expect(
      opening.counts.postedVouchers +
        opening.counts.adjustedVouchers +
        opening.counts.skippedVouchers,
    ).toBe(26_395)
    expect(opening.exceptionCounts?.VOUCHER_TYPE_UNSUPPORTED).toBeUndefined()
    expect(opening.exceptionCounts?.OPENING_STOCK_WITHOUT_EXPIRY).toBe(1_112)

    // Every adjustment is dated inside the period and ordered oldest first, so
    // the newest count is the one that stands.
    const adjustments = opening.movements ?? []
    expect(adjustments).toHaveLength(1_673)
    expect(movementCounts(opening)).toEqual({ physical_adjust: 1_672, stock_journal_in: 1 })
    expect(new Set(adjustments.map((entry) => entry.sourceId)).size).toBeGreaterThan(400)
    expect(adjustments.map((entry) => entry.date)).toEqual(
      [...adjustments.map((entry) => entry.date)].sort(),
    )
    expect(adjustments[0]?.date).toBe("2025-11-16")
    expect(adjustments.at(-1)?.date).toBe("2026-11-04")

    // One physical stock line states no quantity. It is named as blocking
    // rather than counted as zero; the rest of the voucher still applies.
    const openingBlocking = opening.exceptions.filter((entry) => entry.severity === "blocking")
    expect(openingBlocking).toHaveLength(1)
    expect(openingBlocking[0]?.code).toBe("REPLAY_MOVEMENT_WITHOUT_QUANTITY")

    // Unaccepted, every receipt with no batch expiry is refused, so no
    // purchase movement is built at all.
    expect(movementCounts(plan)).toEqual({ sale_out: 41_034, physical_adjust: 1_672 })
    expect(plan.exceptionCounts).toEqual({
      UNCLASSIFIED_LEDGER: 6,
      ENTERED_BY_NOT_MAPPED: 1,
      COST_CENTRE_NOT_MAPPED: 1,
      REPLAY_MOVEMENT_EXPIRY_MISSING: 4_552,
      REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER: 1,
      REPLAY_MOVEMENT_WITHOUT_QUANTITY: 5,
      OPENING_STOCK_WITHOUT_EXPIRY: 1_112,
      COST_UNKNOWN: 1,
      STOCK_LINE_WITHOUT_QUANTITY: 3,
    })

    // Accepting the absent expiry is an explicit, disclosed decision: it is the
    // only way the receipts become replayable, and it is recorded as a warning.
    const accepted = replay(document, "not-supplied")
    expect(movementCounts(accepted)).toEqual({
      sale_out: 41_034,
      purchase_in: 4_549,
      stock_journal_in: 3,
      physical_adjust: 1_672,
    })
    expect(accepted.exceptionCounts).toEqual({
      UNCLASSIFIED_LEDGER: 6,
      ENTERED_BY_NOT_MAPPED: 1,
      COST_CENTRE_NOT_MAPPED: 1,
      REPLAY_BATCH_EXPIRY_NOT_SUPPLIED: 1,
      REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER: 1,
      REPLAY_MOVEMENT_WITHOUT_QUANTITY: 5,
      OPENING_STOCK_WITHOUT_EXPIRY: 1_112,
      COST_UNKNOWN: 1,
      STOCK_LINE_WITHOUT_QUANTITY: 3,
    })
    const acceptedBlocking = accepted.exceptions.filter((entry) => entry.severity === "blocking")
    expect(acceptedBlocking).toHaveLength(5)
    expect(new Set(acceptedBlocking.map((entry) => entry.code))).toEqual(
      new Set(["REPLAY_MOVEMENT_WITHOUT_QUANTITY"]),
    )
  })

  it("reconciles the ledger, and shows stock parity needs batch expiry", { timeout: 300_000 }, async () => {
    const { document } = await readFolder()
    const plan = replay(document, "not-supplied")
    const reconciliation = reconcileReplay(simulateReplay(plan), plan)

    const physical = new Map<string, number>()
    for (const movement of plan.movements ?? []) {
      if (movement.movementKind !== "physical_adjust") continue
      physical.set(movement.stockItemName, (physical.get(movement.stockItemName) ?? 0) + 1)
    }
    const itemByName = new Map(plan.stockItems.map((item) => [item.sourceName, item]))
    const differing = reconciliation.rows.filter(
      (row) =>
        row.scope === "stock_item" && !row.key.endsWith(" (value)") && row.status === "difference",
    )

    // A physical-stock line is a counted quantity, not a delta, so summing its
    // quantityDelta means nothing. The question that matters is whether each
    // item's difference is explained by an opening position the replay could
    // not seed, or whether an item differs with no opening position at all.
    const explained = { openingOnly: 0, openingWithPhysical: 0, physicalOnly: 0, neither: 0 }
    for (const row of differing) {
      const item = itemByName.get(row.key)
      const opening = item?.quantity ?? 0
      const counts = physical.get(row.key) ?? 0
      const bucket =
        opening !== 0 && counts === 0
          ? "openingOnly"
          : opening !== 0
            ? "openingWithPhysical"
            : counts > 0
              ? "physicalOnly"
              : "neither"
      explained[bucket] += 1
    }
    expect(explained).toEqual({
      openingOnly: 318,
      openingWithPhysical: 1,
      physicalOnly: 1,
      neither: 0,
    })

    expect(plan.stockItems).toHaveLength(2025)
    expect(plan.stockItems.filter((item) => (item.quantity ?? 0) !== 0)).toHaveLength(1_112)
    expect(physical.size).toBe(1_131)
    // The masters carry no batch allocation on a stock item and no expiry, so
    // no opening batch is receivable and none of the 1,112 opening positions is
    // seeded. That is the whole of the stock difference.
    expect(
      plan.stockItems.filter((item) => item.batches.some((batch) => batch.receivable)),
    ).toEqual([])

    const byScope = reconciliation.rows.reduce<Record<string, Record<string, number>>>(
      (acc, row) => {
        const bucket = (acc[row.scope] ??= {})
        bucket[row.status] = (bucket[row.status] ?? 0) + 1
        return acc
      },
      {},
    )
    expect(byScope).toEqual({
      stock_item: { match: 1_939, difference: 2_111 },
      stock_total: { difference: 1 },
      account: { match: 55, difference: 1 },
    })

    const accountDifferences = reconciliation.rows.filter(
      (row) => row.scope === "account" && row.status === "difference",
    )
    expect(accountDifferences).toEqual([
      expect.objectContaining({
        key: "T-328A6A37 Profit & Loss A/c",
        expected: -171_571_798.29,
        actual: 0,
      }),
    ])

    // The one item with no opening position: Tally's closing is one order of
    // the 2026-09-16 vouchers ahead of the export's own order, and the export
    // carries no time of day, so the ordering cannot be recovered from it.
    expect(differing.find((row) => row.key === "Vicryl No.1 Round Bodied")).toMatchObject({
      expected: 26,
      actual: 30,
      difference: 4,
    })

    expect(reconciliation.blocking).toBe(8_233)
  })

  it("hands the operator every opening item on the stock sheet, with nothing guessed", { timeout: 300_000 }, async () => {
    const { document, plan } = await readFolder()
    const sheet = readTallyStockSheet(new Uint8Array(buildTallyStockSheet(document, "opening")))

    const opening = plan.stockItems
      .filter((item) => (item.quantity ?? 0) > 0)
      .map((item) => item.sourceName)
      .sort()
    expect(sheet.rows).toHaveLength(1_112)
    // The sheet sorts with localeCompare, which orders a few names differently
    // from code-unit sort; the item set is what has to agree.
    expect(new Set(sheet.rows.map((row) => row.item))).toEqual(new Set(opening))
    expect(sheet.rows.every((row) => (row.quantity ?? 0) > 0)).toBe(true)
    expect(sheet.rows.every((row) => row.amount !== undefined)).toBe(true)
    // The export has no batch or expiry, so the sheet asks for both rather
    // than carrying a value forward.
    expect(sheet.rows.some((row) => row.batch !== undefined)).toBe(false)
    expect(sheet.rows.some((row) => row.expiry !== undefined)).toBe(false)
    expect(sheet.problems).toEqual(["1112 rows have no expiry, so they create no batch."])

    // Uploaded blank, it changes nothing: no batch is invented, and the export
    // is still judged without opening stock.
    const blank = applyTallyStockSheet(document, sheet)
    expect(blank).toMatchObject({ applied: 0, unmatched: [], withoutExpiry: 1_112 })
    expect(blank.document.stockItems).toEqual(document.stockItems)
  })
})
