import assert from "node:assert/strict"
import { test } from "node:test"
import { vercelGitDeployDecision } from "./vercel-build-gate.mjs"

const OS_PROJECT = "synapseos.tech"

function decision(env) {
  return vercelGitDeployDecision({ VERCEL_PROJECT_PRODUCTION_URL: OS_PROJECT, ...env })
}

function escapeForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

test("OS production git deploys now build", () => {
  const d = decision({ VERCEL_ENV: "production" })
  assert.equal(d.skip, false)
  assert.match(d.reason, /production/)
})

test("OS preview git deploys build for every supported branch family", () => {
  const branches = [
    "main",
    "master",
    "release/2026.11",
    "hotfix/rls-tautology",
    "clinical/pilot",
    "staging/uat",
    "integration/hmis",
    "fix/import-authz",
    "feat/triage-intake",
  ]
  for (const branch of branches) {
    const d = decision({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: branch })
    assert.equal(d.skip, false, `preview for ${branch} must build`)
    assert.match(d.reason, new RegExp(escapeForRegExp(branch)))
  }
})

test("OS preview git deploys honour the PR head ref when the commit ref is absent", () => {
  const d = decision({
    VERCEL_ENV: "preview",
    VERCEL_GITHUB_PULL_REQUEST_HEAD_REF: "feat/pr-head-ref",
  })
  assert.equal(d.skip, false)
  assert.match(d.reason, /feat\/pr-head-ref/)
})

test("OS preview git deploys skip unrecognised branches and name them", () => {
  const d = decision({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "chore/bump-deps" })
  assert.equal(d.skip, true)
  assert.match(d.reason, /unrecognized branch chore\/bump-deps/)
})

test("a preview deployment with no git ref skips instead of guessing a branch", () => {
  // Deployment-hook and CLI previews carry no git metadata. There is nothing to
  // match a branch family against, so the gate says so rather than assuming main.
  const d = decision({ VERCEL_ENV: "preview" })
  assert.equal(d.skip, true)
  assert.match(d.reason, /unrecognized branch unknown/)
})

test("branch matching is anchored, not a substring search", () => {
  // "chore/clinical-cleanup" is not a clinical/ branch and must not be treated as one.
  const d = decision({ VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "chore/clinical-cleanup" })
  assert.equal(d.skip, true)
})

test("demo production git deploys still build", () => {
  const d = decision({
    VERCEL_ENV: "production",
    VERCEL_PROJECT_PRODUCTION_URL: "demo.synapseos.tech",
  })
  assert.equal(d.skip, false)
  assert.match(d.reason, /demo/)
})

test("development environments always build", () => {
  assert.equal(vercelGitDeployDecision({ VERCEL_ENV: "development" }).skip, false)
})
