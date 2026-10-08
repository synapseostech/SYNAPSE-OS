import { describe, expect, it, vi } from "vitest"
import { secureRandomIndex, secureRandomPick } from "./secure-random"

describe("secureRandomIndex (CodeQL js/insecure-randomness #15 #23 #24)", () => {
  it("stays in range and covers every bucket", () => {
    const seen = new Set<number>()
    for (let i = 0; i < 2000; i++) {
      const v = secureRandomIndex(7)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(7)
      seen.add(v)
    }
    expect(seen.size).toBe(7)
  })

  it("uses crypto.getRandomValues, never Math.random", () => {
    const mathSpy = vi.spyOn(Math, "random")
    const cryptoSpy = vi.spyOn(globalThis.crypto, "getRandomValues")
    secureRandomPick(["a", "b", "c"])
    expect(mathSpy).not.toHaveBeenCalled()
    expect(cryptoSpy).toHaveBeenCalled()
    mathSpy.mockRestore()
    cryptoSpy.mockRestore()
  })

  it("rejects invalid sizes and handles empty lists", () => {
    expect(() => secureRandomIndex(0)).toThrow(RangeError)
    expect(secureRandomPick([])).toBeUndefined()
    expect(secureRandomIndex(1)).toBe(0)
  })
})
