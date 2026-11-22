import { describe, expect, it } from "vitest"
import { ICD11_SEED_CACHE } from "./icd11"
import { ICD11_SHORTHAND, icd11IndexSize, isIcd11Code, lookupIcd11Code, searchIcd11Index } from "./icd11-index"
import { CONDITIONS } from "../intelligence/differential-engine"

describe("WHO ICD-11 MMS index", () => {
  it("holds the full 2026-01 tabulation of diagnosis categories", () => {
    expect(icd11IndexSize()).toBeGreaterThan(15000)
  })

  it("returns WHO's own title and foundation id", () => {
    expect(lookupIcd11Code("1F40")).toMatchObject({
      title: "Malaria due to Plasmodium falciparum",
      foundationUri: "http://id.who.int/icd/entity/579583286",
      release: "2026-01",
    })
    expect(lookupIcd11Code("5a22.0")?.title).toBe("Diabetic ketoacidosis without coma")
  })

  it("knows 5A21 is hypoglycaemia, not DKA (the old seed had this wrong)", () => {
    expect(lookupIcd11Code("5A21")?.title).toBe("Hypoglycaemia in the context of diabetes mellitus")
  })

  it("rejects codes WHO does not publish", () => {
    expect(isIcd11Code("1E08")).toBe(false)
    expect(isIcd11Code("ZZ99")).toBe(false)
    expect(isIcd11Code("")).toBe(false)
  })

  it("has no traditional-medicine, functioning or extension codes", () => {
    for (const code of ["SB31", "XM68M6", "SN46"]) expect(isIcd11Code(code)).toBe(false)
  })

  it("every seed cache entry agrees with WHO", () => {
    for (const e of ICD11_SEED_CACHE) {
      const who = lookupIcd11Code(e.stemCode)
      expect(who, e.stemCode).not.toBeNull()
      expect(e.title, e.stemCode).toBe(who!.title)
      expect(e.foundationUri, e.stemCode).toBe(who!.foundationUri)
    }
  })

  it("every shorthand target is a real code", () => {
    for (const [abbr, codes] of Object.entries(ICD11_SHORTHAND)) {
      for (const code of codes) expect(isIcd11Code(code), `${abbr} -> ${code}`).toBe(true)
    }
  })

  it("every differential-engine code and alternative is WHO's, with WHO's title", () => {
    for (const c of CONDITIONS) {
      for (const ref of [c.icd11, ...(c.icd11Alternatives ?? [])]) {
        const who = lookupIcd11Code(ref.code)
        expect(who, `${c.id} ${ref.code}`).not.toBeNull()
        expect(ref.title, `${c.id} ${ref.code}`).toBe(who!.title)
      }
    }
  })

  describe("search", () => {
    it("finds by code", () => {
      expect(searchIcd11Index("1F40")[0]?.stemCode).toBe("1F40")
      expect(searchIcd11Index("1f40").map((h) => h.stemCode)).toContain("1F40.Z")
    })

    it("finds malaria by name", () => {
      const codes = searchIcd11Index("malaria", 10).map((h) => h.stemCode)
      expect(codes).toContain("1F4Z")
      expect(codes.some((c) => c.startsWith("1F40"))).toBe(true)
    })

    it("understands ward shorthand", () => {
      expect(searchIcd11Index("UTI")[0]?.stemCode).toBe("GC08")
      expect(searchIcd11Index("PUD").map((h) => h.stemCode)).toContain("DA61")
      expect(searchIcd11Index("htn")[0]?.stemCode).toBe("BA00")
    })

    it("matches word prefixes in any order", () => {
      const codes = searchIcd11Index("pneum bacter", 10).map((h) => h.stemCode)
      expect(codes).toContain("CA40.0")
    })

    it("ignores accents and case and caps the result size", () => {
      expect(searchIcd11Index("ANAEMIA", 5)).toHaveLength(5)
      expect(searchIcd11Index("   ")).toEqual([])
    })
  })
})
