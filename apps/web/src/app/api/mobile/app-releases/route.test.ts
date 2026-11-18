import { createHmac } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"

const s = vi.hoisted(() => ({
  releases: [] as any[],
  deliveries: new Set<string>(),
  emails: [] as any[],
}))

vi.mock("../../../../lib/resend", () => ({
  FROM_EMAIL: "noreply@synapseos.tech",
  FROM_NAME: "Synapse OS",
  brandedEmail: ({ body, unsubscribeUrl }: any) => `<html>${body}<a href="${unsubscribeUrl}">Unsubscribe</a></html>`,
  resend: {
    emails: {
      send: async (payload: any) => {
        s.emails.push(payload)
        return { data: { id: `re_${s.emails.length}` } }
      },
    },
  },
}))

vi.mock("../../../../lib/app-releases/store", () => ({
  appReleaseWriter: {
    async upsert(candidate: any) {
      const existing = s.releases.find((row) => row.versionCode === candidate.versionCode)
      if (existing) return { release: existing, created: false }
      const release = { ...candidate, id: `rel-${candidate.versionCode}`, publishedAt: "2026-11-18T10:00:00.000Z" }
      s.releases.push(release)
      return { release, created: true }
    },
    async latestVersionCode() {
      return s.releases.length ? Math.max(...s.releases.map((row) => row.versionCode)) : null
    },
  },
  releaseEmailStore: {
    adminEmails: async () => ["admin@clinic.test"],
    optedInEmails: async () => ["fan@example.test"],
    optedOutEmails: async () => [],
    async claim(releaseId: string, emails: string[]) {
      return emails.filter((email) => {
        const key = `${releaseId}|${email}`
        if (s.deliveries.has(key)) return false
        s.deliveries.add(key)
        return true
      })
    },
    markSent: async () => {},
    markFailed: async () => {},
  },
}))

import { NextRequest } from "next/server"
import { POST } from "./route"

const SECRET = "webhook-secret"
const BUILD = {
  id: "build-1",
  platform: "android",
  status: "finished",
  artifacts: { buildUrl: "https://expo.dev/artifacts/eas/aBcD123.apk" },
  metadata: { appVersion: "1.4.0", appBuildVersion: "9", buildProfile: "preview", message: "Stock take" },
}

function post(body: unknown, secret = SECRET) {
  const raw = JSON.stringify(body)
  return POST(
    new NextRequest("https://synapseos.tech/api/mobile/app-releases", {
      method: "POST",
      body: raw,
      headers: { "expo-signature": `sha1=${createHmac("sha1", secret).update(raw).digest("hex")}` },
    }),
  )
}

describe("POST /api/mobile/app-releases", () => {
  beforeEach(() => {
    s.releases = []
    s.deliveries = new Set()
    s.emails = []
    vi.stubEnv("EAS_WEBHOOK_SECRET", SECRET)
    vi.stubEnv("APP_RELEASE_EMAIL_SECRET", "")
  })

  it("records a finished APK build and emails it once, even when reported twice", async () => {
    const first = await post(BUILD)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({
      recorded: true,
      created: true,
      latest: true,
      version: "1.4.0",
      versionCode: 9,
      email: { recipients: 2, sent: 2, failed: 0 },
    })
    const second = await post({ build: { ...BUILD, ...BUILD.metadata, metadata: undefined } })
    expect(await second.json()).toMatchObject({ recorded: true, created: false, email: { claimed: 0, sent: 0 } })

    expect(s.releases).toHaveLength(1)
    expect(s.emails.map((email) => email.to[0])).toEqual(["admin@clinic.test", "fan@example.test"])
    expect(s.emails[0].html).toContain('href="https://expo.dev/artifacts/eas/aBcD123.apk"')
    expect(s.emails[0].headers["List-Unsubscribe"]).toMatch(/^<https:\/\/synapseos\.tech\/api\/mobile\/app-releases\/unsubscribe\?t=/)
  })

  it("does not email when an older build is reported after a newer one", async () => {
    await post({ ...BUILD, id: "b10", metadata: { ...BUILD.metadata, appVersion: "1.5.0", appBuildVersion: "10" } })
    s.emails = []
    const response = await post(BUILD)
    expect(await response.json()).toMatchObject({ recorded: true, latest: false, email: null })
    expect(s.emails).toHaveLength(0)
  })

  it("refuses an unsigned or wrongly signed report, and records nothing", async () => {
    expect((await post(BUILD, "guess")).status).toBe(401)
    const unsigned = await POST(
      new NextRequest("https://synapseos.tech/api/mobile/app-releases", { method: "POST", body: JSON.stringify(BUILD) }),
    )
    expect(unsigned.status).toBe(401)
    expect(s.releases).toHaveLength(0)
  })

  it("is closed until the secret is configured", async () => {
    vi.stubEnv("EAS_WEBHOOK_SECRET", "")
    expect((await post(BUILD)).status).toBe(503)
  })

  it("acknowledges builds it does not announce, so EAS stops retrying", async () => {
    const response = await post({ ...BUILD, artifacts: { buildUrl: "https://expo.dev/artifacts/eas/x.aab" } })
    expect(response.status).toBe(202)
    expect(s.releases).toHaveLength(0)
  })
})
