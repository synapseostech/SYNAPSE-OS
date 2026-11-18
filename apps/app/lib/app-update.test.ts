import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  REMIND_AGAIN_MS,
  UPDATE_CHECK_INTERVAL_MS,
  decideApkUpdate,
  isDirectApkUrl,
  parseDismissal,
  serialiseDismissal,
  shouldCheckForUpdates,
} from "./app-update.ts"

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

  const NOW = 1_800_000_000_000

  it("respects a dismissed optional update for a day, but never a required one", () => {
    const justNow = { version: "1.4.0", at: NOW - 60_000 }
    assert.equal(decideApkUpdate("1.3.0", RELEASE, justNow, NOW).kind, "none")
    assert.equal(decideApkUpdate("1.1.0", RELEASE, justNow, NOW).kind, "required")
  })

  it("reminds again a day after the update was dismissed", () => {
    const dismissed = { version: "1.4.0", at: NOW }
    assert.equal(decideApkUpdate("1.3.0", RELEASE, dismissed, NOW + REMIND_AGAIN_MS - 1).kind, "none")
    assert.equal(decideApkUpdate("1.3.0", RELEASE, dismissed, NOW + REMIND_AGAIN_MS).kind, "optional")
  })

  it("offers again at once when a newer version than the dismissed one ships", () => {
    assert.equal(decideApkUpdate("1.3.0", RELEASE, { version: "1.3.5", at: NOW }, NOW).kind, "optional")
  })

  it("only offers a direct .apk download, never a page", () => {
    assert.equal(decideApkUpdate("1.3.0", { ...RELEASE, apkUrl: "https://synapseos.tech/download" }).kind, "none")
    assert.equal(decideApkUpdate("1.1.0", { ...RELEASE, apkUrl: "https://synapseos.tech/download" }).kind, "none")
    const recorded = { ...RELEASE, apkUrl: "https://expo.dev/artifacts/eas/aBcD123.apk", versionCode: 9 }
    assert.deepEqual(decideApkUpdate("1.3.0", recorded), {
      kind: "optional",
      version: "1.4.0",
      apkUrl: "https://expo.dev/artifacts/eas/aBcD123.apk",
      notes: "Faster reports.",
    })
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

describe("isDirectApkUrl", () => {
  it("accepts only https links to an .apk file", () => {
    assert.equal(isDirectApkUrl("https://expo.dev/artifacts/eas/aBcD123.apk"), true)
    assert.equal(isDirectApkUrl("https://downloads.example.test/Synapse.APK?sig=1"), true)
    assert.equal(isDirectApkUrl("http://downloads.example.test/synapse.apk"), false)
    assert.equal(isDirectApkUrl("https://expo.dev/accounts/x/projects/y/builds/z"), false)
    assert.equal(isDirectApkUrl("not a url"), false)
    assert.equal(isDirectApkUrl(null), false)
  })
})

describe("parseDismissal", () => {
  it("round-trips what dismissApk stores", () => {
    const dismissal = { version: "1.4.0", at: 1_800_000_000_000 }
    assert.deepEqual(parseDismissal(serialiseDismissal(dismissal)), dismissal)
  })

  it("treats an older build's bare version as long expired, and junk as nothing", () => {
    assert.deepEqual(parseDismissal("1.4.0"), { version: "1.4.0", at: 0 })
    assert.equal(decideApkUpdate("1.3.0", RELEASE, parseDismissal("1.4.0")).kind, "optional")
    assert.equal(parseDismissal("{not json"), null)
    assert.equal(parseDismissal(JSON.stringify({ version: "1.4.0" })), null)
    assert.equal(parseDismissal(null), null)
  })
})

describe("shouldCheckForUpdates", () => {
  it("checks on first launch and then at most every interval", () => {
    assert.equal(shouldCheckForUpdates(null, 1_000), true)
    assert.equal(shouldCheckForUpdates(1_000, 1_000 + UPDATE_CHECK_INTERVAL_MS - 1), false)
    assert.equal(shouldCheckForUpdates(1_000, 1_000 + UPDATE_CHECK_INTERVAL_MS), true)
  })
})
