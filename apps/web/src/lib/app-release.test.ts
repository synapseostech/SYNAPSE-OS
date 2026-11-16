import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { compareAppVersions, readAppRelease } from "./app-release.ts"

const RELEASE = {
  SYNAPSE_APP_LATEST_VERSION: "1.3.0",
  SYNAPSE_APP_MIN_VERSION: "1.2.0",
  SYNAPSE_APP_APK_URL: "https://downloads.example.test/synapse-1.3.0.apk",
  SYNAPSE_APP_RELEASE_NOTES: "Tally import history and faster reports.",
}

describe("compareAppVersions", () => {
  it("orders by major, minor, then patch, numerically", () => {
    assert.equal(compareAppVersions("1.2.3", "1.3.0"), -1)
    assert.equal(compareAppVersions("1.10.0", "1.9.9"), 1)
    assert.equal(compareAppVersions("2.0.0", "2.0.0"), 0)
  })
})

describe("readAppRelease", () => {
  it("announces a fully configured release", () => {
    assert.deepEqual(readAppRelease(RELEASE), {
      latestVersion: "1.3.0",
      minimumVersion: "1.2.0",
      apkUrl: "https://downloads.example.test/synapse-1.3.0.apk",
      notes: "Tally import history and faster reports.",
    })
  })

  it("announces nothing without a valid version and an https download link", () => {
    assert.equal(readAppRelease({}), null)
    assert.equal(readAppRelease({ ...RELEASE, SYNAPSE_APP_LATEST_VERSION: "v1.3" }), null)
    assert.equal(readAppRelease({ ...RELEASE, SYNAPSE_APP_APK_URL: "http://insecure.example.test/a.apk" }), null)
    assert.equal(readAppRelease({ ...RELEASE, SYNAPSE_APP_APK_URL: "not a url" }), null)
  })

  it("drops a minimum that is malformed or above the latest", () => {
    assert.equal(readAppRelease({ ...RELEASE, SYNAPSE_APP_MIN_VERSION: "soon" })?.minimumVersion, null)
    assert.equal(readAppRelease({ ...RELEASE, SYNAPSE_APP_MIN_VERSION: "1.4.0" })?.minimumVersion, null)
  })

  it("keeps release notes to one short line", () => {
    const notes = readAppRelease({ ...RELEASE, SYNAPSE_APP_RELEASE_NOTES: "x".repeat(400) })?.notes
    assert.equal(notes?.length, 280)
    assert.equal(readAppRelease({ ...RELEASE, SYNAPSE_APP_RELEASE_NOTES: "  " })?.notes, null)
  })
})
