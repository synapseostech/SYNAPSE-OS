import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { classifyStatus, resolveSmokeInputs, runDeploymentSmoke } from "./release-deployment-smoke.mjs"

/**
 * The release workflow's deployment smoke runs against a live host, but the
 * decision logic — particularly the fail-closed path — is testable here locally
 * against a throwaway HTTP server. Nothing in this file touches a real deployment.
 */

const SHA = "81bc3c1fe15a9c993d0996fa316d736ed7bc51f6"

async function withServer(status, fn) {
  const server = createServer((_req, res) => {
    res.writeHead(status, { "content-type": "text/plain" })
    res.end("ok")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  try {
    return await fn(`http://127.0.0.1:${port}/`)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function withTmpRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), "synapse-release-smoke-"))
  try {
    return await fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function readReport(root) {
  return JSON.parse(readFileSync(join(root, "artifacts/readiness/deployment-smoke.json"), "utf8"))
}

test("an unconfigured PRODUCTION_URL blocks the release instead of passing it", async () => {
  await withTmpRoot(async (root) => {
    const result = await runDeploymentSmoke({ env: { RELEASE_SHA: SHA }, root })
    assert.equal(result.exitCode, 1)
    assert.equal(result.status, "BLOCKED")
    assert.match(result.reason, /PRODUCTION_URL is not configured/)
    const report = readReport(root)
    assert.equal(report.status, "BLOCKED")
    assert.equal(report.sha, SHA)
  })
})

test("an invalid release SHA is rejected", async () => {
  await withTmpRoot(async (root) => {
    const result = await runDeploymentSmoke({
      env: { RELEASE_SHA: "d186f91d", PRODUCTION_URL: "https://os.example.test" },
      root,
    })
    assert.equal(result.exitCode, 1)
    assert.match(result.reason, /40-character commit SHA/)
  })
})

test("resolveSmokeInputs rejects non-http targets", () => {
  const { problems } = resolveSmokeInputs({ RELEASE_SHA: SHA, PRODUCTION_URL: "os.example.test" })
  assert.deepEqual(problems, ["PRODUCTION_URL must be an absolute http(s) URL"])
})

test("a reachable deployment passes", async () => {
  await withTmpRoot((root) =>
    withServer(200, async (url) => {
      const result = await runDeploymentSmoke({ env: { RELEASE_SHA: SHA, PRODUCTION_URL: url }, root })
      assert.equal(result.exitCode, 0)
      assert.equal(result.status, "PASS")
      assert.equal(readReport(root).http_status, 200)
    }),
  )
})

test("an auth wall still counts as a live deployment", async () => {
  for (const status of [401, 403]) {
    await withTmpRoot((root) =>
      withServer(status, async (url) => {
        const result = await runDeploymentSmoke({ env: { RELEASE_SHA: SHA, PRODUCTION_URL: url }, root })
        assert.equal(result.exitCode, 0, `${status} should be accepted`)
        assert.equal(result.status, "PASS")
      }),
    )
  }
})

test("a server error fails the release", async () => {
  await withTmpRoot((root) =>
    withServer(503, async (url) => {
      const result = await runDeploymentSmoke({ env: { RELEASE_SHA: SHA, PRODUCTION_URL: url }, root })
      assert.equal(result.exitCode, 1)
      assert.equal(result.status, "FAIL")
      assert.equal(readReport(root).http_status, 503)
    }),
  )
})

test("an unreachable deployment fails rather than blocking quietly", async () => {
  await withTmpRoot(async (root) => {
    // Port 1 on loopback refuses connections on every platform we build for.
    const result = await runDeploymentSmoke({
      env: { RELEASE_SHA: SHA, PRODUCTION_URL: "http://127.0.0.1:1/" },
      root,
    })
    assert.equal(result.exitCode, 1)
    assert.equal(result.status, "FAIL")
    assert.match(readReport(root).reason, /deployment probe failed/)
  })
})

test("status classification", () => {
  for (const ok of [200, 204, 301, 302, 401, 403]) assert.equal(classifyStatus(ok), "PASS")
  for (const bad of [0, 404, 500, 503]) assert.equal(classifyStatus(bad), "FAIL")
})
