import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { parseTallyCsv } from "@/lib/tally/csv"
import { readTallyDocument } from "@/lib/tally/source"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"

const m = vi.hoisted(() => ({ auth: null as unknown }))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))

import { GET } from "./route"

const AUTHORISED = { ok: true, tenantId: "tenant-1", session: { user: { id: "user-1" } } }

function voucherTotals(document: TallyXmlDocument) {
  const voucher = document.vouchers[0]!
  return {
    number: voucher.number,
    debit: voucher.ledgerLines
      .filter((line) => line.side === "debit")
      .reduce((total, line) => total + line.amount, 0),
    credit: voucher.ledgerLines
      .filter((line) => line.side === "credit")
      .reduce((total, line) => total + line.amount, 0),
  }
}

function template(parameters = "") {
  return GET(new NextRequest(`http://localhost/api/admin/tally/template${parameters}`))
}

describe("GET /api/admin/tally/template", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
  })

  it("refuses a session without inventory.write", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    expect((await template()).status).toBe(403)
  })

  it("downloads a CSV template that imports as a balanced example", async () => {
    const res = await template("?format=csv")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8")
    expect(res.headers.get("Content-Disposition")).toContain("tally-import-template.csv")

    const document = parseTallyCsv(await res.text())

    expect(document.company).toBe("Example Pharmacy Ltd")
    expect(document.currency).toBe("UGX")
    expect(document.ledgers.map((ledger) => ledger.name)).toEqual([
      "Example Bank Account",
      "Example Capital Account",
      "Example Cash-in-Hand",
    ])
    expect(voucherTotals(document)).toEqual({
      number: "EXAMPLE-1",
      debit: 1_000_000,
      credit: 1_000_000,
    })
  })

  it("downloads an XLSX template that imports as the same example", async () => {
    const res = await template()

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    expect(res.headers.get("Content-Disposition")).toContain("tally-import-template.xlsx")

    const bytes = new Uint8Array(await res.arrayBuffer())
    const { format, document } = readTallyDocument(bytes, "tally-import-template.xlsx")

    expect(format).toBe("xlsx")
    expect(document.company).toBe("Example Pharmacy Ltd")
    expect(document.ledgers.map((ledger) => ledger.name)).toEqual([
      "Example Bank Account",
      "Example Capital Account",
      "Example Cash-in-Hand",
    ])
    expect(voucherTotals(document)).toEqual({
      number: "EXAMPLE-1",
      debit: 1_000_000,
      credit: 1_000_000,
    })
  })
})
