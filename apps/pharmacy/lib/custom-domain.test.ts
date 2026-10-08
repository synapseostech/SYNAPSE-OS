import { describe, expect, it } from "vitest"
import { normalizeDomain } from "./custom-domain"

describe("normalizeDomain (CodeQL js/polynomial-redos #2)", () => {
  it("normalises scheme, path, port and case", () => {
    expect(normalizeDomain("HTTPS://Pharm.Example.co.ug/portal?x=1")).toBe("pharm.example.co.ug")
    expect(normalizeDomain("pharm.example.com:8443")).toBe("pharm.example.com")
    expect(normalizeDomain("  shop.example.org  ")).toBe("shop.example.org")
  })

  it("rejects non-hostnames", () => {
    expect(normalizeDomain("not a domain")).toBeNull()
    expect(normalizeDomain("")).toBeNull()
    expect(normalizeDomain(42)).toBeNull()
    expect(normalizeDomain("localhost")).toBeNull()
  })

  it("is fast on adversarial slash floods and oversize input", () => {
    const start = Date.now()
    expect(normalizeDomain("/" + "/".repeat(100_000))).toBeNull()
    expect(normalizeDomain("a.com" + "/".repeat(1_000))).toBe("a.com")
    expect(normalizeDomain("x".repeat(5_000) + ".com")).toBeNull()
    expect(Date.now() - start).toBeLessThan(200)
  })
})
