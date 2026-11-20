import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Code128Error, code128BValues, code128Modules, code128Svg } from "./barcode-code128.ts"

describe("Code 128 B", () => {
  it("encodes start B, data, mod-103 checksum and stop", () => {
    // Worked example: "Wikipedia" -> checksum 88 (sum of 104 + Σ value·position, mod 103).
    const values = code128BValues("Wikipedia")
    assert.equal(values[0], 104)
    assert.deepEqual(values.slice(1, 10), [..."Wikipedia"].map((c) => c.charCodeAt(0) - 32))
    assert.equal(values[10], 88)
    assert.equal(values[11], 106)
  })

  it("every symbol is 11 modules wide and the stop is 13, starting and ending on a bar", () => {
    const accession = "LAB-20261121-000042"
    const modules = code128Modules(accession)
    const symbols = accession.length + 3
    assert.equal(modules.reduce((a, b) => a + b, 0), (symbols - 1) * 11 + 13)
    assert.equal(modules.length % 2, 1, "odd number of elements: bar ... bar")
  })

  it("renders an SVG whose bars cover exactly the barcode width", () => {
    const svg = code128Svg("LAB-1", { moduleWidth: 2, quiet: 10, height: 40 })
    assert.match(svg, /^<svg /)
    const bars = [...svg.matchAll(/<rect x="(\d+)" y="0" width="(\d+)" height="40"\/>/g)]
    assert.ok(bars.length > 10)
    const last = bars[bars.length - 1]!
    const end = Number(last[1]) + Number(last[2])
    assert.equal(end, 20 + code128Modules("LAB-1").reduce((a, b) => a + b, 0) * 2)
  })

  it("does not put markup from the text into the SVG", () => {
    assert.doesNotMatch(code128Svg(`A"<b>`), /<b>|"<b/)
  })

  it("rejects text it cannot encode", () => {
    assert.throws(() => code128BValues(""), Code128Error)
    assert.throws(() => code128BValues("é"), Code128Error)
    assert.throws(() => code128BValues("x".repeat(49)), Code128Error)
  })
})
