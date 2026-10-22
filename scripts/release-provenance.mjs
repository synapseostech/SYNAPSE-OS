/**
 * Pure release eligibility. Automatic Release must follow a successful CI
 * push on main — not a pull_request workflow_run.
 */
export function shouldRunAutomaticRelease({ conclusion, headBranch, event }) {
  return conclusion === "success" && headBranch === "main" && event === "push"
}

export function assertReleaseProvenance({
  eventName,
  sourceRepository,
  expectedRepository,
  sourceBranch,
  sourceEvent,
  sha,
  ciRunId,
  triggeringCiRun,
  ciRuns,
  expectedWorkflowId,
}) {
  if (!/^[0-9a-f]{40}$/i.test(String(sha || ""))) {
    return { ok: false, error: `Invalid release SHA: ${sha}` }
  }
  if (sourceRepository !== expectedRepository) {
    return { ok: false, error: "Release source repository is not this repository" }
  }
  if (!Number.isSafeInteger(Number(expectedWorkflowId)) || Number(expectedWorkflowId) <= 0) {
    return { ok: false, error: "Required CI workflow could not be verified" }
  }

  const isRequiredCiRun = (run) =>
    run &&
    String(run.workflow_id) === String(expectedWorkflowId) &&
    run.head_sha === sha &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.event === "push" &&
    run.head_branch === "main" &&
    run.repository?.full_name === expectedRepository &&
    run.head_repository?.full_name === expectedRepository

  if (eventName === "workflow_run") {
    if (sourceBranch !== "main" || sourceEvent !== "push") {
      return { ok: false, error: "Automatic release requires a successful CI push on main" }
    }
    if (!ciRunId || String(triggeringCiRun?.id) !== String(ciRunId)) {
      return { ok: false, error: "Triggering CI run could not be verified" }
    }
    if (!isRequiredCiRun(triggeringCiRun)) {
      return { ok: false, error: `Triggering CI run ${ciRunId} does not validate release SHA ${sha}` }
    }
    return { ok: true, ciRunId: triggeringCiRun.id }
  }

  if (eventName !== "workflow_dispatch") {
    return { ok: false, error: `Unsupported release event: ${eventName}` }
  }

  const passing = (ciRuns || []).find(isRequiredCiRun)
  if (!passing) {
    return { ok: false, error: `No successful required CI run found for ${sha}` }
  }
  return { ok: true, ciRunId: passing.id ?? null }
}
