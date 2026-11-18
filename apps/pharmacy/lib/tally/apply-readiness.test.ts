import { describe, expect, it } from "vitest"

import { preflightAllowsApply, type PreflightCheckView } from "./apply-readiness"

const fail = (id: string): PreflightCheckView => ({ id, status: "fail", blocksApply: true })
const answered = { sequenceConfirmed: true, everyDifferenceAnswered: true, nothingUnknown: true }

describe("preflightAllowsApply", () => {
  it("allows Apply when the preflight already passes", () => {
    expect(preflightAllowsApply({ canApply: true, checks: [] }, null)).toBe(true)
    expect(preflightAllowsApply(null, null)).toBe(true)
  })

  it("lets answered differences and a confirmed sequence through together", () => {
    // The SADIO rehearsal: three differences answered on screen, sequence
    // ticked, and both replay checks still failing on the server's earlier read.
    const preflight = { canApply: false, checks: [fail("replay-parity"), fail("replay-sequence")] }
    expect(preflightAllowsApply(preflight, answered)).toBe(true)
  })

  it("holds Apply while a difference has no reason", () => {
    const preflight = { canApply: false, checks: [fail("replay-parity"), fail("replay-sequence")] }
    expect(preflightAllowsApply(preflight, { ...answered, everyDifferenceAnswered: false })).toBe(false)
  })

  it("holds Apply while the sequence is unconfirmed", () => {
    const preflight = { canApply: false, checks: [fail("replay-sequence")] }
    expect(preflightAllowsApply(preflight, { ...answered, sequenceConfirmed: false })).toBe(false)
  })

  it("holds Apply when the gate names something no reason can answer", () => {
    const preflight = { canApply: false, checks: [fail("replay-parity")] }
    expect(preflightAllowsApply(preflight, { ...answered, nothingUnknown: false })).toBe(false)
  })

  it("never overrides a check the screen cannot answer", () => {
    const preflight = { canApply: false, checks: [fail("replay-parity"), fail("company")] }
    expect(preflightAllowsApply(preflight, answered)).toBe(false)
  })

  it("ignores failing checks that do not block Apply", () => {
    const preflight = {
      canApply: false,
      checks: [{ id: "edition", status: "warning" as const, blocksApply: false }, fail("replay-sequence")],
    }
    expect(preflightAllowsApply(preflight, answered)).toBe(true)
  })

  it("does not apply replay answers to a session that is not a replay", () => {
    const preflight = { canApply: false, checks: [fail("replay-sequence")] }
    expect(preflightAllowsApply(preflight, null)).toBe(false)
  })
})
