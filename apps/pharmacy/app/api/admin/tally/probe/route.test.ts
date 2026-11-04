import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireTallyAdmin } = vi.hoisted(() => ({ requireTallyAdmin: vi.fn() }))

vi.mock("@/lib/tally/auth", () => ({
  requireTallyAdmin: (...args: unknown[]) => requireTallyAdmin(...args),
}))

import { POST } from "./route"

const AUTHORISED = { ok: true as const }

function probe(xml: string, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://pharm.test/api/admin/tally/probe", {
      method: "POST",
      headers: { "content-type": "text/xml", ...headers },
      body: xml,
    }) as any,
  )
}

function exportWith(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE><BODY><DATA><TALLYMESSAGE>${inner}</TALLYMESSAGE></DATA></BODY></ENVELOPE>`
}

describe("POST /api/admin/tally/probe", () => {
  beforeEach(() => {
    requireTallyAdmin.mockReset()
    requireTallyAdmin.mockResolvedValue(AUTHORISED)
  })

  it("returns the auth failure unchanged and reads nothing", async () => {
    const denied = NextResponse.json({ error: "Admin only" }, { status: 403 })
    requireTallyAdmin.mockResolvedValue({ ok: false, response: denied })

    const res = await probe(exportWith("<VOUCHER VCHTYPE=\"Sales\" />"))

    expect(res.status).toBe(403)
    expect(requireTallyAdmin).toHaveBeenCalledWith(expect.anything(), "inventory.write")
  })

  it("refuses an empty body", async () => {
    const res = await probe("   ")

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TALLY_PROBE_EMPTY")
  })

  it("refuses a declared size over the ceiling before reading the body", async () => {
    const res = await probe("", { "content-length": String(5 * 1024 * 1024) })

    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe("TALLY_PROBE_TOO_LARGE")
  })

  it("reports an incomplete export as a bad file, not an empty one", async () => {
    const res = await probe("<?xml version=\"1.0\"?><ENVELOPE><BODY>")

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.code).toBe("MIGRATION_XML_INCOMPLETE")
    expect(body.report).toBeUndefined()
  })

  it("answers Gate 0 from a complete export", async () => {
    const res = await probe(
      exportWith(`
        <VOUCHER VCHTYPE="Sales"><DATE>20260201</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Delivery Note"><DATE>20260202</DATE><REFERENCE>S-1</REFERENCE></VOUCHER>
      `),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.report.vouchers).toBe(2)
    const delivery = body.report.types.find((type: { type: string }) => type.type === "Delivery Note")
    expect(delivery.stagedByLedgerImport).toBe(false)
    expect(delivery.linkage.find((tag: { tag: string }) => tag.tag === "REFERENCE").vouchers).toBe(1)
  })
})
