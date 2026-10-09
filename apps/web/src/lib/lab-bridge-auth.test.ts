import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { hashBridgeSecret, issueBridgeSecret } from "@synapse/db/lab-device-intelligence"

const HMAC = "lab-bridge-test-hmac-secret"
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DEVICE = "11111111-1111-4111-8111-111111111111"

type BridgeRow = {
  id: string
  tenant_id: string
  name?: string
  is_active: boolean
  device_id: string | null
  revoked_at?: string | null
  api_key?: string | null
  api_key_hash?: string | null
  api_key_prefix?: string | null
}

function matches(row: BridgeRow, filters: Array<{ kind: "eq" | "is" | "not"; col: string; val: unknown }>) {
  return filters.every((filter) => {
    const value = (row as Record<string, unknown>)[filter.col]
    if (filter.kind === "eq") return value === filter.val
    if (filter.kind === "is") return (value ?? null) === filter.val
    if (filter.kind === "not" && filter.val === null) return value != null
    return true
  })
}

function mockDb(rows: BridgeRow[]) {
  return {
    from: (table: string) => {
      if (table !== "lab_instrument_bridges") throw new Error(`unexpected table ${table}`)
      const filters: Array<{ kind: "eq" | "is" | "not"; col: string; val: unknown }> = []
      const api: Record<string, unknown> = {}
      const self = () => api
      api.select = vi.fn(self)
      api.eq = vi.fn((col: string, val: unknown) => { filters.push({ kind: "eq", col, val }); return api })
      api.is = vi.fn((col: string, val: unknown) => { filters.push({ kind: "is", col, val }); return api })
      api.not = vi.fn((col: string, _op: string, val: unknown) => { filters.push({ kind: "not", col, val }); return api })
      api.limit = vi.fn(self)
      // Awaiting the builder (list query) resolves every matching row.
      api.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: rows.filter((row) => matches(row, filters)), error: null })
      api.maybeSingle = vi.fn(async () => {
        const found = rows.filter((row) => matches(row, filters))
        return { data: found[0] ?? null, error: found.length > 1 ? { message: "multiple" } : null }
      })
      return api
    },
  }
}

describe("lookupLabBridge", () => {
  const issuedA = issueBridgeSecret(HMAC)
  const issuedB = issueBridgeSecret(HMAC)
  const modern: BridgeRow = {
    id: "bridge-modern",
    tenant_id: TENANT,
    is_active: true,
    device_id: DEVICE,
    revoked_at: null,
    api_key: null,
    api_key_hash: issuedA.hash,
    api_key_prefix: issuedA.prefix,
  }
  const revoked: BridgeRow = {
    ...modern,
    id: "bridge-revoked",
    is_active: false,
    revoked_at: "2026-09-20T20:00:00.000Z",
    api_key_hash: hashBridgeSecret("lbk_oldrevokedsecret________", HMAC),
  }
  const bothPopulated: BridgeRow = {
    id: "bridge-both",
    tenant_id: TENANT,
    is_active: true,
    device_id: DEVICE,
    revoked_at: null,
    api_key: `ref:${DEVICE}:${issuedA.prefix}`,
    api_key_hash: issuedA.hash,
    api_key_prefix: issuedA.prefix,
  }
  const legacy: BridgeRow = {
    id: "bridge-legacy",
    tenant_id: TENANT,
    is_active: true,
    device_id: DEVICE,
    revoked_at: null,
    api_key: "legacy-secret",
    api_key_hash: null,
  }

  beforeEach(() => {
    process.env.LAB_BRIDGE_HASH_SECRET = HMAC
    vi.resetModules()
  })
  afterEach(() => {
    delete process.env.LAB_BRIDGE_HASH_SECRET
    vi.resetModules()
    vi.doUnmock("@synapse/db/admin")
  })

  async function load(rows: BridgeRow[]) {
    vi.doMock("@synapse/db/admin", () => ({ supabaseAdmin: mockDb(rows) }))
    return import("./lab-bridge-auth")
  }

  it("accepts the real issued modern secret and rejects prefix, placeholder, and wrong secrets", async () => {
    const { lookupLabBridgeDetailed } = await load([modern, revoked, legacy])
    expect((await lookupLabBridgeDetailed(issuedA.secret)).ok).toBe(true)
    expect((await lookupLabBridgeDetailed("wrong-secret")).ok).toBe(false)
    expect((await lookupLabBridgeDetailed(issuedA.prefix)).ok).toBe(false)
    expect((await lookupLabBridgeDetailed(`ref:${DEVICE}:${issuedA.prefix}`)).ok).toBe(false)
    expect((await lookupLabBridgeDetailed("ref:random:value")).ok).toBe(false)
  })

  it("revokes the old secret and accepts only the newly issued secret", async () => {
    const rotated: BridgeRow[] = [
      { ...modern, is_active: false, revoked_at: "2026-09-20T21:00:00.000Z" },
      { ...modern, id: "bridge-new", api_key_hash: issuedB.hash, api_key_prefix: issuedB.prefix, api_key: null, is_active: true, revoked_at: null },
    ]
    const { lookupLabBridgeDetailed } = await load(rotated)
    expect((await lookupLabBridgeDetailed(issuedA.secret)).ok).toBe(false)
    const next = await lookupLabBridgeDetailed(issuedB.secret)
    expect(next.ok).toBe(true)
    if (next.ok) expect(next.bridge.id).toBe("bridge-new")
  })

  it("allows legacy plaintext only when api_key_hash is null", async () => {
    const { lookupLabBridgeDetailed } = await load([legacy, bothPopulated])
    const legacyHit = await lookupLabBridgeDetailed("legacy-secret")
    expect(legacyHit.ok).toBe(true)
    const placeholder = await lookupLabBridgeDetailed(`ref:${DEVICE}:${issuedA.prefix}`)
    expect(placeholder.ok).toBe(false)
    const hashedRowPlaintext = await lookupLabBridgeDetailed(`ref:${DEVICE}:${issuedA.prefix}`)
    expect(hashedRowPlaintext.ok).toBe(false)
  })

  it("never authenticates a hashed row through api_key even if both columns are populated", async () => {
    const { lookupLabBridgeDetailed } = await load([bothPopulated])
    expect((await lookupLabBridgeDetailed(`ref:${DEVICE}:${issuedA.prefix}`)).ok).toBe(false)
    expect((await lookupLabBridgeDetailed(issuedA.secret)).ok).toBe(true)
  })

  it("refuses legacy single-round HMAC digests with rotation_required (CodeQL #8)", async () => {
    const legacyDigestRow: BridgeRow = { ...modern, id: "bridge-legacy-digest", api_key_hash: "f".repeat(64) }
    const { lookupLabBridgeDetailed } = await load([legacyDigestRow])
    expect(await lookupLabBridgeDetailed(issuedA.secret)).toEqual({ ok: false, reason: "rotation_required" })
  })

  it("only verifies candidates sharing the presented prefix and never matches another bridge's hash", async () => {
    const other: BridgeRow = { ...modern, id: "bridge-other", api_key_hash: issuedB.hash, api_key_prefix: issuedB.prefix }
    const { lookupLabBridgeDetailed } = await load([other])
    expect((await lookupLabBridgeDetailed(issuedA.secret)).ok).toBe(false)
    const forged: BridgeRow = { ...modern, id: "bridge-forged", api_key_hash: issuedB.hash, api_key_prefix: issuedA.prefix }
    const forgedLookup = await load([forged])
    expect((await forgedLookup.lookupLabBridgeDetailed(issuedA.secret)).ok).toBe(false)
  })

  it("fails closed when the HMAC secret is missing instead of using plaintext on hashed rows", async () => {
    delete process.env.LAB_BRIDGE_HASH_SECRET
    const { lookupLabBridgeDetailed } = await load([modern, legacy])
    const modernMiss = await lookupLabBridgeDetailed(issuedA.secret)
    expect(modernMiss).toEqual({ ok: false, reason: "hash_unavailable" })
    const legacyHit = await lookupLabBridgeDetailed("legacy-secret")
    expect(legacyHit.ok).toBe(true)
  })
})
