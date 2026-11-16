import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { UPDATE_CHECK_INTERVAL_MS, decideApkUpdate, shouldCheckForUpdates } from "./app-update.ts"

const RELEASE = {
  latestVersion: "1.4.0",
  minimumVersion: "1.2.0",
  apkUrl: "https://downloads.example.test/synapse-1.4.0.apk",
  notes: "Faster reports.",
}

describe("decideApkUpdate", () => {
  it("offers a newer APK", () => {
    assert.deepEqual(decideApkUpdate("1.3.0", RELEASE), {
      kind: "optional",
      version: "1.4.0",
      apkUrl: RELEASE.apkUrl,
      notes: "Faster reports.",
    })
  })

  it("requires the update when this install is below the supported minimum", () => {
    assert.equal(decideApkUpdate("1.1.9", RELEASE).kind, "required")
  })

  it("stays quiet when already on the latest or newer", () => {
    assert.equal(decideApkUpdate("1.4.0", RELEASE).kind, "none")
    assert.equal(decideApkUpdate("1.5.0", RELEASE).kind, "none")
  })

  it("respects a dismissed optional update, but never a required one", () => {
    assert.equal(decideApkUpdate("1.3.0", RELEASE, "1.4.0").kind, "none")
    assert.equal(decideApkUpdate("1.1.0", RELEASE, "1.4.0").kind, "required")
  })

  it("offers again once a newer version than the dismissed one ships", () => {
    assert.equal(decideApkUpdate("1.3.0", RELEASE, "1.3.5").kind, "optional")
  })

  it("does nothing without a known install version or a complete https release", () => {
    assert.equal(decideApkUpdate(null, RELEASE).kind, "none")
    assert.equal(decideApkUpdate("dev", RELEASE).kind, "none")
    assert.equal(decideApkUpdate("1.3.0", null).kind, "none")
    assert.equal(decideApkUpdate("1.3.0", { ...RELEASE, apkUrl: null }).kind, "none")
    assert.equal(decideApkUpdate("1.3.0", { ...RELEASE, apkUrl: "http://plain.example.test/a.apk" }).kind, "none")
    assert.equal(decideApkUpdate("1.3.0", { ...RELEASE, latestVersion: null }).kind, "none")
  })
})

describe("shouldCheckForUpdates", () => {
  it("checks on first launch and then at most every interval", () => {
    assert.equal(shouldCheckForUpdates(null, 1_000), true)
    assert.equal(shouldCheckForUpdates(1_000, 1_000 + UPDATE_CHECK_INTERVAL_MS - 1), false)
    assert.equal(shouldCheckForUpdates(1_000, 1_000 + UPDATE_CHECK_INTERVAL_MS), true)
  })
})
