/**
 * Whether the review screen may offer Apply, given the server's preflight.
 *
 * The preflight is computed when the session is read, before the operator has
 * answered anything on this screen. Two of its replay checks are about exactly
 * those answers, and the server reads the answers only from what Apply submits:
 *
 * - `replay-sequence` fails until the sequence confirmation is submitted.
 * - `replay-parity` fails until a written reason for every difference is.
 *
 * So while those two are the only failing blocks, the screen defers to its own
 * state for them. Apply re-runs the same preflight with the submitted answers,
 * so nothing the server would refuse is let through: this only stops the
 * button refusing what the server would accept.
 */

export type PreflightCheckView = {
  id: string
  status: "pass" | "fail" | "warning" | "unavailable"
  blocksApply: boolean
}

export type ReplayAnswers = {
  /** The confirmation checkbox on this screen. */
  sequenceConfirmed: boolean
  /** Every difference the gate lists has a reason the server will accept. */
  everyDifferenceAnswered: boolean
  /** The gate names nothing it could not place, which no reason can answer. */
  nothingUnknown: boolean
}

export function preflightAllowsApply(
  preflight: { canApply: boolean; checks: PreflightCheckView[] } | null | undefined,
  replay: ReplayAnswers | null,
): boolean {
  if (!preflight || preflight.canApply) return true
  const failing = preflight.checks.filter((check) => check.blocksApply && check.status !== "pass")
  if (failing.length === 0) return true
  return failing.every((check) => {
    if (!replay) return false
    if (check.id === "replay-sequence") return replay.sequenceConfirmed
    if (check.id === "replay-parity") return replay.everyDifferenceAnswered && replay.nothingUnknown
    return false
  })
}
