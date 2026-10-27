import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * The hospital browser smoke used to write BLOCKED and exit 0 when no target was
 * configured, so a pipeline could report a passing browser surface that was never
 * opened. These tests pin the fail-closed default and the explicit local opt-out.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const script = join(root, "scripts/e2e-hospital-browser.mjs")

function runWith({ allowBlocked } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "synapse-browser-smoke-"))
  try {
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      // Deliberately no PLAYWRIGHT_BASE_URL / SYNAPSE_E2E_BASE_URL.
      ...(allowBlocked ? { SYNAPSE_E2E_SMOKE_ALLOW_BLOCKED: "1" } : {}),
    }
    const result = spawnSync(process.execPath, [script], { cwd, env, encoding: "utf8", timeout: 60_000 })
    const artifactPath = join(cwd, "artifacts/readiness/hospital-browser-journey.json")
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
    return { status: result.status, stderr: result.stderr ?? "", artifact }
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test("a missing smoke target fails instead of reporting success", () => {
  const { status, stderr, artifact } = runWith()
  assert.equal(status, 1, "the smoke must exit non-zero when it has no target")
  assert.equal(artifact.status, "BLOCKED")
  assert.equal(artifact.explicitly_allowed, false)
  assert.match(stderr, /BLOCKED/)
  assert.match(stderr, /Refusing to report success/)
})

test("an intentional local skip must be stated explicitly", () => {
  const { status, artifact } = runWith({ allowBlocked: true })
  assert.equal(status, 0)
  assert.equal(artifact.status, "BLOCKED")
  assert.equal(artifact.explicitly_allowed, true)
})
