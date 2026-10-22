import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { escapeHtml, safeImageSrc } from "./html"

const PAYLOADS = [
  `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `'><svg onload=alert(1)>`,
  `</div><iframe src="javascript:alert(1)"></iframe>`,
]

describe("escapeHtml (print documents, CodeQL js/xss-through-dom #10 #25)", () => {
  it.each(PAYLOADS)("neutralises %s", (payload) => {
    const out = escapeHtml(payload)
    expect(out).not.toMatch(/[<>"']/)
    expect(out).toContain("&lt;")
  })

  it("keeps ordinary pharmacy text readable", () => {
    expect(escapeHtml("Kampala Road, Plot 12 & 14")).toBe("Kampala Road, Plot 12 &amp; 14")
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(3)).toBe("3")
  })
})

describe("safeImageSrc", () => {
  it("accepts raster data URLs, https and same-origin paths", () => {
    expect(safeImageSrc("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=")
    expect(safeImageSrc("https://cdn.example.com/logo.png")).toBe("https://cdn.example.com/logo.png")
    expect(safeImageSrc("/logo.png")).toBe("/logo.png")
  })

  it.each([
    "javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/svg+xml;base64,PHN2Zz4=",
    'data:image/png;base64,AAAA" onerror="alert(1)',
    "http://insecure.example.com/logo.png",
    "//evil.example.com/x.png",
    "",
    42,
  ])("rejects %s", (value) => {
    expect(safeImageSrc(value)).toBeNull()
  })

  it("escapes quotes that survive URL parsing", () => {
    const out = safeImageSrc(`https://cdn.example.com/a.png?x="><script>`)
    expect(out).not.toBeNull()
    expect(out).not.toMatch(/["<>]/)
  })
})

describe("print-window builders escape tenant/customer data", () => {
  // Static regression guard: inside every HTML document template handed to
  // document.write(), interpolations of tenant/customer-controlled values must
  // go through escapeHtml() (or safeImageSrc for <img src>).
  const files = ["app/portal/orders/page.tsx", "app/portal/settings/page.tsx"]
  const untrustedRoot = /^(?:settings|order|item|pharmacyName|location|contact|email|footerText|notes|logoPreview)\b/

  function printTemplates(src: string): string[] {
    const out: string[] = []
    const re = /<!doctype html>[\s\S]*?<\/html>/gi
    for (const m of src.matchAll(re)) out.push(m[0])
    return out
  }

  it.each(files)("%s has no raw interpolation of untrusted fields", (rel) => {
    const src = readFileSync(join(__dirname, "..", rel), "utf8")
    const templates = printTemplates(src)
    expect(templates.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const t of templates) {
      for (const m of t.matchAll(/\$\{\s*([A-Za-z_][\w.?]*)(\s*(?:\?(?!\.)|===))?/g)) {
        const [, path, condition] = m
        // `${x ? `...` : ""}` / `${x === "58" ? "58mm" : ...}`: x is only a
        // condition; the emitted branches are literals or checked separately.
        if (condition) continue
        if (untrustedRoot.test(path) && !/^item\.(?:quantity|unitPrice|totalPrice)$/.test(path)) offenders.push(m[0])
      }
    }
    expect(offenders).toEqual([])
  })

  it("the guard catches an unescaped field", () => {
    const sample = "<!doctype html><html><div>${settings.footerText}</div></html>"
    const hits = [...sample.matchAll(/\$\{\s*([A-Za-z_][\w.?]*)/g)].map((m) => m[1])
    expect(hits.some((p) => untrustedRoot.test(p))).toBe(true)
  })
})
