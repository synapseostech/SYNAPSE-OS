import { describe, expect, it } from "vitest"
import {
  TALLY_HISTORY_PAGE_SIZE,
  TALLY_HISTORY_SOURCE_TYPES,
  TALLY_JOURNAL_SOURCE_TYPES,
  listTallyHistoryEntries,
  listTallyHistorySessions,
  loadTallyHistoryEntry,
  loadTallyHistorySummary,
  parseTallyHistoryFilter,
} from "./history"
import { boundsOf, fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "./test-db"

const TENANT = "tenant-1"

const PLAN = { postedVouchers: 10, sales: 6, purchases: 2, openingLines: 4 }
const APPLIED = { openingJournal: 1, journals: 9, sales: 6, purchases: 2 }

function session(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    status: "complete",
    file_name: "daybook.xml",
    created_at: "2026-11-01T00:00:00.000Z",
    completed_at: "2026-11-02T00:00:00.000Z",
    reversed_at: null,
    continuation_of: null,
    mapping_mode: null,
    mapping_conversion_date: null,
    summary_mode: "opening",
    summary_company: "SADIO Pharmacy",
    summary_currency: "UGX",
    summary_conversion_date: "2025-04-01",
    plan_counts: PLAN,
    period: { from: "2025-04-01", to: "2026-03-31" },
    applied_counts: APPLIED,
    failures: [{ stage: "journals", key: "sadio:v9", code: "ACCOUNTING_UNBALANCED", message: "unbalanced" }],
    ...overrides,
  }
}

/** Ledger counts by source type, for the summary's head counts. */
function ledger(
  counts: Partial<Record<string, number>>,
  extra: { openingReversals?: number; sales?: number; purchases?: number } = {},
) {
  return (operation: FakeOperation): FakeResult => {
    const filters = filtersOf(operation)
    if (operation.table === "pharmacy_accounting_journal_entries") {
      if (filters["source_id:like"]) return { count: extra.openingReversals ?? 0, error: null }
      return { count: counts[String(filters.source_type)] ?? 0, error: null }
    }
    if (operation.table === "pharmacy_transactions") return { count: extra.sales ?? 6, error: null }
    if (operation.table === "pharmacy_purchases") return { count: extra.purchases ?? 2, error: null }
    throw new Error(`unexpected table ${operation.table}`)
  }
}

const check = (result: Awaited<ReturnType<typeof loadTallyHistorySummary>>, id: string) =>
  result.checks.find((item) => item.id === id)!

describe("loadTallyHistorySummary", () => {
  it("sets the plan, the apply's report and the ledger side by side", async () => {
    const fake = fakeSupabase(ledger({ tally_opening: 1, tally_sale: 6, tally_purchase: 2, tally_receipt: 1 }))
    const result = await loadTallyHistorySummary(fake.client as never, TENANT, [session() as never])

    expect(result.sessions[0]).toMatchObject({ company: "SADIO Pharmacy", mode: "opening", failureCount: 1 })
    expect(result.journalsInForce).toBe(10)
    expect(result.ledger.map((row) => row.sourceType)).toEqual([...TALLY_HISTORY_SOURCE_TYPES])
    // One voucher failed to post: the ledger is one short of the plan.
    expect(check(result, "vouchers")).toMatchObject({ planned: 10, applied: 9, found: 9, status: "short" })
    expect(check(result, "opening")).toMatchObject({ planned: 1, found: 1, status: "match" })
    expect(check(result, "sales")).toMatchObject({ planned: 6, found: 6, status: "match" })
    expect(result.failures[0]).toMatchObject({ sessionId: "session-1", code: "ACCOUNTING_UNBALANCED" })
  })

  it("scopes every count to the tenant and identifies mirrors by their read-only note", async () => {
    const fake = fakeSupabase(ledger({}))
    await loadTallyHistorySummary(fake.client as never, TENANT, [session() as never])
    for (const operation of fake.operations) expect(filtersOf(operation).tenant_id).toBe(TENANT)
    const sales = fake.operations.find((operation) => operation.table === "pharmacy_transactions")!
    expect(filtersOf(sales)["notes:like"]).toBe("Imported from Tally%")
  })

  it("adds a continuation's plan to the period it continues", async () => {
    const fake = fakeSupabase(ledger({ tally_opening: 1, tally_sale: 15 }, { sales: 12, purchases: 4 }))
    const result = await loadTallyHistorySummary(fake.client as never, TENANT, [
      session({ id: "session-2", continuation_of: "session-1", summary_mode: "replay", plan_counts: { ...PLAN, openingLines: 0 } }) as never,
      session() as never,
    ])
    expect(check(result, "vouchers")).toMatchObject({ planned: 20, found: 15 })
    expect(check(result, "opening")).toMatchObject({ planned: 1, found: 1, status: "match" })
    expect(check(result, "sales")).toMatchObject({ planned: 12, found: 12, status: "match" })
  })

  it("nets rollback reversals out and compares only the sessions still in force", async () => {
    const fake = fakeSupabase(
      // Session 1 posted 1 opening + 9 vouchers, was rolled back, then session 2 posted 9 more.
      ledger({ tally_opening: 1, tally_sale: 18, tally_replay_reversal: 10 }, { openingReversals: 1, sales: 12 }),
    )
    const result = await loadTallyHistorySummary(fake.client as never, TENANT, [
      session({ id: "session-2", plan_counts: { ...PLAN, postedVouchers: 9, openingLines: 0 } }) as never,
      session({ reversed_at: "2026-11-03T00:00:00.000Z" }) as never,
    ])
    expect(result.reversals).toBe(10)
    expect(result.journalsInForce).toBe(9)
    expect(check(result, "opening")).toMatchObject({ planned: 0, found: 0, status: "match" })
    expect(check(result, "vouchers")).toMatchObject({ planned: 9, found: 9, status: "match" })
    // Mirrors are not reversed, so the count cannot be read against one plan.
    expect(check(result, "sales")).toMatchObject({ found: 12, status: "unknown" })
    expect(check(result, "sales").note).toMatch(/rolled-back/)
  })

  it("expects no vouchers in balances-only mode", async () => {
    const fake = fakeSupabase(ledger({ tally_opening: 1 }, { sales: 0, purchases: 0 }))
    const result = await loadTallyHistorySummary(fake.client as never, TENANT, [
      session({ summary_mode: "closing" }) as never,
    ])
    expect(result.checks.every((item) => item.status === "match")).toBe(true)
  })

  it("reports unknown, not a match, when a session kept no plan counts", async () => {
    const fake = fakeSupabase(ledger({ tally_sale: 3 }))
    const result = await loadTallyHistorySummary(fake.client as never, TENANT, [
      session({ plan_counts: null, applied_counts: null }) as never,
    ])
    expect(result.checks.every((item) => item.status === "unknown")).toBe(true)
    expect(check(result, "vouchers").applied).toBeNull()
  })

  it("fails loudly rather than reporting zero when a count cannot be read", async () => {
    const fake = fakeSupabase(() => ({ count: null, error: { message: "permission denied" } }))
    await expect(
      loadTallyHistorySummary(fake.client as never, TENANT, [session() as never]),
    ).rejects.toThrow(/^TALLY_HISTORY_UNAVAILABLE/)
  })
})

describe("listTallyHistorySessions", () => {
  it("reads only the mapping fields it shows, never the whole mapping", async () => {
    const fake = fakeSupabase(() => ({ data: [session()], error: null }))
    await listTallyHistorySessions(fake.client as never, TENANT)
    const [operation] = fake.operations
    const columns = String(operation!.selected[0])
    expect(columns).not.toMatch(/(^|, )ai_mapping(,|$)/)
    expect(columns).toContain("ai_mapping->>reversedAt")
    expect(filtersOf(operation!)).toMatchObject({ tenant_id: TENANT, source_system: "Tally" })
  })

  it("drops sessions that never reached the apply", async () => {
    const fake = fakeSupabase(() => ({
      data: [session(), session({ id: "session-2", status: "failed", applied_counts: null })],
      error: null,
    }))
    const rows = await listTallyHistorySessions(fake.client as never, TENANT)
    expect(rows.map((row) => row.id)).toEqual(["session-1"])
  })
})

describe("listTallyHistoryEntries", () => {
  const row = {
    id: "j1",
    entry_no: "JE-1",
    entry_date: "2025-04-02",
    source_type: "tally_sale",
    source_id: "sadio:s1",
    description: "Sales 1",
    currency: "UGX",
    total_debit: "1500.00",
  }

  it("lists only imported journals for the tenant, paged, and marks reversed ones", async () => {
    const fake = fakeSupabase((operation) =>
      filtersOf(operation).source_type === "tally_replay_reversal"
        ? { data: [{ source_id: "tally_sale:sadio:s1" }], error: null }
        : { data: [row], count: 120, error: null },
    )
    const result = await listTallyHistoryEntries(fake.client as never, TENANT, { page: 3 })
    const [operation, reversals] = fake.operations
    expect(filtersOf(operation!)).toMatchObject({ tenant_id: TENANT, source_type: [...TALLY_JOURNAL_SOURCE_TYPES] })
    expect(operation!.window).toEqual({ from: 2 * TALLY_HISTORY_PAGE_SIZE, to: 3 * TALLY_HISTORY_PAGE_SIZE - 1 })
    expect(filtersOf(reversals!)).toMatchObject({ tenant_id: TENANT, source_id: ["tally_sale:sadio:s1"] })
    expect(result).toMatchObject({ total: 120, page: 3 })
    expect(result.entries[0]).toMatchObject({ label: "Sales", total: 1500, reversed: true })
  })

  it("applies the type and date filters", async () => {
    const fake = fakeSupabase(() => ({ data: [], count: 0, error: null }))
    await listTallyHistoryEntries(fake.client as never, TENANT, {
      sourceType: "tally_receipt",
      from: "2025-04-01",
      to: "2025-04-30",
    })
    const [operation] = fake.operations
    expect(filtersOf(operation!).source_type).toBe("tally_receipt")
    expect(boundsOf(operation!).entry_date).toEqual({ gte: "2025-04-01", lte: "2025-04-30" })
    // Nothing on the page, so no reversal lookup.
    expect(fake.operations).toHaveLength(1)
  })
})

describe("parseTallyHistoryFilter", () => {
  it("drops anything it does not recognise", () => {
    const filter = parseTallyHistoryFilter(
      new URLSearchParams({ type: "pos_sale", from: "1 April", to: "2025-04-30", page: "-2" }),
    )
    expect(filter).toEqual({ sourceType: undefined, from: undefined, to: "2025-04-30", page: 1 })
  })

  it("accepts the rollback reversals as a type", () => {
    expect(parseTallyHistoryFilter(new URLSearchParams({ type: "tally_replay_reversal" })).sourceType).toBe(
      "tally_replay_reversal",
    )
  })
})

describe("loadTallyHistoryEntry", () => {
  const entry = {
    id: "j1",
    entry_no: "JE-1",
    entry_date: "2025-04-02",
    source_type: "tally_sale",
    source_id: "sadio:s1",
    description: "Sales 1",
    currency: "UGX",
    total_debit: 1500,
  }

  it("returns the voucher with named accounts, debits first", async () => {
    const fake = fakeSupabase((operation) => {
      if (operation.table === "pharmacy_accounting_journal_entries") {
        return filtersOf(operation).source_type === "tally_replay_reversal"
          ? { data: [], error: null }
          : { data: entry, error: null }
      }
      if (operation.table === "pharmacy_accounting_journal_lines") {
        return {
          data: [
            { id: "l2", account_id: "a2", description: null, debit: 0, credit: 1500 },
            { id: "l1", account_id: "a1", description: null, debit: 1500, credit: 0 },
          ],
          error: null,
        }
      }
      return {
        data: [
          { id: "a1", code: "1000", name: "Cash" },
          { id: "a2", code: "4000", name: "Sales" },
        ],
        error: null,
      }
    })
    const result = await loadTallyHistoryEntry(fake.client as never, TENANT, "j1")
    expect(result?.lines.map((line) => line.accountName)).toEqual(["Cash", "Sales"])
    expect(result?.entry.reversed).toBe(false)
    for (const operation of fake.operations) expect(filtersOf(operation).tenant_id).toBe(TENANT)
  })

  it("refuses a journal the portal posted itself", async () => {
    const fake = fakeSupabase(() => ({ data: { ...entry, source_type: "pos_sale" }, error: null }))
    expect(await loadTallyHistoryEntry(fake.client as never, TENANT, "j1")).toBeNull()
    expect(fake.operations).toHaveLength(1)
  })
})
