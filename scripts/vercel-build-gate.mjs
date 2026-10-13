#!/usr/bin/env node
/**
 * Vercel ignoreCommand gate — exit 1 = build, exit 0 = skip (cancel deploy).
 * @see https://vercel.com/docs/project-configuration/vercel-json#ignorecommand
 *
 * All environments build: preview, development, demo production, and OS/Pharmacy
 * production Git deploys to main.
 *
 * Do not run type-check here: ignoreCommand often runs before install, which
 * would cancel every OS preview.
 */
import { pathToFileURL } from "node:url"

export function vercelGitDeployDecision(env = process.env) {
  // Production deployments (git push to main) always build
  if (env.VERCEL_ENV === "production") {
    const productionUrl = env.VERCEL_PROJECT_PRODUCTION_URL ?? ""
    const isDemoProject = productionUrl.includes("demo.synapseos.tech")
    if (isDemoProject) {
      return { skip: false, reason: "demo production host" }
    }
    return { skip: false, reason: "production OS/Pharmacy git deploy to main" }
  }

  // Preview deployments: only build for main branch and explicitly tagged branches
  if (env.VERCEL_ENV === "preview") {
    const gitBranch = env.VERCEL_GIT_COMMIT_REF ?? env.VERCEL_GITHUB_PULL_REQUEST_HEAD_REF ?? ""
    const isMainBranch = gitBranch === "main" || gitBranch === "master"
    const isReleaseBranch = gitBranch.startsWith("release/")
    const isHotfixBranch = gitBranch.startsWith("hotfix/")
    const isClinicalStaging = gitBranch.startsWith("clinical/") || gitBranch.startsWith("staging/")
    const isIntegrationBranch = gitBranch.startsWith("integration/")
    const isFixBranch = gitBranch.startsWith("fix/")
    const isFeatureBranch = gitBranch.startsWith("feat/")

    if (isMainBranch || isReleaseBranch || isHotfixBranch || isClinicalStaging || isIntegrationBranch || isFixBranch || isFeatureBranch) {
      return { skip: false, reason: `preview for ${gitBranch || "main"} branch` }
    }
    return { skip: true, reason: `skip preview for unrecognized branch ${gitBranch || "unknown"}` }
  }

  // Development environment (vercel dev) always builds
  return { skip: false, reason: "development environment" }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) {
  const decision = vercelGitDeployDecision()
  if (decision.skip) {
    console.log(`[vercel-build-gate] Skipping Git production deploy. ${decision.reason}`)
    process.exit(0)
  }
  console.log(`[vercel-build-gate] ${decision.reason} — proceeding with Vercel build.`)
  process.exit(1)
}
