import { describe, expect, it } from "vitest"
import {
  MASTERS_CHUNK_ID,
  createManifest,
  recordChunkResult,
  voucherChunkId,
  type TallyMigrationManifest,
} from "./chunks"
import { buildCutoverPreflight, type PreflightInput } from "./preflight"
import type { TallyReconcileCheck } from "./reconcile"
import type { TallyPlanSummary } from "./types"

const PERIOD = { from: "2026-01-01", to: "2026-01-10" }
const AT = "2026-01-10T00:00:00.000Z"

function summary(overrides: Partial<TallyPlanSummary> = {}): TallyPlanSummary {
  return {
    company: "Demo Pharma",
    companyKey: "demo-pharma",
    currency: "UGX",
    conversionDate: "2026-01-10",
    mode: "opening",
    format: "xml",
    counts: {
      ledgers: 4,
      groups: 2,
      stockItems: 1,
      vouchers: 10,
      postedVouchers: 10,
      skippedVouchers: 0,
      sales: 4,
      purchases: 2,
      openingLines: 4,
    },
    opening: { date: "2026-01-01", totalDebit: 100_000, totalCredit: 100_000, difference: 0 },
    stock: {
      openingValue: 50_000,
      closingValue: 50_000,
      itemsWithOpeningValue: 1,
      itemsWithClosingValue: 1,
      itemCount: 1,
    },
    reconciliation: {
      inventoryOpening: 50_000,
      customerOpening: 20_000,
      supplierOpening: 30_000,
      partyReceivable: 20_000,
      partyPayable: 30_000,
      duplicateVouchers: 0,
    },
    exceptions: [],
    chunkCount: 1,
    chunkSize: 250,
    warnings: [],
    preparedAt: AT,
    ...overrides,
  }
}

function manifest(complete = true): TallyMigrationManifest {
  let value = createManifest({
    sessionId: "session-1",
    company: "Demo Pharma",
    mode: "opening",
    period: PERIOD,
    updatedAt: AT,
  })
  if (!complete) return value
  value = recordChunkResult(
    value,
    MASTERS_CHUNK_ID,
    { status: "complete", recordsRead: 0, expectedRecords: 0 },
    AT,
  )
  return recordChunkResult(
    value,
    voucherChunkId(PERIOD),
    { status: "complete", recordsRead: 10, expectedRecords: 10 },
    AT,
  )
}

const CAPABILITIES = ["inventory.adjust", "reports.financial"]

function input(overrides: Partial<PreflightInput> = {}): PreflightInput {
  return {
    sessionStatus: "review",
    capabilities: CAPABILITIES,
    summary: summary(),
    manifest: manifest(),
    manifestProblems: [],
    flaggedRows: 0,
    ...overrides,
  }
}

function statusOf(checks: ReturnType<typeof buildCutoverPreflight>["checks"], id: string) {
  const found = checks.find((entry) => entry.id === id)
  if (!found) throw new Error(`no check ${id}`)
  return found
}

describe("buildCutoverPreflight", () => {
  it("passes a complete, reconciled plan and reports it ready to apply", () => {
    const preflight = buildCutoverPreflight(input())

    expect(preflight.state).toBe("pre-cutover")
    expect(preflight.canApply).toBe(true)
    for (const entry of preflight.checks) {
      expect(entry.status, `${entry.id}: ${entry.detail}`).not.toBe("fail")
    }
  })

  it("refuses an operator without the financial capability", () => {
    const preflight = buildCutoverPreflight(input({ capabilities: ["inventory.adjust"] }))

    expect(preflight.canApply).toBe(false)
    expect(preflight.state).toBe("blocked")
    expect(statusOf(preflight.checks, "administrator")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("reports.financial"),
    })
  })

  it("refuses a plan whose company disagrees with its manifest", () => {
    const preflight = buildCutoverPreflight(
      input({ summary: summary({ company: "Other Pharmacy" }) }),
    )

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "company").status).toBe("fail")
  })

  it("refuses a cut-over date outside the exported period", () => {
    const preflight = buildCutoverPreflight(
      input({ summary: summary({ conversionDate: "2026-02-01" }) }),
    )

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "period")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("2026-02-01"),
    })
  })

  it("refuses a manifest whose chunks are not all complete", () => {
    const preflight = buildCutoverPreflight(input({ manifest: manifest(false) }))

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "extraction").status).toBe("fail")
  })

  it("refuses a plan carrying blocking exceptions", () => {
    const preflight = buildCutoverPreflight(input({ flaggedRows: 3 }))

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "exceptions").status).toBe("fail")
  })

  it("refuses an opening journal whose debits and credits differ", () => {
    const preflight = buildCutoverPreflight(
      input({
        summary: summary({
          opening: { date: "2026-01-01", totalDebit: 100_000, totalCredit: 99_000, difference: 1_000 },
        }),
      }),
    )

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "opening-balance")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("1000.00"),
    })
  })

  it("refuses customer balances the opening journal does not carry", () => {
    const preflight = buildCutoverPreflight(
      input({
        summary: summary({
          reconciliation: {
            inventoryOpening: 50_000,
            customerOpening: 20_000,
            supplierOpening: 30_000,
            partyReceivable: 25_000,
            partyPayable: 30_000,
            duplicateVouchers: 0,
          },
        }),
      }),
    )

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "receivables")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("5000.00"),
    })
  })

  it("refuses supplier balances the opening journal does not carry", () => {
    const preflight = buildCutoverPreflight(
      input({
        summary: summary({
          reconciliation: {
            inventoryOpening: 50_000,
            customerOpening: 20_000,
            supplierOpening: 30_000,
            partyReceivable: 20_000,
            partyPayable: 27_000,
            duplicateVouchers: 0,
          },
        }),
      }),
    )

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "payables").status).toBe("fail")
  })

  it("shows a stock valuation difference without blocking, because Tally keeps the two apart", () => {
    const preflight = buildCutoverPreflight(
      input({
        summary: summary({
          reconciliation: {
            inventoryOpening: 49_000,
            customerOpening: 20_000,
            supplierOpening: 30_000,
            partyReceivable: 20_000,
            partyPayable: 30_000,
            duplicateVouchers: 0,
          },
        }),
      }),
    )

    expect(preflight.canApply).toBe(true)
    expect(statusOf(preflight.checks, "stock-value")).toMatchObject({ status: "warning" })
  })

  it("treats a plan with no reconciliation block as unprovable, not as zero", () => {
    const legacy = summary()
    delete legacy.reconciliation
    const preflight = buildCutoverPreflight(input({ summary: legacy }))

    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "duplicates").status).toBe("unavailable")
    expect(statusOf(preflight.checks, "receivables").status).toBe("unavailable")
  })

  it("counts detected duplicates and still allows the apply they were skipped from", () => {
    const preflight = buildCutoverPreflight(
      input({
        summary: summary({
          reconciliation: {
            inventoryOpening: 50_000,
            customerOpening: 20_000,
            supplierOpening: 30_000,
            partyReceivable: 20_000,
            partyPayable: 30_000,
            duplicateVouchers: 2,
          },
        }),
      }),
    )

    expect(preflight.canApply).toBe(true)
    expect(statusOf(preflight.checks, "duplicates")).toMatchObject({
      status: "pass",
      detail: expect.stringContaining("2 duplicate"),
    })
  })

  it("marks coverage the source never confirmed as a warning the operator must acknowledge", () => {
    let value = createManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: PERIOD,
      updatedAt: AT,
    })
    value = recordChunkResult(value, MASTERS_CHUNK_ID, { status: "complete", recordsRead: 0 }, AT)
    value = recordChunkResult(value, voucherChunkId(PERIOD), { status: "complete", recordsRead: 10 }, AT)

    const preflight = buildCutoverPreflight(input({ manifest: value }))

    expect(statusOf(preflight.checks, "coverage")).toMatchObject({ status: "warning" })
    expect(preflight.canApply).toBe(true)
  })

  it("warns about an edition no installation has been verified against, for both editions", () => {
    for (const edition of ["prime", "erp9"] as const) {
      const preflight = buildCutoverPreflight(
        input({ manifest: { ...manifest(), edition } }),
      )
      expect(statusOf(preflight.checks, "edition")).toMatchObject({ status: "warning" })
      expect(preflight.canApply).toBe(true)
    }
  })

  it("warns when the export does not say which edition produced it", () => {
    const preflight = buildCutoverPreflight(input({ manifest: { ...manifest(), edition: "unknown" } }))

    expect(statusOf(preflight.checks, "edition")).toMatchObject({ status: "warning" })
  })

  it("reports a running import as in progress rather than blocked", () => {
    const preflight = buildCutoverPreflight(input({ sessionStatus: "importing" }))

    expect(preflight.state).toBe("in-progress")
    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "applied").status).toBe("warning")
  })

  it("completes only when the applied import reconciles and its audit row exists", () => {
    const applied: TallyReconcileCheck = {
      id: "journals",
      label: "Vouchers posted to the ledger",
      expected: 10,
      actual: 10,
      difference: 0,
      status: "ok",
    }
    const preflight = buildCutoverPreflight(
      input({ sessionStatus: "complete", reconcile: [applied], auditRecorded: true }),
    )

    expect(preflight.state).toBe("completed")
    expect(preflight.canApply).toBe(false)
    expect(statusOf(preflight.checks, "audit").status).toBe("pass")
  })

  it("blocks a completed import whose applied counts disagree", () => {
    const preflight = buildCutoverPreflight(
      input({
        sessionStatus: "complete",
        auditRecorded: true,
        reconcile: [
          {
            id: "journals",
            label: "Vouchers posted to the ledger",
            expected: 10,
            actual: 9,
            difference: -1,
            status: "difference",
          },
        ],
      }),
    )

    expect(preflight.state).toBe("blocked")
    expect(statusOf(preflight.checks, "applied")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("Vouchers posted"),
    })
  })

  it("blocks a completed import with no audit record", () => {
    const preflight = buildCutoverPreflight(
      input({ sessionStatus: "complete", reconcile: [], auditRecorded: false }),
    )

    expect(preflight.state).toBe("blocked")
    expect(statusOf(preflight.checks, "audit").status).toBe("fail")
  })

  it("does not report agreement for checks the reconciliation could not compare", () => {
    const preflight = buildCutoverPreflight(
      input({
        sessionStatus: "complete",
        auditRecorded: true,
        reconcile: [
          {
            id: "journals",
            label: "Journals",
            expected: 6,
            actual: 6,
            difference: 0,
            status: "ok",
          },
          {
            id: "stock",
            label: "Stock batches",
            expected: null,
            actual: 12,
            difference: null,
            status: "not-available",
          },
        ],
      }),
    )

    expect(statusOf(preflight.checks, "applied")).toMatchObject({ status: "warning" })
  })

  it("does not call a completed import reconciled when no reconciliation was saved", () => {
    const preflight = buildCutoverPreflight(
      input({ sessionStatus: "complete", auditRecorded: true }),
    )

    expect(statusOf(preflight.checks, "applied")).toMatchObject({
      status: "unavailable",
    })
    expect(preflight.state).toBe("blocked")
  })

  it("never claims the backup precondition was checked", () => {
    const preflight = buildCutoverPreflight(input())

    expect(statusOf(preflight.checks, "backup")).toMatchObject({ status: "unavailable" })
  })
})
