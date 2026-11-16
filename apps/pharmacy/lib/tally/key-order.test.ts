import { describe, expect, it } from "vitest"
import { forEachInKeyOrder } from "./apply"

const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

describe("forEachInKeyOrder", () => {
  it("keeps each key's items in their original order", async () => {
    const items = ["a1", "b1", "a2", "c1", "b2", "a3", "c2"]
    const seen: string[] = []
    await forEachInKeyOrder(items, (item) => item[0]!, 3, async (item) => {
      await tick()
      seen.push(item)
    })
    for (const key of ["a", "b", "c"]) {
      expect(seen.filter((item) => item.startsWith(key))).toEqual(items.filter((item) => item.startsWith(key)))
    }
    expect(seen).toHaveLength(items.length)
  })

  it("never runs two items of one key at the same time", async () => {
    const running = new Set<string>()
    let overlap = false
    await forEachInKeyOrder(["a1", "a2", "a3", "b1", "b2"], (item) => item[0]!, 4, async (item) => {
      const key = item[0]!
      if (running.has(key)) overlap = true
      running.add(key)
      await tick()
      running.delete(key)
    })
    expect(overlap).toBe(false)
  })

  it("runs different keys side by side, up to the limit", async () => {
    let active = 0
    let peak = 0
    await forEachInKeyOrder(["a", "b", "c", "d", "e"], (item) => item, 2, async () => {
      active += 1
      peak = Math.max(peak, active)
      await tick()
      active -= 1
    })
    expect(peak).toBe(2)
  })

  it("does nothing for an empty list", async () => {
    let calls = 0
    await forEachInKeyOrder([], () => "k", 6, async () => {
      calls += 1
    })
    expect(calls).toBe(0)
  })
})
