/**
 * The gate a historical replay must pass before Apply writes anything.
 *
 * The replay reaches Tally's closing position or it does not. When it does
 * not, every difference is named individually and the operator may accept it
 * with a written reason — but only knowingly, one by one, and only for the
 * preview they were shown. A difference nobody has answered stays blocking,
 * and a figure the export does not carry is never treated as agreement.
 */

import type { TallyReplayFinding, TallyReplayReconciliationRow } from "@synapse/db/tally-replay"
import type { TallyReplayTarget } from "./types"

/** A reason shorter than this is a shrug, and the audit row would show it. */
export const REPLAY_REASON_MIN = 8
export const REPLAY_REASON_MAX = 500
export const REPLAY_ACK_LIMIT = 1_000

/** What a preview's acknowledgements are saved as on the session. */
export type SavedReplayAcknowledgement = {
  /** The target these answers were given for; a re-preview asks again. */
  preparedAt: string
  sequenceConfirmed: boolean
  acknowledgedAt: string
  acknowledgedBy: string
  items: Array<{ key: string; reason: string }>
}

/** One thing that stops Apply until it agrees or is acknowledged. */
export type TallyReplayBlocker = {
  key: string
  kind: "difference" | "finding"
  label: string
  expected: number | null
  actual: number | null
  difference: number | null
  message: string
  firstDivergence?: { date: string; sourceId: string; movementId?: string }
}

export type ReplayGate = {
  blockers: TallyReplayBlocker[]
  /** Answers that apply to this preview and name a real reason. */
  acknowledged: Array<{ key: string; reason: string }>
  /** Answers naming a key this preview does not carry — refused, not ignored. */
  unknown: string[]
  missing: TallyReplayBlocker[]
  sequenceConfirmed: boolean
  canApply: boolean
}

function scopeLabel(scope: TallyReplayReconciliationRow["scope"]): string {
  if (scope === "account") return "Account"
  if (scope === "stock_total") return "Stock total"
  return "Stock item"
}

function money(value: number): string {
  return value.toFixed(2)
}

/** `reconcile:<scope>:<key>` — stable across previews, so answers can be shown. */
export function replayRowKey(row: TallyReplayReconciliationRow): string {
  return `reconcile:${row.scope}:${row.key}`
}

export function replayFindingKey(finding: TallyReplayFinding, index: number): string {
  return `finding:${finding.code}:${finding.movementId || `${finding.sourceId}:${index}`}`
}

/** Every blocking item the target carries, in the order it happened. */
export function replayBlockers(target: TallyReplayTarget): TallyReplayBlocker[] {
  const blockers: TallyReplayBlocker[] = []

  for (const row of target.reconciliation) {
    if (row.status !== "difference") continue
    const label = `${scopeLabel(row.scope)} ${row.key}`
    const direction =
      row.difference === null
        ? "differs"
        : row.difference > 0
          ? `the replay is ${money(row.difference)} above Tally`
          : `the replay is ${money(Math.abs(row.difference))} below Tally`
    blockers.push({
      key: replayRowKey(row),
      kind: "difference",
      label,
      expected: row.expected,
      actual: row.actual,
      difference: row.difference,
      message: `${label}: Tally has ${row.expected === null ? "no figure" : money(row.expected)}, the replay reaches ${row.actual === null ? "no figure" : money(row.actual)} — ${direction} (tolerance ${row.tolerance}).`,
      ...(row.firstDivergence ? { firstDivergence: row.firstDivergence } : {}),
    })
  }

  const findings = target.findings ?? []
  for (const [index, finding] of findings.entries()) {
    if (finding.severity !== "blocking") continue
    blockers.push({
      key: replayFindingKey(finding, index),
      kind: "finding",
      label: `${finding.stockItemName} · ${finding.date}`,
      expected: null,
      actual: finding.quantityAfter,
      difference: null,
      message: `${finding.message} (${finding.date}, ${finding.sourceId}; on hand went from ${finding.quantityBefore} to ${finding.quantityAfter}).`,
    })
  }

  return blockers
}

function savedFor(
  target: TallyReplayTarget,
  saved: unknown,
): SavedReplayAcknowledgement | null {
  if (typeof saved !== "object" || saved === null) return null
  const value = saved as Record<string, unknown>
  // An answer given for a different preview says nothing about this one.
  if (value.preparedAt !== target.preparedAt) return null
  if (!Array.isArray(value.items)) return null
  return value as SavedReplayAcknowledgement
}

/**
 * Judges a target against the answers saved for it. `canApply` is true only
 * when the operator confirmed the sequence and every blocking item carries a
 * reason long enough to be one.
 */
export function evaluateReplayGate(target: TallyReplayTarget, saved: unknown): ReplayGate {
  const blockers = replayBlockers(target)
  const keys = new Set(blockers.map((blocker) => blocker.key))
  const accepted = savedFor(target, saved)

  const acknowledged: Array<{ key: string; reason: string }> = []
  const unknown: string[] = []
  const seen = new Set<string>()

  for (const item of accepted?.items ?? []) {
    if (typeof item?.key !== "string" || typeof item?.reason !== "string") continue
    if (seen.has(item.key)) continue
    seen.add(item.key)
    if (!keys.has(item.key)) {
      unknown.push(item.key)
      continue
    }
    const reason = item.reason.trim()
    if (reason.length < REPLAY_REASON_MIN) continue
    acknowledged.push({ key: item.key, reason })
  }

  const answered = new Set(acknowledged.map((item) => item.key))
  const missing = blockers.filter((blocker) => !answered.has(blocker.key))
  const sequenceConfirmed = accepted?.sequenceConfirmed === true

  return {
    blockers,
    acknowledged,
    unknown,
    missing,
    sequenceConfirmed,
    canApply: sequenceConfirmed && missing.length === 0,
  }
}

export type ParsedReplayAcknowledgement =
  | { ok: true; sequenceConfirmed: true; items: Array<{ key: string; reason: string }> }
  | { ok: false; code: string; message: string }

/**
 * Reads the acknowledgement Apply accepts from its request body. It refuses
 * rather than repairs: a body that is not exactly this shape is a client that
 * believed something different was saved.
 */
export function parseReplayAcknowledgement(body: unknown): ParsedReplayAcknowledgement {
  if (typeof body !== "object" || body === null) {
    return {
      ok: false,
      code: "TALLY_REPLAY_ACK_INVALID",
      message: "The replay acknowledgement must be an object.",
    }
  }
  const value = body as Record<string, unknown>
  if (value.sequenceConfirmed !== true) {
    return {
      ok: false,
      code: "TALLY_REPLAY_SEQUENCE_UNCONFIRMED",
      message: "The replay sequence must be confirmed before applying.",
    }
  }
  if (!Array.isArray(value.items)) {
    return {
      ok: false,
      code: "TALLY_REPLAY_ACK_INVALID",
      message: "The replay acknowledgement must list the differences it answers.",
    }
  }
  if (value.items.length > REPLAY_ACK_LIMIT) {
    return {
      ok: false,
      code: "TALLY_REPLAY_ACK_TOO_MANY",
      message: `At most ${REPLAY_ACK_LIMIT} differences can be acknowledged in one apply.`,
    }
  }

  const items: Array<{ key: string; reason: string }> = []
  const seen = new Set<string>()
  for (const entry of value.items) {
    if (typeof entry !== "object" || entry === null) {
      return {
        ok: false,
        code: "TALLY_REPLAY_ACK_INVALID",
        message: "Every acknowledged difference needs a key and a reason.",
      }
    }
    const item = entry as Record<string, unknown>
    if (typeof item.key !== "string" || !item.key.trim()) {
      return {
        ok: false,
        code: "TALLY_REPLAY_ACK_INVALID",
        message: "Every acknowledged difference needs a key and a reason.",
      }
    }
    if (typeof item.reason !== "string") {
      return {
        ok: false,
        code: "TALLY_REPLAY_ACK_INVALID",
        message: `Every acknowledged difference needs a reason of at least ${REPLAY_REASON_MIN} characters.`,
      }
    }
    const reason = item.reason.trim()
    if (reason.length < REPLAY_REASON_MIN) {
      return {
        ok: false,
        code: "TALLY_REPLAY_REASON_TOO_SHORT",
        message: `The reason for "${item.key}" must be at least ${REPLAY_REASON_MIN} characters; it is kept with the cut-over.`,
      }
    }
    if (reason.length > REPLAY_REASON_MAX) {
      return {
        ok: false,
        code: "TALLY_REPLAY_REASON_TOO_LONG",
        message: `The reason for "${item.key}" must be at most ${REPLAY_REASON_MAX} characters.`,
      }
    }
    if (seen.has(item.key)) {
      return {
        ok: false,
        code: "TALLY_REPLAY_ACK_DUPLICATE",
        message: `"${item.key}" was acknowledged twice.`,
      }
    }
    seen.add(item.key)
    items.push({ key: item.key, reason })
  }

  return { ok: true, sequenceConfirmed: true, items }
}
