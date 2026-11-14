import { describe, expect, it } from "vitest"
import { kindFromFileName, periodFromFileName } from "./file-names"

describe("periodFromFileName", () => {
  it("reads both days of a slice export", () => {
    expect(periodFromFileName("3-daybook-20250101-20250331.xml")).toEqual({
      from: "2025-01-01",
      to: "2025-03-31",
    })
  })

  it("reads a Tally month export as the calendar month it covers", () => {
    expect(periodFromFileName("2025-10-full.xml")).toEqual({ from: "2025-10-01", to: "2025-10-31" })
  })

  it("ends a month export on the month's real last day", () => {
    expect(periodFromFileName("2025-02-full.xml")).toEqual({ from: "2025-02-01", to: "2025-02-28" })
    expect(periodFromFileName("2024-02-full.xml")).toEqual({ from: "2024-02-01", to: "2024-02-29" })
    expect(periodFromFileName("2026-11-full.xml")).toEqual({ from: "2026-11-01", to: "2026-11-30" })
  })

  it("reads a month export named with a prefix", () => {
    expect(periodFromFileName("SADIO-2025-12-full.xml")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    })
  })

  it("does not stretch a single named day into a month", () => {
    expect(periodFromFileName("2025-10-01.xml")).toBeUndefined()
  })

  it("refuses a month that is not a month", () => {
    expect(periodFromFileName("2025-13-full.xml")).toBeUndefined()
  })

  it("ignores a name with no dates", () => {
    expect(periodFromFileName("export.xml")).toBeUndefined()
  })
})

describe("kindFromFileName", () => {
  it("recognises the masters export by name", () => {
    expect(kindFromFileName("2-masters-20251001.xml")).toBe("masters")
  })

  it("recognises a day book by name", () => {
    expect(kindFromFileName("3-daybook-20250101-20251231.xml")).toBe("vouchers")
  })

  it("leaves a month export unclassified so its contents decide", () => {
    expect(kindFromFileName("2025-10-full.xml")).toBeUndefined()
  })
})
