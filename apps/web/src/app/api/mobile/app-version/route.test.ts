import { beforeEach, describe, expect, it, vi } from "vitest"

const s = vi.hoisted(() => ({ row: null as any, fail: false }))

vi.mock("../../../../lib/app-releases/store", () => ({
  appReleaseReader: {
    latest: async () => {
      if (s.fail) throw new Error("db down")
      return s.row
    },
  },
}))

import { GET } from "./route"

describe("GET /api/mobile/app-version", () => {
  beforeEach(() => {
    s.row = null
    s.fail = false
    vi.unstubAllEnvs()
    for (const key of ["SYNAPSE_APP_LATEST_VERSION", "SYNAPSE_APP_MIN_VERSION", "SYNAPSE_APP_APK_URL", "SYNAPSE_APP_RELEASE_NOTES"]) {
      vi.stubEnv(key, "")
    }
  })

  it("answers with the newest recorded release and its direct .apk link", async () => {
    s.row = {
      version: "1.4.0",
      version_code: 9,
      apk_url: "https://expo.dev/artifacts/eas/aBcD123.apk",
      notes: "Stock take on the phone",
      minimum_version: "1.2.0",
      published_at: "2026-11-18T10:00:00.000Z",
    }
    const response = await GET()
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
    expect(await response.json()).toEqual({
      latestVersion: "1.4.0",
      minimumVersion: "1.2.0",
      apkUrl: "https://expo.dev/artifacts/eas/aBcD123.apk",
      notes: "Stock take on the phone",
      versionCode: 9,
      publishedAt: "2026-11-18T10:00:00.000Z",
    })
  })

  it("falls back to the deployment variables when no release is recorded or the table fails", async () => {
    vi.stubEnv("SYNAPSE_APP_LATEST_VERSION", "1.3.0")
    vi.stubEnv("SYNAPSE_APP_APK_URL", "https://downloads.example.test/synapse-1.3.0.apk")
    expect((await (await GET()).json()).latestVersion).toBe("1.3.0")
    s.fail = true
    expect((await (await GET()).json()).latestVersion).toBe("1.3.0")
  })

  it("says there is no release when neither source has one", async () => {
    expect(await (await GET()).json()).toMatchObject({ latestVersion: null, apkUrl: null })
  })
})
