import { describe, expect, it } from "vitest"
import { classifyImportFiles } from "./import-classify"

describe("classifyImportFiles", () => {
  it("sends a Tally export to the cut-over", () => {
    expect(classifyImportFiles(["SADIO_TALLY_FULL.zip"])).toEqual({
      target: "tally",
      files: ["SADIO_TALLY_FULL.zip"],
    })
    expect(classifyImportFiles(["2-masters-SADIO.xml"])).toEqual({
      target: "tally",
      files: ["2-masters-SADIO.xml"],
    })
  })

  it("sends a stock sheet to the assistant", () => {
    expect(classifyImportFiles(["stock.csv"]).target).toBe("assistant")
    expect(classifyImportFiles(["stock.xlsx"]).target).toBe("assistant")
    expect(classifyImportFiles(["stock.xls"]).target).toBe("assistant")
    expect(classifyImportFiles(["stock.json"]).target).toBe("assistant")
  })

  it("reads the extension regardless of case and surrounding spaces", () => {
    expect(classifyImportFiles(["  EXPORT.ZIP  "]).target).toBe("tally")
  })

  it("lets several Tally files go together, because one cut-over is many slices", () => {
    const result = classifyImportFiles(["masters.xml", "2025-01.zip"])

    expect(result).toEqual({ target: "tally", files: ["masters.xml", "2025-01.zip"] })
  })

  it("refuses to mix a cut-over with a stock sheet in one import", () => {
    const result = classifyImportFiles(["masters.xml", "stock.csv"])

    expect(result.target).toBeNull()
    if (result.target === null) {
      expect(result.error).toMatch(/cannot be imported together/i)
      expect(result.files).toEqual(["masters.xml", "stock.csv"])
    }
  })

  it("refuses a file it cannot place, naming it", () => {
    const result = classifyImportFiles(["masters.xml", "notes.txt"])

    expect(result.target).toBeNull()
    if (result.target === null) {
      expect(result.error).toContain("notes.txt")
      expect(result.files).toEqual(["notes.txt"])
    }
  })

  it("refuses a file with no extension", () => {
    expect(classifyImportFiles(["export"]).target).toBeNull()
  })

  it("refuses an empty selection", () => {
    expect(classifyImportFiles([]).target).toBeNull()
    expect(classifyImportFiles(["   "]).target).toBeNull()
  })
})
