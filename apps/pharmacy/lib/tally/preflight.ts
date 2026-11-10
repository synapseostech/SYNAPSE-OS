/**
 * The cut-over preflight.
 *
 * A Tally migration may only write into a pharmacy after it can prove what it
 * is about to write: the company it read, the period it covers, a complete
 * extraction, a balanced opening journal, and opening balances for customers
 * and suppliers that agree with their ledger lines. This module states those
 * conditions once, as data, so the API route, the review screen and the tests
 * judge the same list.
 *
 * A check that cannot be evaluated from the saved plan is `unavailable`, never
 * `pass`: a missing figure is not a zero. `blocksApply` marks the checks that
 * stop the apply outright; the rest are shown to the operator and either
 * acknowledged or refused at the screen, but they never change a number.
 */

import { canApplyManifest, type TallyMigrationManifest } from "./chunks"
import { editionDisclosure } from "./editions"
import type { TallyReconcileCheck } from "./reconcile"
import type { ReplayGate } from "./replay-gate"
import type { TallyPlanSummary, TallyReplayTarget } from "./types"

export type CutoverState = "pre-cutover" | "in-progress" | "completed" | "blocked"

export type PreflightStatus = "pass" | "fail" | "warning" | "unavailable"

export type PreflightCheck = {
  id: string
  label: string
  status: PreflightStatus
  detail: string
  /** A failed check with this set stops Apply. */
  blocksApply: boolean
}

export type CutoverPreflight = {
  state: CutoverState
  canApply: boolean
  checks: PreflightCheck[]
}

export type PreflightInput = {
  /** The import session's stored status. */
  sessionStatus: string
  /** Capabilities the calling session holds. */
  capabilities: readonly string[]
  /** The plan summary saved by preview, or null when none was saved. */
  summary: TallyPlanSummary | null
  /** The saved manifest, or null when the session has none. */
  manifest: TallyMigrationManifest | null
  /** Problems the caller recorded against the manifest. */
  manifestProblems: readonly string[]
  /** Blocking exceptions the saved plan carries. */
  flaggedRows: number
  /** Post-apply verdicts, when the import has run. */
  reconcile?: readonly TallyReconcileCheck[] | null
  /** Whether the IMPORT_TALLY audit row exists. Only meaningful once complete. */
  auditRecorded?: boolean
  /**
   * Replay only. The saved target and its gate, or null when the session is a
   * replay whose target could not be read — which blocks.
   */
  replay?: { target: TallyReplayTarget; gate: ReplayGate } | null
}

const APPLY_CAPABILITIES = ["inventory.adjust", "reports.financial"] as const

function normaliseName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase().replace(/\s+/g, " ")
}

function money(value: number): string {
  return value.toFixed(2)
}

function check(
  id: string,
  label: string,
  status: PreflightStatus,
  detail: string,
  blocksApply = false,
): PreflightCheck {
  return { id, label, status, detail, blocksApply }
}

function agreement(
  id: string,
  label: string,
  journal: number | undefined,
  parties: number | undefined,
  what: string,
): PreflightCheck {
  if (journal === undefined || parties === undefined) {
    return check(
      id,
      label,
      "unavailable",
      `The saved plan does not carry ${what}, so this cannot be verified. Preview the export again.`,
      true,
    )
  }
  const difference = Math.round((parties - journal + Number.EPSILON) * 100) / 100
  if (difference === 0) {
    return check(id, label, "pass", `${money(journal)} on both sides.`, true)
  }
  return check(
    id,
    label,
    "fail",
    `The opening journal carries ${money(journal)} and the party records sum to ${money(parties)} (difference ${money(difference)}). One of them has lost a balance; correct the export or the mapping and preview again.`,
    true,
  )
}

function periodCheck(summary: TallyPlanSummary | null, manifest: TallyMigrationManifest | null): PreflightCheck {
  const label = "Period and cut-over date"
  if (!manifest) {
    return check("period", label, "fail", "No plan states the period this export covers.", true)
  }
  const from = manifest.period?.from
  const to = manifest.period?.to
  const cutover = summary?.conversionDate ?? manifest.period?.to
  if (!from || !to) {
    return check("period", label, "fail", "The export's period has no start or end date.", true)
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(cutover ?? "")) {
    return check("period", label, "fail", "The cut-over date is missing or not a calendar date.", true)
  }
  if (cutover! < from || cutover! > to) {
    return check(
      "period",
      label,
      "fail",
      `The cut-over date ${cutover} falls outside the exported period ${from} to ${to}.`,
      true,
    )
  }
  return check("period", label, "pass", `${from} to ${to}, cut over at ${cutover}.`, true)
}

export function buildCutoverPreflight(input: PreflightInput): CutoverPreflight {
  const { summary, manifest } = input
  const checks: PreflightCheck[] = []

  const missing = APPLY_CAPABILITIES.filter((capability) => !input.capabilities.includes(capability))
  checks.push(
    missing.length === 0
      ? check("administrator", "Authorised administrator", "pass", "Holds inventory.adjust and reports.financial.")
      : check(
          "administrator",
          "Authorised administrator",
          "fail",
          `Missing ${missing.join(" and ")}. Only a pharmacy administrator may run a cut-over.`,
          true,
        ),
  )

  checks.push(
    !manifest
      ? check("company", "Tally company", "fail", "No plan names the company this export was read from.", true)
      : !normaliseName(manifest.company) || !normaliseName(summary?.companyKey)
        ? check("company", "Tally company", "fail", "The export or its plan does not name a company.", true)
        : summary?.company && normaliseName(summary.company) !== normaliseName(manifest.company)
          ? check(
              "company",
              "Tally company",
              "fail",
              `The saved plan is for "${summary.company}" but the manifest is for "${manifest.company}". Preview the export again.`,
              true,
            )
          : check("company", "Tally company", "pass", `${manifest.company}.`, true),
  )

  checks.push(periodCheck(summary, manifest))

  if (!manifest) {
    checks.push(check("extraction", "Extraction complete", "fail", "No plan states what the extraction read.", true))
  } else {
    const report = canApplyManifest(manifest)
    const problems = [...input.manifestProblems, ...report.problems.map((entry) => entry.code)]
    checks.push(
      problems.length === 0
        ? check("extraction", "Extraction complete", "pass", "Every chunk is complete and inside the period.", true)
        : check(
            "extraction",
            "Extraction complete",
            "fail",
            `${problems.length} extraction problem${problems.length === 1 ? "" : "s"}: ${problems.join(", ")}.`,
            true,
          ),
    )
    if (report.unverified.length > 0) {
      checks.push(
        check(
          "coverage",
          "Independent record count",
          "warning",
          "No source count confirms every record was read. Applying requires the operator to acknowledge this.",
        ),
      )
    }
  }

  const edition = manifest?.edition
  if (edition === undefined) {
    checks.push(
      check("edition", "Tally edition", "warning", "The export does not say which Tally edition read it."),
    )
  } else {
    const disclosure = editionDisclosure(edition)
    checks.push(
      check(
        "edition",
        "Tally edition",
        disclosure.verified ? "pass" : "warning",
        disclosure.verified
          ? `${disclosure.label}, verified against a real installation.`
          : `${disclosure.label}. ${disclosure.caveats[0] ?? "Not verified against a real installation."}`,
      ),
    )
  }

  checks.push(
    input.flaggedRows > 0
      ? check(
          "exceptions",
          "Unresolved extraction errors",
          "fail",
          `${input.flaggedRows} blocking exception${input.flaggedRows === 1 ? "" : "s"} must be corrected before applying.`,
          true,
        )
      : check("exceptions", "Unresolved extraction errors", "pass", "None.", true),
  )

  if (summary?.batchExpiry === "not-supplied") {
    checks.push(
      check(
        "batch-expiry",
        "Batch expiry dates",
        "warning",
        "This plan was prepared accepting that the export states no batch expiry dates. Imported stock keeps Tally's batch names but no expiry, so it cannot be expiry-tracked, allocated by expiry or recalled by batch expiry; stock received after the cut-over is unaffected.",
      ),
    )
  }

  const reconciliation = summary?.reconciliation
  if (!reconciliation) {
    checks.push(
      check(
        "duplicates",
        "Duplicate detection",
        "unavailable",
        "The saved plan carries no duplicate count, so detection cannot be shown to have run.",
      ),
      check("unsupported", "Unsupported records reported", "unavailable", "The saved plan carries no exception list."),
      check(
        "stock-value",
        "Opening stock valuation",
        "unavailable",
        "The saved plan carries no opening stock valuation.",
      ),
    )
  } else {
    checks.push(
      check(
        "duplicates",
        "Duplicate detection",
        "pass",
        reconciliation.duplicateVouchers === 0
          ? "Every voucher identity was read once; no duplicate was found."
          : `${reconciliation.duplicateVouchers} duplicate voucher identit${reconciliation.duplicateVouchers === 1 ? "y was" : "ies were"} found; the later copies were skipped and listed.`,
      ),
      check(
        "unsupported",
        "Unsupported records reported",
        "pass",
        `${summary?.exceptions.length ?? 0} exception${(summary?.exceptions.length ?? 0) === 1 ? "" : "s"} are listed for review. Nothing is dropped silently.`,
      ),
    )

    const stockValue = summary?.stock?.openingValue
    const inventory = reconciliation.inventoryOpening
    if (stockValue === null || stockValue === undefined || inventory === null) {
      checks.push(
        check(
          "stock-value",
          "Opening stock valuation",
          "unavailable",
          "The export does not carry both an opening stock value and an inventory ledger line, so they cannot be compared.",
        ),
      )
    } else {
      const difference = Math.round((inventory - stockValue + Number.EPSILON) * 100) / 100
      checks.push(
        difference === 0
          ? check("stock-value", "Opening stock valuation", "pass", `${money(stockValue)} on both sides.`)
          : check(
              "stock-value",
              "Opening stock valuation",
              "warning",
              `Tally's stock value is ${money(stockValue)} and its inventory ledger carries ${money(inventory)} (difference ${money(difference)}). Tally keeps the two apart; the difference is shown and never adjusted.`,
            ),
      )
    }
  }

  const opening = summary?.opening
  checks.push(
    !opening
      ? check("opening-balance", "Opening journal balanced", "fail", "The saved plan carries no opening journal.", true)
      : opening.difference === 0 && opening.totalDebit === opening.totalCredit
        ? check(
            "opening-balance",
            "Opening journal balanced",
            "pass",
            `Debits and credits both ${money(opening.totalDebit)}.`,
            true,
          )
        : check(
            "opening-balance",
            "Opening journal balanced",
            "fail",
            `Debits ${money(opening.totalDebit)} and credits ${money(opening.totalCredit)} differ by ${money(opening.difference)}. The opening journal is not posted until the export balances.`,
            true,
          ),
  )

  checks.push(
    agreement(
      "receivables",
      "Customer receivables",
      reconciliation?.customerOpening,
      reconciliation?.partyReceivable,
      "the customer opening balances",
    ),
    agreement(
      "payables",
      "Supplier payables",
      reconciliation?.supplierOpening,
      reconciliation?.partyPayable,
      "the supplier opening balances",
    ),
  )

  if (summary?.mode === "replay") {
    const replayTarget = input.replay?.target
    if (!replayTarget || !input.replay) {
      checks.push(
        check(
          "replay-plan",
          "Replay target saved",
          "fail",
          "This session rebuilds the history but its saved replay target is missing, so the closing position cannot be checked. Preview the export again.",
          true,
        ),
      )
    } else {
      const gate = input.replay.gate
      const periodEnd = manifest?.period?.to
      checks.push(
        replayTarget.cutoffDate === periodEnd
          ? check(
              "replay-period",
              "Cut-off matches the exported period",
              "pass",
              `The export ends ${periodEnd} and the replay stops there.`,
              true,
            )
          : check(
              "replay-period",
              "Cut-off matches the exported period",
              "fail",
              `Tally's closing figures are only comparable when the export ends on the cut-off: the export ends ${periodEnd ?? "no stated date"} and the replay stops at ${replayTarget.cutoffDate || "no date"}. Export the period so its last day is the cut-off.`,
              true,
            ),
        check(
          "replay-order",
          "Replay sequence recorded",
          replayTarget.ordering === "date-then-export-order" ? "pass" : "fail",
          replayTarget.ordering === "date-then-export-order"
            ? `${replayTarget.eventCount} events, ordered by date and then by the order Tally exported them. Tally states no time of day, so this is a reproducible sequence, not the day's real order.`
            : "The saved replay does not state how its events were ordered, so the sequence cannot be reviewed.",
          replayTarget.ordering !== "date-then-export-order",
        ),
        replayTarget.movementCount > 0
          ? check(
              "replay-movements",
              "Stock movements captured",
              "pass",
              `${replayTarget.movementCount} stock movement${replayTarget.movementCount === 1 ? "" : "s"} across ${replayTarget.perDay.length} day${replayTarget.perDay.length === 1 ? "" : "s"}.`,
              true,
            )
          : check(
              "replay-movements",
              "Stock movements captured",
              "fail",
              "No stock movement was captured from this export, so a replay would carry balances but no history. Export the day book with inventory vouchers, or use the balances-only mode.",
              true,
            ),
        gate.missing.length === 0
          ? check(
              "replay-parity",
              "Closing position reaches Tally's",
              "pass",
              gate.blockers.length === 0
                ? "Every figure the export carries agrees with the replay."
                : `All ${gate.blockers.length} difference${gate.blockers.length === 1 ? " is" : "s are"} acknowledged with a reason, which is recorded with the cut-over.`,
              true,
            )
          : check(
              "replay-parity",
              "Closing position reaches Tally's",
              "fail",
              `${gate.missing.length} difference${gate.missing.length === 1 ? "" : "s"} between the replay and Tally have not been answered: ${gate.missing
                .slice(0, 5)
                .map((blocker) => blocker.label)
                .join("; ")}${gate.missing.length > 5 ? `; and ${gate.missing.length - 5} more` : ""}. Answer each with a reason, or correct the export.`,
              true,
            ),
        gate.sequenceConfirmed
          ? check(
              "replay-sequence",
              "Sequence confirmed",
              "pass",
              "The operator has confirmed the order the history is replayed in.",
              true,
            )
          : check(
              "replay-sequence",
              "Sequence confirmed",
              "fail",
              "The order in which the history is replayed has not been confirmed. Review the timeline and confirm it before applying.",
              true,
            ),
      )
    }
  }

  const completed = input.sessionStatus === "complete"
  const reconcile = input.reconcile ?? null
  const differences = (reconcile ?? []).filter((entry) => entry.status === "difference")
  const notCompared = (reconcile ?? []).filter((entry) => entry.status === "not-available")

  if (completed) {
    checks.push(
      reconcile === null
        ? check(
            "applied",
            "Import reconciled",
            "unavailable",
            "This session was completed without a saved reconciliation, so it cannot be shown that the plan and what was written agree.",
          )
        : differences.length === 0 && notCompared.length > 0
          ? check(
              "applied",
              "Import reconciled",
              "warning",
              `The checks that could be compared agree, but ${notCompared.length} could not be compared: ${notCompared.map((entry) => entry.label).join("; ")}.`,
            )
          : differences.length === 0
            ? check("applied", "Import reconciled", "pass", "The plan and what was written agree.")
            : check(
              "applied",
              "Import reconciled",
              "fail",
              `${differences.length} reconciliation check${differences.length === 1 ? "" : "s"} disagree after apply: ${differences.map((entry) => entry.label).join("; ")}.`,
            ),
      check(
        "audit",
        "Audit trail",
        input.auditRecorded ? "pass" : "fail",
        input.auditRecorded
          ? "The IMPORT_TALLY audit record exists."
          : "The cut-over is marked complete but its audit record is missing.",
      ),
    )
  } else if (input.sessionStatus === "importing") {
    checks.push(
      check("applied", "Import reconciled", "warning", "The import is running; its reconciliation follows."),
      check("audit", "Audit trail", "warning", "The audit record is written when the import completes."),
    )
  } else {
    checks.push(
      check("applied", "Import reconciled", "unavailable", "Nothing has been written yet."),
      check("audit", "Audit trail", "unavailable", "Nothing has been written yet."),
    )
  }

  checks.push(
    check(
      "backup",
      "Backup and recovery",
      "unavailable",
      "Backing up the pharmacy database before a cut-over is an operator precondition; no automated check exists here.",
    ),
  )

  const blockedApply = checks.some((entry) => entry.blocksApply && entry.status !== "pass")
  const state: CutoverState = completed
    ? reconcile === null || differences.length > 0 || input.auditRecorded !== true
      ? "blocked"
      : "completed"
    : input.sessionStatus === "importing"
      ? "in-progress"
      : blockedApply
        ? "blocked"
        : "pre-cutover"

  // An import that is already running is resumed, not started; offering a fresh
  // apply beside it would invite a second run into the same session.
  return {
    state,
    canApply: !completed && input.sessionStatus !== "importing" && !blockedApply,
    checks,
  }
}
