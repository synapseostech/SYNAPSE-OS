/**
 * Rollback, then import the same Tally data again.
 *
 * The journal RPC is idempotent on (tenant, source_type, source_id): a second
 * post under a key that exists returns the existing entry with `replayed: true`
 * and writes nothing. A rollback reverses an entry but does not delete it, so a
 * re-import that reused the same keys would "post" nothing while the reversals
 * stayed, and the re-imported period would net to zero. These tests run the
 * whole cycle against an in-memory ledger that follows the RPC's rules.
 */
import { describe, expect, it } from "vitest"
import type { TallyCutoverPlan, TallyCutoverVoucher } from "@synapse/db/tally-normalise"
import { applyTallyChunk, emptyProgress, reverseTallyJournals, tallyOpeningVoucher } from "./apply"
import type { TallyApplyDb } from "./types"

const TENANT = "tenant-1"

type Entry = {
  id: string
  tenant_id: string
  source_type: string
  source_id: string
  entry_date: string
  lines: Array<{ account_id: string; debit: number; credit: number }>
}

function ledgerDb() {
  const entries: Entry[] = []
  const accounts = [
    { id: "acc-1000", code: "1000", tenant_id: TENANT },
    { id: "acc-3000", code: "3000", tenant_id: TENANT },
    { id: "acc-4000", code: "4000", tenant_id: TENANT },
  ]

  const tables: Record<string, () => Array<Record<string, unknown>>> = {
    pharmacy_accounting_accounts: () => accounts,
    pharmacy_accounting_journal_entries: () => entries,
    pharmacy_products: () => [],
    pharmacy_customers: () => [],
    pharmacy_suppliers: () => [],
  }

  const from = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = []
    let window: [number, number] | null = null
    const run = () => {
      const source = tables[table]
      if (!source) throw new Error(`unexpected table ${table}`)
      const rows = source().filter((row) => filters.every((keep) => keep(row)))
      return { data: window ? rows.slice(window[0], window[1] + 1) : rows, error: null }
    }
    const chain: any = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value)
        return chain
      },
      in: (column: string, values: unknown[]) => {
        filters.push((row) => values.includes(row[column]))
        return chain
      },
      order: () => chain,
      limit: () => chain,
      range: (start: number, end: number) => {
        window = [start, end]
        return chain
      },
      maybeSingle: () => Promise.resolve({ data: run().data[0] ?? null, error: null }),
      then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(run()).then(onFulfilled, onRejected),
    }
    return chain
  }

  const rpc = (fn: string, args: Record<string, unknown>) => {
    if (fn !== "post_pharmacy_accounting_journal") {
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } })
    }
    const existing = entries.find(
      (entry) =>
        entry.tenant_id === args.p_tenant_id &&
        entry.source_type === args.p_source_type &&
        entry.source_id === args.p_source_id,
    )
    if (existing) return Promise.resolve({ data: { id: existing.id, replayed: true }, error: null })
    const entry: Entry = {
      id: `entry-${entries.length + 1}`,
      tenant_id: String(args.p_tenant_id),
      source_type: String(args.p_source_type),
      source_id: String(args.p_source_id),
      entry_date: String(args.p_entry_date),
      lines: args.p_lines as Entry["lines"],
    }
    entries.push(entry)
    return Promise.resolve({ data: { id: entry.id, replayed: false }, error: null })
  }

  /** Net debit less credit per account across every entry. */
  const balances = () => {
    const totals: Record<string, number> = {}
    for (const entry of entries) {
      for (const line of entry.lines) {
        totals[line.account_id] = Math.round(((totals[line.account_id] ?? 0) + line.debit - line.credit) * 100) / 100
      }
    }
    for (const key of Object.keys(totals)) if (totals[key] === 0) delete totals[key]
    return totals
  }

  return { db: { from, rpc } as unknown as TallyApplyDb, entries, balances }
}

const VOUCHER: TallyCutoverVoucher = {
  sourceId: "company-guid:voucher-1",
  sourceType: "tally_sale",
  kind: "sales",
  date: "2025-05-10",
  description: "Sale 1",
  currency: "UGX",
  lines: [
    { accountCode: "1000", accountName: "Cash", debit: 100, credit: 0 },
    { accountCode: "4000", accountName: "Sales", debit: 0, credit: 100 },
  ],
}

const PLAN = {
  company: "Test Pharmacy Ltd",
  companyKey: "company-guid",
  currency: "UGX",
  conversionDate: "2025-04-01",
  mode: "opening",
  accounts: [],
  parties: [],
  stockItems: [],
  opening: {
    date: "2025-04-01",
    currency: "UGX",
    lines: [
      { accountCode: "1000", accountName: "Cash", debit: 500, credit: 0 },
      { accountCode: "3000", accountName: "Capital", debit: 0, credit: 500 },
    ],
    totalDebit: 500,
    totalCredit: 500,
    difference: 0,
  },
  vouchers: [VOUCHER],
  sales: [],
  purchases: [],
  exceptions: [],
  warnings: [],
} as unknown as TallyCutoverPlan

/** One import's ledger effect: the opening position plus the sale. */
const ONE_IMPORT = { "acc-1000": 600, "acc-3000": -500, "acc-4000": -100 }

async function importSession(db: TallyApplyDb, sessionId: string) {
  const opening = await applyTallyChunk(db, {
    tenantId: TENANT,
    actorId: "user-1",
    plan: PLAN,
    progress: { ...emptyProgress(), stage: "opening-journal" },
    sessionId,
  })
  const journals = await applyTallyChunk(db, {
    tenantId: TENANT,
    actorId: "user-1",
    plan: PLAN,
    progress: { ...emptyProgress(), stage: "journals" },
    chunk: { vouchers: [VOUCHER], sales: [], purchases: [] },
    totalChunks: 1,
    sessionId,
  })
  return { opening, journals }
}

function rollBack(db: TallyApplyDb, sessionId: string) {
  return reverseTallyJournals(db, {
    tenantId: TENANT,
    actorId: "user-1",
    sessionId,
    vouchers: [tallyOpeningVoucher(PLAN), VOUCHER],
  })
}

describe("rollback, then re-import the same Tally data", () => {
  it("a rollback nets the opening balances and the vouchers back to zero", async () => {
    const ledger = ledgerDb()
    await importSession(ledger.db, "session-1")
    expect(ledger.balances()).toEqual(ONE_IMPORT)

    const reversal = await rollBack(ledger.db, "session-1")
    expect(reversal).toMatchObject({ posted: 2, failures: [] })
    expect(ledger.balances()).toEqual({})
  })

  it("a re-import after a rollback posts its journals again instead of reusing the reversed ones", async () => {
    const ledger = ledgerDb()
    await importSession(ledger.db, "session-1")
    await rollBack(ledger.db, "session-1")

    const again = await importSession(ledger.db, "session-2")
    expect(again.opening.progress.failures).toEqual([])
    expect(again.journals.progress.counts.journals).toBe(1)
    expect(ledger.balances()).toEqual(ONE_IMPORT)
  })

  it("retrying the re-import does not post anything twice", async () => {
    const ledger = ledgerDb()
    await importSession(ledger.db, "session-1")
    await rollBack(ledger.db, "session-1")
    await importSession(ledger.db, "session-2")
    const count = ledger.entries.length

    await importSession(ledger.db, "session-2")
    expect(ledger.entries).toHaveLength(count)
    expect(ledger.balances()).toEqual(ONE_IMPORT)
  })

  it("rolling back the re-import reverses its own entries, and a retried rollback changes nothing", async () => {
    const ledger = ledgerDb()
    await importSession(ledger.db, "session-1")
    await rollBack(ledger.db, "session-1")
    await importSession(ledger.db, "session-2")

    await rollBack(ledger.db, "session-2")
    expect(ledger.balances()).toEqual({})
    const count = ledger.entries.length

    await rollBack(ledger.db, "session-2")
    await rollBack(ledger.db, "session-1")
    expect(ledger.entries).toHaveLength(count)
    expect(ledger.balances()).toEqual({})
  })

  it("a third import after two rollbacks still lands once", async () => {
    const ledger = ledgerDb()
    await importSession(ledger.db, "session-1")
    await rollBack(ledger.db, "session-1")
    await importSession(ledger.db, "session-2")
    await rollBack(ledger.db, "session-2")

    await importSession(ledger.db, "session-3")
    expect(ledger.balances()).toEqual(ONE_IMPORT)
  })

  it("a second import of the same data with no rollback still does not double-post", async () => {
    const ledger = ledgerDb()
    await importSession(ledger.db, "session-1")
    await importSession(ledger.db, "session-2")
    expect(ledger.balances()).toEqual(ONE_IMPORT)
  })

  it("a rollback never reverses a voucher the import did not post", async () => {
    const ledger = ledgerDb()
    const unposted: TallyCutoverVoucher = { ...VOUCHER, sourceId: "company-guid:voucher-never-posted" }
    await importSession(ledger.db, "session-1")

    const reversal = await reverseTallyJournals(ledger.db, {
      tenantId: TENANT,
      actorId: "user-1",
      sessionId: "session-1",
      vouchers: [tallyOpeningVoucher(PLAN), VOUCHER, unposted],
    })
    expect(reversal).toMatchObject({ posted: 2, notPosted: 1 })
    expect(ledger.balances()).toEqual({})
  })
})
