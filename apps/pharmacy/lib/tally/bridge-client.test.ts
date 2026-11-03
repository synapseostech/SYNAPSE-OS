import { describe, expect, it } from "vitest"
import {
  TallyBridgeError,
  bridgePeriodFromFields,
  requestBridgeExport,
} from "./bridge-client"

const january = { from: "2026-01-01", to: "2026-01-31" }

function bridgeFetch(input: {
  xml?: string
  status?: number
  headers?: Record<string, string>
  body?: unknown
}) {
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    if (input.body !== undefined) {
      return new Response(JSON.stringify(input.body), {
        status: input.status ?? 200,
        headers: { "content-type": "application/json" },
      })
    }
    return new Response(input.xml ?? "<ENVELOPE><BODY><DATA><VOUCHER/></DATA></BODY></ENVELOPE>", {
      status: input.status ?? 200,
      headers: {
        "content-type": "application/xml",
        ...(input.headers ?? {}),
      },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

function echo(
  from = "20260101",
  to = "20260131",
  company = "Test Pharmacy",
  mode = "opening",
  scope = "all",
) {
  return {
    "x-synapse-tally-from": from,
    "x-synapse-tally-to": to,
    "x-synapse-tally-company": company,
    "x-synapse-tally-mode": mode,
    "x-synapse-tally-scope": scope,
  }
}

async function failure(promise: Promise<unknown>): Promise<TallyBridgeError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TallyBridgeError) return error
    throw error
  }
  throw new Error("expected the export to be refused")
}

describe("bridge export period", () => {
  it("sends the requested period and accepts an exact echo", async () => {
    const { fetchImpl, calls } = bridgeFetch({ headers: echo() })

    const result = await requestBridgeExport({
      token: "t",
      mode: "opening",
      company: "Test Pharmacy",
      period: january,
      fetchImpl,
    })

    expect(calls[0]).toContain("from=20260101")
    expect(calls[0]).toContain("to=20260131")
    expect(calls[0]).toContain("company=Test+Pharmacy")
    expect(result.period).toEqual(january)
    expect(result.company).toBe("Test Pharmacy")
  })

  it("refuses an export whose start date differs from the request", async () => {
    const { fetchImpl } = bridgeFetch({ headers: echo("20251201", "20260131") })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_PERIOD_MISMATCH")
  })

  it("refuses an export whose end date differs from the request", async () => {
    const { fetchImpl } = bridgeFetch({ headers: echo("20260101", "20260228") })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_PERIOD_MISMATCH")
  })

  it("refuses an export that states no period at all", async () => {
    // An older bridge, or a proxy that stripped the headers, cannot prove
    // what it exported, so the payload never reaches the preview.
    const { fetchImpl } = bridgeFetch({
      headers: {
        "x-synapse-tally-company": "Test Pharmacy",
        "x-synapse-tally-mode": "opening",
      },
    })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_PERIOD_UNVERIFIED")
  })

  it("never exports when the operator has not stated a period", async () => {
    const { fetchImpl, calls } = bridgeFetch({ headers: echo() })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: undefined,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_PERIOD_NOT_REQUESTED")
    expect(calls).toHaveLength(0)
  })

  it("does not accept an old bridge's launch period after the page's dates change", async () => {
    // The page now asks for January, but the process was started for December
    // and ignores per-request dates. Its echo says December, and the client
    // refuses rather than importing December as though it were January.
    const { fetchImpl } = bridgeFetch({ headers: echo("20251201", "20251231") })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_PERIOD_MISMATCH")
  })

  it("accepts a restarted bridge that honours the page's new dates", async () => {
    const { fetchImpl } = bridgeFetch({ headers: echo("20260301", "20260331") })

    const result = await requestBridgeExport({
      token: "t",
      mode: "opening",
      company: "Test Pharmacy",
      period: { from: "2026-03-01", to: "2026-03-31" },
      fetchImpl,
    })

    expect(result.period).toEqual({ from: "2026-03-01", to: "2026-03-31" })
  })

  it("refuses another company or mode even when the period matches", async () => {
    const company = bridgeFetch({ headers: echo("20260101", "20260131", "Other Pharmacy") })
    const companyError = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl: company.fetchImpl,
      }),
    )
    expect(companyError.code).toBe("TALLY_BRIDGE_COMPANY_MISMATCH")

    const mode = bridgeFetch({ headers: echo("20260101", "20260131", "Test Pharmacy", "closing") })
    const modeError = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl: mode.fetchImpl,
      }),
    )
    expect(modeError.code).toBe("TALLY_BRIDGE_MODE_MISMATCH")
  })

  it("refuses a payload that is not the part of the books it asked for", async () => {
    // A chunk asks for vouchers; the bridge answered with masters. Recording
    // that as a voucher chunk would leave the range unread and unmarked.
    const { fetchImpl, calls } = bridgeFetch({ headers: echo(undefined, undefined, undefined, undefined, "masters") })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        scope: "vouchers",
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_SCOPE_MISMATCH")
    expect(calls[0]).toContain("scope=vouchers")
  })

  it("refuses a bridge that does not state the scope", async () => {
    const { fetchImpl } = bridgeFetch({
      headers: {
        "x-synapse-tally-from": "20260101",
        "x-synapse-tally-to": "20260131",
        "x-synapse-tally-company": "Test Pharmacy",
        "x-synapse-tally-mode": "opening",
      },
    })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_SCOPE_UNVERIFIED")
  })

  it("asks a closing cut-over for masters only", async () => {
    const { fetchImpl, calls } = bridgeFetch({
      headers: echo("20260101", "20260131", "Test Pharmacy", "closing", "masters"),
    })

    const result = await requestBridgeExport({
      token: "t",
      mode: "closing",
      company: "Test Pharmacy",
      period: january,
      fetchImpl,
    })

    expect(calls[0]).toContain("scope=masters")
    expect(result.scope).toBe("masters")
  })

  it("surfaces the bridge's own error code", async () => {
    const { fetchImpl } = bridgeFetch({
      status: 400,
      body: { error: "TALLY_BRIDGE_PERIOD_INCOMPLETE" },
    })

    const error = await failure(
      requestBridgeExport({
        token: "t",
        mode: "opening",
        company: "Test Pharmacy",
        period: january,
        fetchImpl,
      }),
    )

    expect(error.code).toBe("TALLY_BRIDGE_PERIOD_INCOMPLETE")
    expect(error.status).toBe(400)
  })
})

describe("bridge period from the page fields", () => {
  it("mirrors the defaults the generated command relies on", () => {
    const today = new Date("2026-10-30T00:00:00Z")

    expect(bridgePeriodFromFields("", "", today)).toEqual({
      from: "1900-01-01",
      to: "2026-10-30",
    })
    expect(bridgePeriodFromFields("20260401", "20261031", today)).toEqual({
      from: "2026-04-01",
      to: "2026-10-31",
    })
  })
})
