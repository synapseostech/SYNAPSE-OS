import { describe, expect, it } from "vitest"
import { allocateFefoBatches, expiryTone } from "./fefo"

const today = "2026-07-20"

const batches = [
  {
    id: "b-late",
    batchNumber: "LATER",
    quantity: 10,
    expiryDate: "2027-01-01",
    manufacturer: "Cipla",
    sellingPrice: 120,
  },
  {
    id: "b-soon",
    batchNumber: "SOON",
    quantity: 3,
    expiryDate: "2026-08-01",
    manufacturer: "GSK",
    sellingPrice: 100,
  },
  {
    id: "b-expired",
    batchNumber: "DEAD",
    quantity: 50,
    expiryDate: "2026-01-01",
    manufacturer: null,
  },
]

describe("FEFO allocateFefoBatches", () => {
  it("skips expired and takes earliest expiry first", () => {
    const alloc = allocateFefoBatches(batches, 5, today)
    expect(alloc).toHaveLength(2)
    expect(alloc[0]).toMatchObject({ batchNumber: "SOON", quantity: 3 })
    expect(alloc[0]).toMatchObject({ sellingPrice: 100 })
    expect(alloc[1]).toMatchObject({ batchNumber: "LATER", quantity: 2, sellingPrice: 120 })
  })

  it("returns partial allocation when stock is short", () => {
    const alloc = allocateFefoBatches(batches, 100, today)
    const total = alloc.reduce((s, a) => s + a.quantity, 0)
    expect(total).toBe(13)
  })

  it("returns empty when all batches are expired", () => {
    const alloc = allocateFefoBatches(
      [{ id: "x", batchNumber: "X", quantity: 20, expiryDate: "2020-01-01" }],
      5,
      today,
    )
    expect(alloc).toEqual([])
  })

  it("returns empty for non-positive quantity", () => {
    expect(allocateFefoBatches(batches, 0, today)).toEqual([])
    expect(allocateFefoBatches(batches, -3, today)).toEqual([])
  })

  it("prefers dated batches before null-expiry when dates are earlier", () => {
    const alloc = allocateFefoBatches(
      [
        { id: "null", batchNumber: "NONE", quantity: 5, expiryDate: null },
        { id: "soon", batchNumber: "SOON", quantity: 2, expiryDate: "2026-08-01" },
      ],
      3,
      today,
    )
    expect(alloc[0]?.batchNumber).toBe("SOON")
    expect(alloc[1]?.batchNumber).toBe("NONE")
    expect(alloc[1]?.quantity).toBe(1)
  })

  it("never selects a recalled-style zero-quantity batch", () => {
    const alloc = allocateFefoBatches(
      [
        { id: "empty", batchNumber: "E", quantity: 0, expiryDate: "2026-08-01" },
        { id: "ok", batchNumber: "OK", quantity: 4, expiryDate: "2026-09-01" },
      ],
      2,
      today,
    )
    expect(alloc).toHaveLength(1)
    expect(alloc[0]?.batchNumber).toBe("OK")
  })
})

describe("expiryTone", () => {
  it("classifies windows used by POS badges", () => {
    expect(expiryTone("2027-07-20", today)).toBe("ok")
    expect(expiryTone("2026-12-01", today)).toBe("warn")
    expect(expiryTone("2026-08-01", today)).toBe("critical")
    expect(expiryTone("2026-01-01", today)).toBe("expired")
    expect(expiryTone(null, today)).toBe("unknown")
  })
})
