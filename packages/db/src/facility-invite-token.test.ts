import { describe, expect, it } from "vitest"
import {
  facilityInviteTokenMatches,
  findFacilityInvitationByToken,
  generateFacilityInviteToken,
  hashFacilityInviteToken,
  isPlausibleFacilityInviteToken,
} from "./facility-invite-token"

type FakeQuery = {
  select: () => FakeQuery
  eq: (column: string, value: unknown) => FakeQuery
  maybeSingle: () => Promise<{ data: Record<string, unknown> | null; error: null }>
}

function fakeDb(rows: Array<Record<string, unknown>>) {
  return {
    from: () => {
      const filters: Array<[string, unknown]> = []
      const q: FakeQuery = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push([c, v]), q),
        maybeSingle: async () => ({ data: rows.find((r) => filters.every(([c, v]) => r[c] === v)) ?? null, error: null }),
      }
      return q
    },
  }
}

describe("facility invite token", () => {
  it("is 32 crypto-random bytes, hex, never repeating", () => {
    const a = generateFacilityInviteToken()
    const b = generateFacilityInviteToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
  it("stores only a SHA-256 hash and compares it in constant time", () => {
    const t = generateFacilityInviteToken()
    const h = hashFacilityInviteToken(t)
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain(t)
    expect(facilityInviteTokenMatches(t, h)).toBe(true)
    expect(facilityInviteTokenMatches(t + "x", h)).toBe(false)
    expect(facilityInviteTokenMatches(t, null)).toBe(false)
  })
  it("matches the SQL backfill expression (sha256 hex of UTF-8)", () => {
    // select encode(sha256(convert_to('abc','UTF8')),'hex')
    expect(hashFacilityInviteToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
  })
  it("valid token resolves; invalid, malformed and the stored hash itself do not", async () => {
    const t = generateFacilityInviteToken()
    const h = hashFacilityInviteToken(t)
    const db = fakeDb([{ id: "i1", status: "SENT", token_hash: h, invite_token: null }])
    const ok = await findFacilityInvitationByToken(db, t, "id, status")
    expect(ok?.invite).toEqual({ id: "i1", status: "SENT" })
    expect(ok?.storage).toBe("token_hash")
    expect(JSON.stringify(ok)).not.toContain(h)
    expect(await findFacilityInvitationByToken(db, generateFacilityInviteToken(), "id")).toBeNull()
    expect(await findFacilityInvitationByToken(db, h, "id")).toBeNull() // DB leak ≠ credential
    expect(await findFacilityInvitationByToken(db, "short", "id")).toBeNull()
    expect(await findFacilityInvitationByToken(db, "a'; drop table x;--aaaaaaaaaaaaaaaaaaaaaaaaaaaa", "id")).toBeNull()
  })
  it("still honours a pre-backfill plaintext row (deploy-before-migration window)", async () => {
    const t = generateFacilityInviteToken()
    const db = fakeDb([{ id: "legacy", status: "PENDING", token_hash: null, invite_token: t }])
    const r = await findFacilityInvitationByToken(db, t, "id, status")
    expect(r?.storage).toBe("invite_token")
    expect(r?.invite).toEqual({ id: "legacy", status: "PENDING" })
  })
  it("plausibility gate", () => {
    expect(isPlausibleFacilityInviteToken(generateFacilityInviteToken())).toBe(true)
    expect(isPlausibleFacilityInviteToken(undefined)).toBe(false)
    expect(isPlausibleFacilityInviteToken("x".repeat(200))).toBe(false)
  })
})
