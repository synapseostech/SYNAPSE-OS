import { describe, expect, it, vi } from "vitest"
import { telemetryBootstrap, telemetryEnabled } from "./bootstrap"
import {
  cutoverBlockReason,
  eventPayload,
  paymentKind,
  registerPrivacyHooks,
  scrubPageview,
  track,
} from "./events"

function fakeWindow(loader = vi.fn()) {
  return { va: loader, si: loader } as unknown as Window
}

describe("eventPayload", () => {
  it("keeps only the properties the event declares", () => {
    const payload = eventPayload("sale_completed", {
      items: 3,
      payment: "cash",
      credit: false,
      offline: true,
      // A caller cannot smuggle anything else out of the browser.
      clientName: "Amina N.",
      clientPhone: "+256700000000",
      receiptNumber: "RCP-000123",
    } as never)

    expect(payload).toEqual({ items: 3, payment: "cash", credit: false, offline: true })
  })

  it("closes the enumerations instead of forwarding a free-form string", () => {
    const payload = eventPayload("sale_completed", {
      items: 1,
      payment: "bitcoin",
      credit: "yes",
      offline: 1,
    } as never)

    expect(payload).toEqual({ items: 1, payment: "other", credit: false, offline: false })
  })

  it("rounds and floors counts so a negative or fractional value cannot be sent", () => {
    expect(eventPayload("sale_failed", { stage: "response", status: 503.6 })).toEqual({
      stage: "response",
      status: 504,
    })
    expect(eventPayload("refund_recorded", { items: -4, reason: "damaged" })).toEqual({
      items: 0,
      reason: "damaged",
    })
  })

  it("maps an unknown refusal code to unknown rather than sending it", () => {
    expect(eventPayload("tally_cutover_blocked", { reason: "PLEASE_PAY_ATTENTION" } as never)).toEqual({
      reason: "unknown",
    })
  })
})

describe("paymentKind", () => {
  it("maps the POS screen's upper-case methods", () => {
    expect(paymentKind("CASH")).toBe("cash")
    expect(paymentKind("MOBILE_MONEY")).toBe("mobile_money")
    expect(paymentKind("CREDIT")).toBe("credit")
    expect(paymentKind(undefined)).toBe("other")
  })
})

describe("cutoverBlockReason", () => {
  it("groups the refusal codes the apply route returns", () => {
    expect(cutoverBlockReason("TALLY_PREFLIGHT_BLOCKED")).toBe("preflight")
    expect(cutoverBlockReason("TALLY_SOURCE_TRUNCATED")).toBe("extraction")
    expect(cutoverBlockReason("TALLY_BLOCKING_EXCEPTIONS")).toBe("exceptions")
    expect(cutoverBlockReason("TALLY_AUDIT_FAILED")).toBe("audit")
    expect(cutoverBlockReason("SOMETHING_ELSE")).toBe("unknown")
  })
})

describe("track", () => {
  it("does nothing when the platform loader is absent", () => {
    expect(() => track("sale_completed", {
      items: 1,
      payment: "cash",
      credit: false,
      offline: false,
    }, {} as Window)).not.toThrow()
  })

  it("does nothing in a process with no window", () => {
    expect(() => track("sale_completed", {
      items: 1,
      payment: "cash",
      credit: false,
      offline: false,
    }, undefined)).not.toThrow()
  })

  it("sends the event through the loader the platform installed", () => {
    const loader = vi.fn()
    track(
      "tally_cutover_completed",
      { chunks: 4, documents: 120 },
      fakeWindow(loader),
    )

    expect(loader).toHaveBeenCalledWith("event", {
      name: "tally_cutover_completed",
      data: { chunks: 4, documents: 120 },
    })
  })

  it("never lets a loader failure reach the sale", () => {
    const loader = vi.fn(() => {
      throw new Error("blocked by an extension")
    })

    expect(() =>
      track("sale_completed", {
        items: 1,
        payment: "cash",
        credit: false,
        offline: false,
      }, fakeWindow(loader)),
    ).not.toThrow()
  })
})

describe("scrubPageview", () => {
  it("drops a query string and fragment before the pageview leaves", () => {
    expect(
      scrubPageview({ type: "pageview", url: "https://pharm.example.com/portal/pos?sale=88#receipt" }),
    ).toEqual({ type: "pageview", url: "https://pharm.example.com/portal/pos" })
  })

  it("redacts a credential carried in the path", () => {
    for (const [path, redacted] of [
      ["/reset-password/secret-token", "/reset-password/[token]"],
      ["/invite/secret-token", "/invite/[token]"],
      ["/invite/facility/secret-token", "/invite/facility/[token]"],
    ]) {
      expect(scrubPageview({ type: "pageview", url: `https://pharm.example.com${path}?next=/portal#x` })).toEqual({
        type: "pageview",
        url: `https://pharm.example.com${redacted}`,
      })
    }
  })

  it("leaves an event without a url untouched", () => {
    expect(scrubPageview({ type: "event" })).toEqual({ type: "event" })
  })

  it("replaces an unparseable url rather than forward it", () => {
    expect(scrubPageview({ url: "not a url" })).toEqual({ url: "" })
  })
})

describe("registerPrivacyHooks", () => {
  it("registers the scrubber with both loaders", () => {
    const va = vi.fn()
    const si = vi.fn()
    registerPrivacyHooks({ va, si } as unknown as Window)

    expect(va).toHaveBeenCalledWith("beforeSend", scrubPageview)
    expect(si).toHaveBeenCalledWith("beforeSend", scrubPageview)
  })

  it("tolerates a loader that does not implement beforeSend", () => {
    const va = vi.fn(() => {
      throw new Error("unsupported")
    })

    expect(() => registerPrivacyHooks({ va } as unknown as Window)).not.toThrow()
  })
})

describe("telemetryBootstrap", () => {
  it("renders nothing unless the environment opted in", () => {
    expect(telemetryBootstrap(false)).toBe("")
    expect(telemetryEnabled(undefined)).toBe(false)
    expect(telemetryEnabled("0")).toBe(false)
    expect(telemetryEnabled("1")).toBe(true)
  })

  it("installs the queues the platform's scripts drain", () => {
    const script = telemetryBootstrap(true)

    expect(script).toContain("window.vaq")
    expect(script).toContain("window.siq")
    expect(script).toContain('window.va("beforeSend", scrub)')
    expect(script).toContain('window.si("beforeSend", scrub)')
  })

  it("scrubs the url inside the inline script, not only in the module", () => {
    const script = telemetryBootstrap(true)

    expect(script).toContain("url.search")
    expect(script).toContain("url.hash")
    expect(script).toContain("url.pathname")
  })

  it("redacts a link credential when the inline scrubber is actually run", () => {
    const win: Record<string, unknown> = {}
    new Function("window", telemetryBootstrap(true))(win)
    const queue = win.vaq as unknown as Array<[string, (event: { url: string }) => { url: string }]>
    const scrub = queue[0]![1]

    expect(scrub({ url: "https://pharm.example.com/reset-password/secret?next=/portal#x" })).toEqual({
      url: "https://pharm.example.com/reset-password/[token]",
    })
    expect(scrub({ url: "https://pharm.example.com/invite/facility/secret" })).toEqual({
      url: "https://pharm.example.com/invite/facility/[token]",
    })
    expect(scrub({ url: "https://pharm.example.com/portal/pos?x=1#y" })).toEqual({
      url: "https://pharm.example.com/portal/pos",
    })
  })
})
