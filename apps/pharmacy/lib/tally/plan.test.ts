import { describe, expect, it } from "vitest"

import type { TallyCutoverPlan } from "@synapse/db/tally-normalise"
import {
  loadStagePlan,
  readTallyPlanSummary,
  readTallyReplayTarget,
  writeTallyPlan,
} from "./plan"
import type { TallyStorageClient } from "./storage"

const TENANT = "11111111-1111-1111-1111-111111111111"
const SESSION = "22222222-2222-2222-2222-222222222222"

/** An in-memory bucket: objects are stored as the JSON text that was written. */
function memoryStorage() {
  const objects = new Map<string, string>()
  const client: TallyStorageClient = {
    storage: {
      getBucket: async () => ({ data: {}, error: null }),
      createBucket: async () => ({ data: {}, error: null }),
      from: (bucket) => ({
        createSignedUploadUrl: async () => ({ data: null, error: { message: "unused" } }),
        download: async (path) => {
          const text = objects.get(`${bucket}/${path}`)
          return text === undefined
            ? { data: null, error: { message: "not found" } }
            : { data: new Blob([text], { type: "application/json" }), error: null }
        },
        upload: async (path, body) => {
          objects.set(
            `${bucket}/${path}`,
            typeof body === "string"
              ? body
              : new TextDecoder().decode(body instanceof Uint8Array ? body : new Uint8Array(body)),
          )
          return { data: {}, error: null }
        },
        remove: async () => ({ data: {}, error: null }),
      }),
    },
  }
  return { client, objects }
}

function truncatedPlan(): TallyCutoverPlan {
  return {
    company: "Test Pharmacy",
    companyKey: "test-pharmacy",
    currency: "UGX",
    conversionDate: "2026-01-01",
    mode: "opening",
    accounts: [],
    parties: [],
    stockItems: [],
    stock: {
      openingValue: 0,
      closingValue: 0,
      itemsWithOpeningValue: 0,
      itemsWithClosingValue: 0,
      itemCount: 0,
    },
    opening: { date: "2026-01-01", currency: "UGX", lines: [], totalDebit: 0, totalCredit: 0, difference: 0 },
    vouchers: [],
    sales: [],
    purchases: [],
    exceptions: [
      {
        code: "SOURCE_TRUNCATED",
        severity: "blocking",
        message: "The import stopped after 250,000 records.",
        detail: "reason=RECORD_LIMIT; recordsProcessed=250000; limit=250000",
      },
    ],
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
  }
}

describe("tally plan persistence", () => {
  it("keeps the blocking truncation exception across a write and a reload", async () => {
    const { client, objects } = memoryStorage()

    await writeTallyPlan(client, TENANT, SESSION, truncatedPlan(), "xml")

    // The exception is in the stored document itself, not only in memory.
    const stored = [...objects.values()].find((text) => text.includes("SOURCE_TRUNCATED"))
    expect(stored).toBeDefined()

    const summary = await readTallyPlanSummary(client, TENANT, SESSION)
    expect(summary?.exceptions).toEqual([
      {
        code: "SOURCE_TRUNCATED",
        severity: "blocking",
        message: "The import stopped after 250,000 records.",
        detail: "reason=RECORD_LIMIT; recordsProcessed=250000; limit=250000",
      },
    ])
  })

  it("serves the persisted exceptions through the stage a resumed apply loads", async () => {
    const { client } = memoryStorage()

    await writeTallyPlan(client, TENANT, SESSION, truncatedPlan(), "xml")
    const loaded = await loadStagePlan(client, TENANT, SESSION, "journals", 0)

    expect(loaded.summary.exceptions).toContainEqual(
      expect.objectContaining({ code: "SOURCE_TRUNCATED", severity: "blocking" }),
    )
    // The persisted summary is the carrier: the reconstructed plan never holds
    // exceptions, so a gate that reads plan.exceptions would see nothing.
    expect(loaded.plan.exceptions).toEqual([])
  })

  it("hands the journals stage the replay cost each sale line moved at", async () => {
    const { client } = memoryStorage()

    await writeTallyPlan(client, TENANT, SESSION, { ...truncatedPlan(), mode: "replay" }, "xml")
    const target = await readTallyReplayTarget(client, TENANT, SESSION)
    expect(target).not.toBeNull()

    // The sale mirror writes the cost the replay derived, and that figure
    // lives only in the saved target, so the stage that posts sale lines has
    // to be given it.
    const loaded = await loadStagePlan(client, TENANT, SESSION, "journals", 0)
    expect(loaded.replay?.preparedAt).toBe(target?.preparedAt)
    expect(loaded.replay?.costs).toEqual(target?.costs)
  })

  it("chunks a closing cut-over's sales even though it posts no vouchers", async () => {
    const { client } = memoryStorage()
    const plan = {
      ...truncatedPlan(),
      mode: "closing" as const,
      vouchers: [],
      sales: [
        {
          sourceId: "test-pharmacy:sale-guid",
          date: "2026-01-15",
          transactionNumber: "TALLY-S-001",
          paymentMethod: "CASH",
          total: 200,
          tax: 0,
          discount: 0,
          items: [
            { stockItemName: "Test Item A", quantity: 2, unitPrice: 100, lineTotal: 200 },
          ],
        },
      ],
      counts: { ...truncatedPlan().counts, sales: 1, vouchers: 1 },
    }

    const summary = await writeTallyPlan(client, TENANT, SESSION, plan, "xml")
    const loaded = await loadStagePlan(client, TENANT, SESSION, "journals", 0)

    expect(summary.chunkCount).toBe(1)
    expect(loaded.chunk?.vouchers).toEqual([])
    expect(loaded.chunk?.sales.map((sale) => sale.sourceId)).toEqual(["test-pharmacy:sale-guid"])
  })
})

describe("tally replay plan persistence", () => {
  function replayPlan(): TallyCutoverPlan {
    const base = truncatedPlan()
    return {
      ...base,
      mode: "replay",
      cutoffDate: "2026-12-31",
      ordering: "date-then-export-order",
      stockItems: [
        {
          sourceName: "Test Item A",
          sku: "TEST-A",
          name: "Test Item A",
          unit: "Strip",
          closingQuantity: 29,
          closingValue: 2900,
          batches: [],
        },
      ],
      stock: {
        openingValue: null,
        closingValue: 2900,
        itemsWithOpeningValue: 0,
        itemsWithClosingValue: 1,
        itemCount: 1,
      },
      movements: [
        {
          movementId: "purchase",
          sourceId: "purchase",
          kind: "purchase",
          movementKind: "purchase_in",
          date: "2026-01-10",
          sourceOrder: 0,
          lineIndex: 0,
          batchIndex: 0,
          stockItemName: "Test Item A",
          quantityDelta: 20,
          batchNumber: "B-002",
          expiryDate: "2027-03-31",
          rate: 100,
          amount: 2000,
          allocation: "explicit",
        },
        {
          movementId: "physical",
          sourceId: "physical",
          kind: "stock_journal",
          movementKind: "physical_adjust",
          date: "2026-01-25",
          sourceOrder: 1,
          lineIndex: 0,
          batchIndex: 0,
          stockItemName: "Test Item A",
          quantityDelta: 29,
          batchNumber: "B-001",
          expiryDate: "2027-02-28",
          rate: 100,
          amount: 2900,
          allocation: "explicit",
        },
      ],
    }
  }

  it("stores the movements and the closing target a replay apply reads", async () => {
    const { client, objects } = memoryStorage()

    const summary = await writeTallyPlan(client, TENANT, SESSION, replayPlan(), "xml")

    expect(summary.replay).toMatchObject({
      cutoffDate: "2026-12-31",
      ordering: "date-then-export-order",
      movementCount: 2,
      movementChunkCount: 1,
    })
    expect([...objects.keys()].some((path) => path.endsWith("plan-movement-chunk-000.json"))).toBe(
      true,
    )
    expect([...objects.keys()].some((path) => path.endsWith("plan-replay-target.json"))).toBe(true)

    const history = await loadStagePlan(client, TENANT, SESSION, "stock-history", 0)
    expect(history.plan.movements?.map((entry) => entry.movementId)).toEqual([
      "purchase",
      "physical",
    ])

    const closing = await loadStagePlan(client, TENANT, SESSION, "replay-closing", 0)
    expect(closing.replay?.cutoffDate).toBe("2026-12-31")
    expect(
      closing.replay?.simulated.items.find((item) => item.stockItemName === "Test Item A")
        ?.quantity,
    ).toBe(29)
  })

  it("adds no replay block to an opening plan", async () => {
    const { client } = memoryStorage()

    const summary = await writeTallyPlan(client, TENANT, SESSION, truncatedPlan(), "xml")

    expect(summary.replay).toBeUndefined()
  })
})
