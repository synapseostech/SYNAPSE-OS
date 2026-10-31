import { describe, expect, it } from "vitest"
import { formatImportRows, parseImportRows } from "./import-rows"

describe("import row text conversion", () => {
  it("preserves commas, quotes, and line breaks inside spreadsheet cells", () => {
    const rows = [
      ["Product name", "Batch", "Quantity"],
      ['Paracetamol, "Extra"', "B-1\nB-2", "10"],
    ]

    expect(parseImportRows(formatImportRows(rows))).toEqual(rows)
  })

  it("reads a basic manually pasted comma-separated row", () => {
    expect(parseImportRows("Panadol 500mg, 120, 500")).toEqual([
      ["Panadol 500mg", " 120", " 500"],
    ])
  })
})
