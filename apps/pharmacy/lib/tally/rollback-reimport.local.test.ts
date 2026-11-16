/**
 * Rollback, then re-import — against a LOCAL Supabase (skipped unless
 * LOCAL_API_URL is 127.0.0.1/localhost).
 *
 * rollback-reimport.test.ts proves the cycle against an in-memory ledger that
 * copies the journal RPC's rule. This runs the same cycle through the real
 * `post_pharmacy_accounting_journal`, so the "already posted" answer, the
 * unique key and the balances all come from PostgreSQL.
 *
 * It creates its own synthetic tenant. Journal entries are immutable, so that
 * tenant and its entries stay in the local database afterwards by design.
 */
import { randomUUID } from "node:crypto"
import { createClient } from "@supabase/supabase-js"
import { beforeAll, describe, expect, it } from "vitest"
import type { TallyCutoverPlan, TallyCutoverVoucher } from "@synapse/db/tally-normalise"
import { applyTallyChunk, emptyProgress, reverseTallyJournals, tallyOpeningVoucher } from "./apply"
import type { TallyApplyDb } from "./types"

const URL_ = process.env.LOCAL_API_URL ?? ""
const KEY = process.env.LOCAL_SERVICE_ROLE_KEY ?? ""
const isLocal = /^http:\/\/(127\.0\.0\.1|localhost):\d+/.test(URL_) && KEY.length > 0

describe.skipIf(!isLocal)("Tally rollback then re-import (local Postgres)", () => {
  const db = isLocal ? createClient(URL_, KEY, { auth: { persistSession: false } }) : (null as never)
  const applyDb = db as unknown as TallyApplyDb
  const runId = randomUUID().slice(0, 8)
  const tenantId = randomUUID()
  const actorId = randomUUID()
  const companyKey = `zz-company-${runId}`
  const accountIds = new Map<string, string>()

  const voucher: TallyCutoverVoucher = {
    sourceId: `${companyKey}:voucher-1`,
    sourceType: "tally_sale",
    kind: "sales",
    date: "2025-05-10",
    description: "ZZ Sale 1",
    currency: "UGX",
    lines: [
      { accountCode: "1000", accountName: "Cash on hand", debit: 100, credit: 0 },
      { accountCode: "4000", accountName: "Sales revenue", debit: 0, credit: 100 },
    ],
  }
  const plan = {
    company: `ZZ Rollback ${runId}`,
    companyKey,
    currency: "UGX",
    conversionDate: "2025-04-01",
    mode: "opening",
    opening: {
      date: "2025-04-01",
      currency: "UGX",
      lines: [
        { accountCode: "1000", accountName: "Cash on hand", debit: 500, credit: 0 },
        { accountCode: "3000", accountName: "Opening balance equity", debit: 0, credit: 500 },
      ],
      totalDebit: 500,
      totalCredit: 500,
      difference: 0,
    },
    vouchers: [voucher],
    sales: [],
    purchases: [],
  } as unknown as TallyCutoverPlan

  /** Net debit less credit per account code, read back from PostgreSQL. */
  async function balances(): Promise<Record<string, number>> {
    const { data, error } = await db
      .from("pharmacy_accounting_journal_lines")
      .select("account_id, debit, credit")
      .eq("tenant_id", tenantId)
    if (error) throw error
    const codeOf = new Map([...accountIds].map(([code, id]) => [id, code]))
    const totals: Record<string, number> = {}
    for (const line of data ?? []) {
      const code = codeOf.get(line.account_id) ?? line.account_id
      totals[code] = Math.round(((totals[code] ?? 0) + Number(line.debit) - Number(line.credit)) * 100) / 100
    }
    for (const code of Object.keys(totals)) if (totals[code] === 0) delete totals[code]
    return totals
  }

  async function entryCount(): Promise<number> {
    const { count, error } = await db
      .from("pharmacy_accounting_journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
    if (error) throw error
    return count ?? 0
  }

  async function importSession(sessionId: string) {
    const opening = await applyTallyChunk(applyDb, {
      tenantId,
      actorId,
      plan,
      progress: { ...emptyProgress(), stage: "opening-journal" },
      sessionId,
    })
    const journals = await applyTallyChunk(applyDb, {
      tenantId,
      actorId,
      plan,
      progress: { ...emptyProgress(), stage: "journals" },
      chunk: { vouchers: [voucher], sales: [], purchases: [] },
      totalChunks: 1,
      sessionId,
    })
    expect(opening.progress.failures).toEqual([])
    expect(journals.progress.failures).toEqual([])
    return journals
  }

  function rollBack(sessionId: string) {
    return reverseTallyJournals(applyDb, {
      tenantId,
      actorId,
      sessionId,
      vouchers: [tallyOpeningVoucher(plan), voucher],
    })
  }

  const ONE_IMPORT = { "1000": 600, "3000": -500, "4000": -100 }

  beforeAll(async () => {
    const tenant = await db.from("tenants").insert({
      id: tenantId,
      slug: `zz-rollback-${runId}`,
      name: `ZZ Tally Rollback ${runId}`,
      facility_type: "pharmacy",
      district: "Kampala",
      is_active: true,
      status: "active",
      plan: "starter",
    })
    if (tenant.error) throw tenant.error
    const profile = await db.from("profiles").insert({
      id: actorId,
      tenant_id: tenantId,
      email: `zz-rollback-${runId}@example.invalid`,
      full_name: "ZZ Rollback Admin",
      role: "pharmacy_admin",
      verification_status: "verified",
      onboarding_complete: true,
    })
    if (profile.error) throw profile.error
    const seeded = await db.rpc("seed_pharmacy_accounting_accounts", { p_tenant_id: tenantId })
    if (seeded.error) throw seeded.error
    const { data, error } = await db
      .from("pharmacy_accounting_accounts")
      .select("id, code")
      .eq("tenant_id", tenantId)
      .in("code", ["1000", "3000", "4000"])
    if (error) throw error
    for (const row of data ?? []) accountIds.set(row.code, row.id)
    expect(accountIds.size).toBe(3)
  })

  it("imports, rolls back to zero, re-imports to one import's worth, and rolls that back too", async () => {
    await importSession("00000000-0000-4000-8000-000000000001")
    expect(await balances()).toEqual(ONE_IMPORT)

    const first = await rollBack("00000000-0000-4000-8000-000000000001")
    expect(first).toMatchObject({ posted: 2, notPosted: 0, failures: [] })
    expect(await balances()).toEqual({})

    // The bug: the same keys answered "already posted" and the period stayed at zero.
    const again = await importSession("00000000-0000-4000-8000-000000000002")
    expect(again.progress.counts.journals).toBe(1)
    expect(await balances()).toEqual(ONE_IMPORT)

    // A retried re-import writes nothing new.
    const count = await entryCount()
    await importSession("00000000-0000-4000-8000-000000000002")
    expect(await entryCount()).toBe(count)

    // Rolling back the re-import reverses its own entries; retries change nothing.
    const second = await rollBack("00000000-0000-4000-8000-000000000002")
    expect(second).toMatchObject({ posted: 2, failures: [] })
    expect(await balances()).toEqual({})
    const settled = await entryCount()
    await rollBack("00000000-0000-4000-8000-000000000002")
    await rollBack("00000000-0000-4000-8000-000000000001")
    expect(await entryCount()).toBe(settled)
    expect(await balances()).toEqual({})
  })
})
