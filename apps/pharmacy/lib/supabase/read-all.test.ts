import { describe, expect, it } from "vitest"
import { readAllRows } from "./read-all"

/** A query builder over `total` rows that, like PostgREST, caps an un-ranged read. */
function table(total: number, options: { failAt?: number } = {}) {
  const calls: Array<{ range: [number, number]; order: string[] }> = []
  const build = () => {
    const order: string[] = []
    const query: any = {
      order: (column: string) => {
        order.push(column)
        return query
      },
      range: (from: number, to: number) => {
        calls.push({ range: [from, to], order })
        if (options.failAt === from) return Promise.resolve({ data: null, error: { message: "boom" } })
        const rows = Array.from({ length: Math.max(0, Math.min(total, to + 1) - from) }, (_, i) => ({ n: from + i }))
        return Promise.resolve({ data: rows, error: null })
      },
    }
    return query
  }
  return { build, calls }
}

describe("readAllRows", () => {
  it("reads past the first thousand rows", async () => {
    const { build, calls } = table(2_500)
    const result = await readAllRows<{ n: number }>(build)
    expect(result.error).toBeNull()
    expect(result.data).toHaveLength(2_500)
    expect(result.data.at(-1)).toEqual({ n: 2_499 })
    expect(calls.map((call) => call.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ])
  })

  it("stops after one read when the first page is short", async () => {
    const { build, calls } = table(3)
    expect((await readAllRows(build)).data).toHaveLength(3)
    expect(calls).toHaveLength(1)
  })

  it("asks for one more page when the count is an exact multiple", async () => {
    const { build, calls } = table(2_000)
    expect((await readAllRows(build)).data).toHaveLength(2_000)
    expect(calls).toHaveLength(3)
  })

  it("adds an id tie-break so equal sort values cannot move between pages", async () => {
    const { build, calls } = table(10)
    await readAllRows(build)
    expect(calls[0]!.order).toEqual(["id"])
  })

  it("can drop the tie-break for a read with no id column", async () => {
    const { build, calls } = table(10)
    await readAllRows(build, { tieBreak: null })
    expect(calls[0]!.order).toEqual([])
  })

  it("returns the error instead of a silently partial total", async () => {
    const { build } = table(2_500, { failAt: 1000 })
    const result = await readAllRows(build)
    expect(result.error).toEqual({ message: "boom" })
  })

  it("reads a first-N list past a thousand without error, and no further", async () => {
    const { build, calls } = table(5_000)
    const result = await readAllRows<{ n: number }>(build, { limit: 1_500 })
    expect(result.error).toBeNull()
    expect(result.data).toHaveLength(1_500)
    expect(calls.map((call) => call.range)).toEqual([
      [0, 999],
      [1000, 1499],
    ])
  })

  it("fails loudly past the row ceiling", async () => {
    const { build } = table(5_000)
    const result = await readAllRows(build, { pageSize: 1000, maxRows: 2_000 })
    expect(result.error?.message).toMatch(/^READ_ALL_LIMIT/)
  })
})
