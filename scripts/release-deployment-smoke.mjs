#!/usr/bin/env node
/**
 * Release deployment smoke check.
 *
 * A release is only verified if the deployed build actually answers. This script
 * probes PRODUCTION_URL, writes artifacts/readiness/deployment-smoke.json, and
 * exits non-zero when it could not verify anything — including when the URL is
 * unconfigured. Exiting 0 on "BLOCKED" would green-light an unverified release.
 *
 * Usage: RELEASE_SHA=<40-hex> PRODUCTION_URL=https://host node scripts/release-deployment-smoke.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const TIMEOUT_MS = 15_000
const ACCEPTED_STATUS = /^(2\d\d|3\d\d|401|403)$/

export function classifyStatus(status) {
  return ACCEPTED_STATUS.test(String(status)) ? "PASS" : "FAIL"
}

export function resolveSmokeInputs(env = process.env) {
  const sha = (env.RELEASE_SHA ?? "").trim()
  const url = (env.PRODUCTION_URL ?? "").trim()
  const problems = []
  if (!/^[0-9a-f]{40}$/i.test(sha)) problems.push("RELEASE_SHA must be a full 40-character commit SHA")
  if (!url) problems.push("PRODUCTION_URL is not configured")
  else if (!/^https?:\/\//i.test(url)) problems.push("PRODUCTION_URL must be an absolute http(s) URL")
  return { sha, url, problems }
}

async function probe(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  return response.status
}

function writeReport(root, report) {
  mkdirSync(join(root, "artifacts/readiness"), { recursive: true })
  writeFileSync(
    join(root, "artifacts/readiness/deployment-smoke.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  )
}

export async function runDeploymentSmoke({ env = process.env, root = process.cwd() } = {}) {
  const { sha, url, problems } = resolveSmokeInputs(env)

  if (problems.length > 0) {
    writeReport(root, { status: "BLOCKED", reason: problems.join("; "), sha })
    return { exitCode: 1, status: "BLOCKED", reason: problems.join("; ") }
  }

  let httpStatus
  try {
    httpStatus = await probe(url)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    writeReport(root, { status: "FAIL", reason: `deployment probe failed: ${reason}`, sha, url })
    return { exitCode: 1, status: "FAIL", reason }
  }

  const status = classifyStatus(httpStatus)
  writeReport(root, { status, http_status: httpStatus, sha, url })
  return { exitCode: status === "PASS" ? 0 : 1, status, httpStatus }
}

async function main() {
  const result = await runDeploymentSmoke()
  if (result.exitCode === 0) {
    console.log(`Deployment smoke PASS http_status=${result.httpStatus}`)
    return
  }
  console.error(`::error::Deployment smoke ${result.status} — release is not verified (${result.reason ?? `http_status=${result.httpStatus}`})`)
  process.exitCode = 1
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) await main()
