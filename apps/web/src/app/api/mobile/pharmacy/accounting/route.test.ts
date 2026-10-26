import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

const state = {
  tables: {} as Record<string, unknown[]>,
  single: {} as Record<string, unknown>,
}

const rpc = vi.hoisted(() => vi.fn())

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.eq = self
      builder.in = self
      builder.lte = self
      builder.gte = self
      builder.order = self
      builder.limit = () => Promise.resolve({ data: state.tables[table] ?? [], error: null })
      builder.maybeSingle = () => Promise.resolve({ data: state.single[table] ?? null, error: null })
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: state.tables[table] ?? [], error: null }).then(resolve)
      return builder
    },
  },
}))

import { GET, POST } from "./route"

const CASH = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "1000",
  name: "Cash on hand",
  account_type: "asset",
  normal_balance: "debit",
  system_key: "CASH_ON_HAND",
  is_system: true,
  is_active: true,
}
const EXPENSE = {
  id: "22222222-2222-4222-8222-222222222222",
  code: "6000",
  name: "Utilities",
  account_type: "expense",
  normal_balance: "debit",
  system_key: null,
  is_system: false,
  is_active: true,
}

function auth(role = "pharmacy_admin", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function get(from = "2026-10-01", to = "2026-10-31") {
  return new Request(
    `https://app.test/api/mobile/pharmacy/accounting?from=${from}&to=${to}`,
  ) as never
}

function post(body: unknown) {
  return new Request("https://app.test/api/mobile/pharmacy/accounting", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

const VALID_PAYMENT = {
  voucherType: "payment",
  entryDate: "2026-10-20",
  description: "Paid the water bill",
  idempotencyKey: "key-1",
  lines: [
    { accountId: EXPENSE.id, debit: 1200, credit: 0 },
    { accountId: CASH.id, debit: 0, credit: 1200 },
  ],
}

describe("mobile pharmacy accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.tables = { pharmacy_accounting_accounts: [CASH, EXPENSE] }
    state.single = { pharmacy_settings: { currency: "UGX" } }
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === "object" &&
        !(value instanceof NextResponse) &&
        "tenantId" in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
    rpc.mockImplementation((fn: string) =>
      Promise.resolve({
        data: fn === "pharmacy_accounting_trial_balance" ? [] : null,
        error: null,
      }),
    )
  })

  it("denies the overview without the financial reports permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
  })

  it("returns the chart of accounts in the shape the app expects", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accounts[0]).toMatchObject({
      id: CASH.id,
      code: "1000",
      accountType: "asset",
      normalBalance: "debit",
      systemKey: "CASH_ON_HAND",
      isSystem: true,
    })
  })

  it("denies posting without the financial reports permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await POST(post(VALID_PAYMENT))

    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("rejects an unknown voucher type", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(post({ ...VALID_PAYMENT, voucherType: "sales" }))

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("refuses a payment whose cash line is a debit", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(
      post({
        ...VALID_PAYMENT,
        lines: [
          { accountId: CASH.id, debit: 1200, credit: 0 },
          { accountId: EXPENSE.id, debit: 0, credit: 1200 },
        ],
      }),
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("credit line") })
    expect(rpc).not.toHaveBeenCalledWith(
      "post_pharmacy_accounting_journal",
      expect.anything(),
    )
  })

  it("posts a valid voucher with the token profile as author", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({
      data: { id: "entry-1", entry_no: "JV-0001", replayed: false },
      error: null,
    })

    const res = await POST(post(VALID_PAYMENT))

    expect(res.status).toBe(201)
    expect(rpc).toHaveBeenCalledWith(
      "post_pharmacy_accounting_journal",
      expect.objectContaining({
        p_tenant_id: "tenant-a",
        p_source_type: "manual",
        p_source_id: "manual:payment:key-1",
        p_entry_date: "2026-10-20",
        p_currency: "UGX",
        p_created_by: "user-1",
        p_lines: [
          { account_id: EXPENSE.id, debit: 1200, credit: 0, description: "" },
          { account_id: CASH.id, debit: 0, credit: 1200, description: "" },
        ],
      }),
    )
  })

  it("answers a replay with 200 instead of creating a second entry", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({
      data: { id: "entry-1", entry_no: "JV-0001", replayed: true },
      error: null,
    })

    const res = await POST(post(VALID_PAYMENT))

    expect(res.status).toBe(200)
  })

  it("maps a closed period to a conflict", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({
      data: null,
      error: { message: "ACCOUNTING_PERIOD_CLOSED: 2026-10-20" },
    })

    const res = await POST(post(VALID_PAYMENT))

    expect(res.status).toBe(409)
  })

  it("rejects an account that is not in this pharmacy's chart", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await POST(
      post({
        ...VALID_PAYMENT,
        lines: [
          { accountId: "33333333-3333-4333-8333-333333333333", debit: 1200, credit: 0 },
          { accountId: CASH.id, debit: 0, credit: 1200 },
        ],
      }),
    )

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalledWith(
      "post_pharmacy_accounting_journal",
      expect.anything(),
    )
  })
})
