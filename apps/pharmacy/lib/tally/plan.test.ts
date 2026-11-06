import { describe, expect, it } from "vitest"

import type { TallyCutoverPlan } from "@synapse/db/tally-normalise"
import { loadStagePlan, readTallyPlanSummary, writeTallyPlan } from "./plan"
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
