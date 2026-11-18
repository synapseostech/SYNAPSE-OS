import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { resolveAppRelease } from "../app-release"
import {
  announceReleaseByEmail,
  releaseRecipients,
  unsubscribeToken,
  verifyUnsubscribeToken,
  type ReleaseEmailMessage,
  type ReleaseEmailStore,
} from "./email"
import {
  parseBuildReport,
  recordAppRelease,
  verifyExpoSignature,
  type ReleaseCandidate,
  type ReleaseWriter,
  type StoredRelease,
} from "./record"

const APK = "https://expo.dev/artifacts/eas/aBcD123.apk"

/** The body EAS posts to a build webhook. */
function webhookBody(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  return {
    id: "build-1",
    platform: "android",
    status: "finished",
    artifacts: { buildUrl: APK },
    metadata: {
      appVersion: "1.4.0",
      appBuildVersion: "9",
      buildProfile: "preview",
      gitCommitHash: "abc123",
      message: "Stock take on the phone\nmore details",
      ...metadata,
    },
    ...overrides,
  }
}

/** The envelope the workflow posts around `eas build --json`. */
function workflowBody(extra: Record<string, unknown> = {}) {
  return {
    build: {
      id: "build-1",
      platform: "ANDROID",
      status: "FINISHED",
      artifacts: { buildUrl: APK },
      appVersion: "1.4.0",
      appBuildVersion: "9",
      buildProfile: "preview",
      gitCommitHash: "abc123",
      message: "Stock take on the phone",
    },
    ...extra,
  }
}

describe("verifyExpoSignature", () => {
  const raw = JSON.stringify(webhookBody())
  const sign = (secret: string) => `sha1=${createHmac("sha1", secret).update(raw).digest("hex")}`

  it("accepts the body signed with the shared secret", () => {
    expect(verifyExpoSignature(raw, sign("s3cret"), "s3cret")).toBe(true)
  })

  it("refuses a wrong secret, a changed body, no header or no configured secret", () => {
    expect(verifyExpoSignature(raw, sign("other"), "s3cret")).toBe(false)
    expect(verifyExpoSignature(`${raw} `, sign("s3cret"), "s3cret")).toBe(false)
    expect(verifyExpoSignature(raw, null, "s3cret")).toBe(false)
    expect(verifyExpoSignature(raw, sign("s3cret"), undefined)).toBe(false)
  })
})

describe("parseBuildReport", () => {
  it("reads an EAS webhook body", () => {
    expect(parseBuildReport(webhookBody())).toEqual({
      ok: true,
      release: {
        version: "1.4.0",
        versionCode: 9,
        apkUrl: APK,
        notes: "Stock take on the phone",
        minimumVersion: null,
        easBuildId: "build-1",
        buildProfile: "preview",
        gitCommit: "abc123",
        source: "eas_webhook",
      },
    })
  })

  it("reads the workflow's envelope, with its minimum version and notes", () => {
    const parsed = parseBuildReport(workflowBody({ minimumVersion: "1.2.0", notes: "Printing fixes" }))
    expect(parsed.ok && parsed.release).toMatchObject({
      version: "1.4.0",
      versionCode: 9,
      apkUrl: APK,
      minimumVersion: "1.2.0",
      notes: "Printing fixes",
      source: "workflow",
    })
  })

  it("ignores builds that must not be announced", () => {
    const reason = (body: unknown) => {
      const parsed = parseBuildReport(body)
      return parsed.ok ? null : parsed.reason
    }
    expect(reason(webhookBody({ platform: "ios" }))).toMatch(/Android/)
    expect(reason(webhookBody({ status: "errored" }))).toMatch(/finished/)
    expect(reason(webhookBody({}, { buildProfile: "development" }))).toMatch(/not announced/)
    expect(reason(webhookBody({ artifacts: { buildUrl: "https://expo.dev/artifacts/eas/x.aab" } }))).toMatch(/\.apk/)
    expect(reason(webhookBody({ artifacts: {} }))).toMatch(/\.apk/)
    expect(reason(webhookBody({}, { appVersion: "1.4" }))).toMatch(/version/)
    expect(reason(webhookBody({}, { appBuildVersion: "zero" }))).toMatch(/versionCode/)
    expect(reason(null)).toMatch(/build id/)
  })
})

/** An in-memory app_releases table with the same upsert rules as the store. */
function memoryReleases() {
  const rows: StoredRelease[] = []
  const writer: ReleaseWriter = {
    async upsert(candidate: ReleaseCandidate) {
      const existing = rows.find((row) => row.versionCode === candidate.versionCode)
      if (existing) {
        Object.assign(existing, {
          apkUrl: candidate.apkUrl,
          easBuildId: candidate.easBuildId,
          ...(candidate.notes ? { notes: candidate.notes } : {}),
          ...(candidate.minimumVersion ? { minimumVersion: candidate.minimumVersion } : {}),
        })
        return { release: { ...existing }, created: false }
      }
      const release = { ...candidate, id: `rel-${candidate.versionCode}`, publishedAt: "2026-11-18T10:00:00.000Z" }
      rows.push(release)
      return { release: { ...release }, created: true }
    },
    async latestVersionCode() {
      return rows.length ? Math.max(...rows.map((row) => row.versionCode)) : null
    },
  }
  const reader = {
    async latest() {
      const top = [...rows].sort((a, b) => b.versionCode - a.versionCode)[0]
      return top
        ? {
            version: top.version,
            version_code: top.versionCode,
            apk_url: top.apkUrl,
            notes: top.notes,
            minimum_version: top.minimumVersion,
            published_at: top.publishedAt,
          }
        : null
    },
  }
  return { rows, writer, reader }
}

function candidate(body: unknown): ReleaseCandidate {
  const parsed = parseBuildReport(body)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.release
}

describe("recordAppRelease", () => {
  it("records a new build once, however many times it is reported", async () => {
    const { rows, writer } = memoryReleases()
    const first = await recordAppRelease(writer, candidate(webhookBody()))
    const again = await recordAppRelease(writer, candidate(workflowBody({ minimumVersion: "1.2.0" })))
    expect(first).toMatchObject({ created: true, isLatest: true })
    expect(again).toMatchObject({ created: false, isLatest: true })
    expect(rows).toHaveLength(1)
    // The workflow's minimum is kept; the webhook's notes are not wiped.
    expect(rows[0]).toMatchObject({ minimumVersion: "1.2.0", notes: "Stock take on the phone" })
  })

  it("says an older build is not the latest", async () => {
    const { writer } = memoryReleases()
    await recordAppRelease(writer, candidate(webhookBody({ id: "b10" }, { appVersion: "1.5.0", appBuildVersion: 10 })))
    const older = await recordAppRelease(writer, candidate(webhookBody()))
    expect(older.isLatest).toBe(false)
  })
})

describe("resolveAppRelease", () => {
  const ENV = {
    SYNAPSE_APP_LATEST_VERSION: "1.3.0",
    SYNAPSE_APP_APK_URL: "https://downloads.example.test/synapse-1.3.0.apk",
    SYNAPSE_APP_MIN_VERSION: "1.1.0",
  }

  it("answers from the newest recorded release, with no variables set", async () => {
    const { writer, reader } = memoryReleases()
    await recordAppRelease(writer, candidate(webhookBody()))
    await recordAppRelease(writer, candidate(webhookBody({ id: "b10" }, { appVersion: "1.5.0", appBuildVersion: 10 })))
    expect(await resolveAppRelease(reader, {})).toEqual({
      latestVersion: "1.5.0",
      minimumVersion: null,
      apkUrl: APK,
      notes: "Stock take on the phone",
      versionCode: 10,
      publishedAt: "2026-11-18T10:00:00.000Z",
    })
  })

  it("takes the deployment's minimum when the release carries none", async () => {
    const { writer, reader } = memoryReleases()
    await recordAppRelease(writer, candidate(webhookBody()))
    expect((await resolveAppRelease(reader, ENV))?.minimumVersion).toBe("1.1.0")
  })

  it("falls back to the variables while the table is empty or unreachable", async () => {
    const { reader } = memoryReleases()
    expect((await resolveAppRelease(reader, ENV))?.latestVersion).toBe("1.3.0")
    const broken = { latest: async () => Promise.reject(new Error("db down")) }
    expect((await resolveAppRelease(broken, ENV))?.latestVersion).toBe("1.3.0")
    expect(await resolveAppRelease(reader, {})).toBeNull()
  })
})

describe("release recipients and opt-out links", () => {
  it("emails admins and opted-in people once each, minus everyone who opted out", () => {
    expect(
      releaseRecipients(
        ["Admin@Clinic.test", "owner@pharm.test", "not-an-email"],
        ["fan@example.test", "admin@clinic.test"],
        ["OWNER@pharm.test"],
      ),
    ).toEqual(["admin@clinic.test", "fan@example.test"])
  })

  it("signs the opt-out link for one address only", () => {
    const token = unsubscribeToken("admin@clinic.test", "k")
    expect(verifyUnsubscribeToken(token, "k")).toBe("admin@clinic.test")
    expect(verifyUnsubscribeToken(token, "other")).toBeNull()
    const forged = `${Buffer.from("victim@clinic.test").toString("base64url")}.${token.split(".")[1]}`
    expect(verifyUnsubscribeToken(forged, "k")).toBeNull()
    expect(verifyUnsubscribeToken("garbage", "k")).toBeNull()
  })
})

/** An in-memory delivery ledger keyed like the unique (release_id, email). */
function memoryEmailStore(people: { admins?: string[]; optedIn?: string[]; optedOut?: string[] }) {
  const deliveries = new Map<string, { status: string; providerId?: string | null }>()
  const store: ReleaseEmailStore = {
    adminEmails: async () => people.admins ?? [],
    optedInEmails: async () => people.optedIn ?? [],
    optedOutEmails: async () => people.optedOut ?? [],
    async claim(releaseId, emails) {
      const claimed: string[] = []
      for (const email of emails) {
        const key = `${releaseId}|${email}`
        if (!deliveries.has(key)) {
          deliveries.set(key, { status: "pending" })
          claimed.push(email)
        }
      }
      return claimed
    },
    async markSent(releaseId, email, providerId) {
      deliveries.set(`${releaseId}|${email}`, { status: "sent", providerId })
    },
    async markFailed(releaseId, email) {
      deliveries.set(`${releaseId}|${email}`, { status: "failed" })
    },
  }
  return { store, deliveries }
}

describe("announceReleaseByEmail", () => {
  const release: StoredRelease = {
    ...candidate(webhookBody()),
    id: "rel-9",
    publishedAt: "2026-11-18T10:00:00.000Z",
  }
  const render = ({ body, unsubscribeUrl }: { subject: string; body: string; unsubscribeUrl: string }) =>
    `<html>${body}<a href="${unsubscribeUrl}">Unsubscribe</a></html>`

  function run(store: ReleaseEmailStore, sent: ReleaseEmailMessage[], fail?: string) {
    return announceReleaseByEmail({
      release,
      store,
      render,
      secret: "k",
      baseUrl: "https://synapseos.tech",
      send: async (message) => {
        if (message.to === fail) throw new Error("mailbox full")
        sent.push(message)
        return { id: `msg-${sent.length}` }
      },
    })
  }

  it("sends each recipient the direct .apk link and a working opt-out, exactly once per release", async () => {
    const { store, deliveries } = memoryEmailStore({
      admins: ["admin@clinic.test", "ceo@pharm.test"],
      optedIn: ["fan@example.test"],
      optedOut: ["ceo@pharm.test"],
    })
    const sent: ReleaseEmailMessage[] = []

    expect(await run(store, sent)).toEqual({ recipients: 2, claimed: 2, sent: 2, failed: 0 })
    // The webhook redelivered, or the workflow reported the same build.
    expect(await run(store, sent)).toEqual({ recipients: 2, claimed: 0, sent: 0, failed: 0 })

    expect(sent.map((message) => message.to)).toEqual(["admin@clinic.test", "fan@example.test"])
    for (const message of sent) {
      expect(message.subject).toContain("1.4.0")
      expect(message.html).toContain(`href="${APK}"`)
      expect(message.text).toContain(APK)
      const optOut = new URL(message.headers["List-Unsubscribe"]!.slice(1, -1))
      expect(optOut.pathname).toBe("/api/mobile/app-releases/unsubscribe")
      expect(verifyUnsubscribeToken(optOut.searchParams.get("t"), "k")).toBe(message.to)
      expect(message.html).toContain(`href="${optOut.toString()}"`)
    }
    expect([...deliveries.values()].every((delivery) => delivery.status === "sent")).toBe(true)
  })

  it("marks a failed send and does not resend it on the next report", async () => {
    const { store, deliveries } = memoryEmailStore({ admins: ["a@clinic.test", "b@clinic.test"] })
    const sent: ReleaseEmailMessage[] = []
    expect(await run(store, sent, "a@clinic.test")).toMatchObject({ sent: 1, failed: 1 })
    expect(deliveries.get("rel-9|a@clinic.test")?.status).toBe("failed")
    expect(await run(store, sent)).toMatchObject({ claimed: 0, sent: 0 })
    expect(sent.map((message) => message.to)).toEqual(["b@clinic.test"])
  })

  it("emails a new release to people the last one already reached", async () => {
    const { store } = memoryEmailStore({ admins: ["a@clinic.test"] })
    const sent: ReleaseEmailMessage[] = []
    await run(store, sent)
    await announceReleaseByEmail({
      release: { ...release, id: "rel-10", version: "1.5.0", versionCode: 10 },
      store,
      render,
      secret: "k",
      baseUrl: "https://synapseos.tech",
      send: async (message) => {
        sent.push(message)
        return { id: null }
      },
    })
    expect(sent.map((message) => message.subject)).toEqual([
      "Synapse 1.4.0 for Android is ready to install",
      "Synapse 1.5.0 for Android is ready to install",
    ])
  })
})
