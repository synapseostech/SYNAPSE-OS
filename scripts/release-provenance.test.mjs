import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { assertReleaseProvenance, shouldRunAutomaticRelease } from "./release-provenance.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const release = readFileSync(join(root, ".github/workflows/release.yml"), "utf8")
const sha = "81bc3c1fe15a9c993d0996fa316d736ed7bc51f6"
const repo = "synapseostech/SYNAPSE-OS"
const workflowId = 363115396

function ciRun(overrides = {}) {
  return {
    id: 35347838329,
    workflow_id: workflowId,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    event: "push",
    head_branch: "main",
    repository: { full_name: repo },
    head_repository: { full_name: repo },
    ...overrides,
  }
}

function provenance(overrides = {}) {
  return {
    eventName: "workflow_run",
    sourceRepository: repo,
    expectedRepository: repo,
    sourceBranch: "main",
    sourceEvent: "push",
    sha,
    ciRunId: 35347838329,
    triggeringCiRun: ciRun(),
    ciRuns: [],
    expectedWorkflowId: workflowId,
    ...overrides,
  }
}

test("automatic release ignores pull_request CI completions", () => {
  assert.equal(
    shouldRunAutomaticRelease({
      conclusion: "success",
      headBranch: "cursor/final-green-report-2026-09-18",
      event: "pull_request",
    }),
    false,
  )
})

test("automatic release accepts a successful main push CI", () => {
  assert.equal(
    shouldRunAutomaticRelease({ conclusion: "success", headBranch: "main", event: "push" }),
    true,
  )
})

test("automatic release accepts the successful triggering CI run by ID", () => {
  const result = assertReleaseProvenance(provenance())
  assert.deepEqual(result, { ok: true, ciRunId: 35347838329 })
})

test("provenance rejects an invalid release SHA", () => {
  const result = assertReleaseProvenance(provenance({ sha: "d186f91d" }))
  assert.equal(result.ok, false)
  assert.match(result.error, /Invalid release SHA/)
})

test("provenance rejects a source from another repository", () => {
  const result = assertReleaseProvenance(provenance({ sourceRepository: "attacker/SYNAPSE-OS" }))
  assert.equal(result.ok, false)
  assert.match(result.error, /not this repository/)
})

test("automatic release rejects a run from a branch other than main", () => {
  const result = assertReleaseProvenance(provenance({ sourceBranch: "release/candidate" }))
  assert.equal(result.ok, false)
  assert.match(result.error, /successful CI push on main/)
})

test("automatic release rejects a run triggered by an event other than push", () => {
  const result = assertReleaseProvenance(provenance({ sourceEvent: "pull_request" }))
  assert.equal(result.ok, false)
  assert.match(result.error, /successful CI push on main/)
})

test("provenance rejects failed CI", () => {
  const result = assertReleaseProvenance(provenance({
    triggeringCiRun: ciRun({ conclusion: "failure" }),
  }))
  assert.equal(result.ok, false)
  assert.match(result.error, /does not validate release SHA/)
})

test("provenance rejects a CI run from another repository", () => {
  for (const override of [
    { repository: { full_name: "attacker/SYNAPSE-OS" } },
    { head_repository: { full_name: "attacker/SYNAPSE-OS" } },
  ]) {
    const result = assertReleaseProvenance(provenance({
      triggeringCiRun: ciRun(override),
    }))
    assert.equal(result.ok, false)
    assert.match(result.error, /does not validate release SHA/)
  }
})

test("provenance rejects a CI run that has not completed", () => {
  const result = assertReleaseProvenance(provenance({
    triggeringCiRun: ciRun({ status: "in_progress" }),
  }))
  assert.equal(result.ok, false)
  assert.match(result.error, /does not validate release SHA/)
})

test("provenance rejects CI run metadata with the wrong branch or event", () => {
  for (const override of [
    { head_branch: "release/candidate" },
    { event: "pull_request" },
  ]) {
    const result = assertReleaseProvenance(provenance({
      triggeringCiRun: ciRun(override),
    }))
    assert.equal(result.ok, false)
    assert.match(result.error, /does not validate release SHA/)
  }
})

test("provenance rejects a successful CI run for a different commit", () => {
  const result = assertReleaseProvenance(provenance({
    triggeringCiRun: ciRun({ head_sha: "d186f91d811d7c1f70ca051ed3167ec76ee4d032" }),
  }))
  assert.equal(result.ok, false)
  assert.match(result.error, /does not validate release SHA/)
})

test("provenance rejects a triggering run ID that differs from the event", () => {
  const result = assertReleaseProvenance(provenance({ ciRunId: 123 }))
  assert.equal(result.ok, false)
  assert.match(result.error, /Triggering CI run could not be verified/)
})

test("provenance rejects a run from the wrong CI workflow", () => {
  const result = assertReleaseProvenance(provenance({
    triggeringCiRun: ciRun({ workflow_id: workflowId + 1 }),
  }))
  assert.equal(result.ok, false)
  assert.match(result.error, /does not validate release SHA/)
})

test("provenance rejects a missing required CI workflow identity", () => {
  const result = assertReleaseProvenance(provenance({ expectedWorkflowId: undefined }))
  assert.equal(result.ok, false)
  assert.match(result.error, /Required CI workflow could not be verified/)
})

test("manual release resolves an exact successful CI push for the requested SHA", () => {
  const result = assertReleaseProvenance(provenance({
    eventName: "workflow_dispatch",
    sourceBranch: "",
    sourceEvent: "",
    ciRunId: "",
    triggeringCiRun: undefined,
    ciRuns: [ciRun()],
  }))
  assert.deepEqual(result, { ok: true, ciRunId: 35347838329 })
})

test("manual release rejects failed or mismatched CI runs", () => {
  const result = assertReleaseProvenance(provenance({
    eventName: "workflow_dispatch",
    sourceBranch: "",
    sourceEvent: "",
    ciRunId: "",
    triggeringCiRun: undefined,
    ciRuns: [
      ciRun({ conclusion: "failure" }),
      ciRun({ id: 2, head_sha: "d186f91d811d7c1f70ca051ed3167ec76ee4d032" }),
    ],
  }))
  assert.equal(result.ok, false)
  assert.match(result.error, /No successful required CI run/)
})

test("release workflow skips non-main workflow_run jobs instead of failing them", () => {
  assert.match(release, /github\.event\.workflow_run\.head_branch == 'main'/)
  assert.match(release, /github\.event\.workflow_run\.event == 'push'/)
  assert.match(release, /Automatic release requires a successful CI push on main/)
  assert.match(release, /github\.rest\.actions\.getWorkflowRun/)
  assert.match(release, /github\.rest\.actions\.listWorkflowRuns,/)
  assert.doesNotMatch(release, /listWorkflowRunsForRepo/)
  assert.match(release, /workflow_id: workflow\.id, head_sha: sha, status: "completed"/)
  assert.match(release, /run\.status === "completed"/)
  assert.match(release, /run\.conclusion === "success"/)
  assert.match(release, /run\.event === "push"/)
  assert.match(release, /run\.head_branch === "main"/)
  assert.match(release, /run\.head_sha === sha/)
  assert.match(release, /run\.repository\?\.full_name === `\$\{owner\}\/\$\{repo\}`/)
  assert.match(release, /run\.head_repository\?\.full_name === `\$\{owner\}\/\$\{repo\}`/)
  assert.match(release, /run\.workflow_id/)
})
