import { afterEach, describe, expect, it, vi } from "vitest"
import { verifyTotp } from "./totp"

// RFC 6238 Appendix B vector: secret "12345678901234567890", T=59s -> 94287082 (6-digit: 287082)
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

describe("TOTP secret decoding (CodeQL js/polynomial-redos #3)", () => {
  afterEach(() => vi.useRealTimers())

  it("verifies the RFC vector with padding, whitespace and lowercase preserved as before", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(59_000)
    expect(await verifyTotp(RFC_SECRET, "287082")).toBe(true)
    expect(await verifyTotp(`${RFC_SECRET}====`, "287082")).toBe(true)
    expect(await verifyTotp(RFC_SECRET.match(/.{1,4}/g)!.join(" ").toLowerCase(), "287082")).toBe(true)
    expect(await verifyTotp(RFC_SECRET, "287083")).toBe(false)
  })

  it("handles '=' floods in linear time", async () => {
    const start = Date.now()
    expect(await verifyTotp("GEZDGNBV" + "=".repeat(200_000) + "GEZDGNBV", "123456")).toBeTypeOf("boolean")
    expect(await verifyTotp("GEZDGNBV" + "=".repeat(200_000), "123456")).toBeTypeOf("boolean")
    expect(Date.now() - start).toBeLessThan(500)
  })
})
