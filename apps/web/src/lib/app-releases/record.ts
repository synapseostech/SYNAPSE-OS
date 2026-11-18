/**
 * Turns a finished EAS Android build into an `app_releases` row.
 *
 * Two senders report a build, in the same signed envelope:
 *  - EAS itself, through a build webhook (`eas webhook:create --event BUILD`),
 *    for every build however it was started. Its body is the build, with the
 *    app version under `metadata`.
 *  - The "EAS Android preview APK" workflow, after `eas build --json --wait`,
 *    as `{ build, minimumVersion?, notes? }`, where `build` is the CLI's own
 *    JSON. It can also carry a minimum supported version for the release.
 *
 * Both are signed the way EAS signs its webhooks: `expo-signature:
 * sha1=<hex HMAC-SHA1 of the raw body>` with EAS_WEBHOOK_SECRET. Only a
 * finished Android build whose artifact is an .apk from a non-development
 * profile is announced; anything else is acknowledged and ignored, so EAS does
 * not keep retrying it.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { appVersion, directApkUrl, releaseNotes } from "../app-release"

export type ReleaseSource = "eas_webhook" | "workflow"

export type ReleaseCandidate = {
  version: string
  versionCode: number
  apkUrl: string
  notes: string | null
  minimumVersion: string | null
  easBuildId: string
  buildProfile: string | null
  gitCommit: string | null
  source: ReleaseSource
}

export type StoredRelease = ReleaseCandidate & { id: string; publishedAt: string }

export type ParseResult = { ok: true; release: ReleaseCandidate } | { ok: false; reason: string }

/** Profiles whose builds are for developers, never announced to users. */
const UNANNOUNCED_PROFILES = new Set(["development", "dev", "simulator"])

export function verifyExpoSignature(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  const expected = Buffer.from(`sha1=${createHmac("sha1", secret).update(rawBody, "utf8").digest("hex")}`)
  const received = Buffer.from(header.trim())
  return expected.length === received.length && timingSafeEqual(expected, received)
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function versionCode(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Reads either sender's body. The webhook nests the app's version under
 * `metadata`; the CLI's JSON has it at the top level. Both name the artifact
 * `artifacts.buildUrl`.
 */
export function parseBuildReport(body: unknown): ParseResult {
  const envelope = record(body)
  const fromWorkflow = "build" in envelope
  const build = record(fromWorkflow ? envelope.build : envelope)
  const metadata = record(build.metadata)
  const artifacts = record(build.artifacts)
  const pick = (key: string) => metadata[key] ?? build[key]

  const easBuildId = text(build.id)
  if (!easBuildId) return { ok: false, reason: "no build id" }
  if (String(build.platform ?? "").toLowerCase() !== "android") return { ok: false, reason: "not an Android build" }
  if (String(build.status ?? "").toLowerCase() !== "finished") return { ok: false, reason: "build not finished" }

  const buildProfile = text(pick("buildProfile"))
  if (buildProfile && UNANNOUNCED_PROFILES.has(buildProfile.toLowerCase())) {
    return { ok: false, reason: `profile ${buildProfile} is not announced` }
  }
  if (pick("developmentClient") === true) return { ok: false, reason: "development client build" }

  const version = appVersion(pick("appVersion"))
  if (!version) return { ok: false, reason: "no x.y.z app version" }
  const code = versionCode(pick("appBuildVersion"))
  if (!code) return { ok: false, reason: "no versionCode" }
  const apkUrl = directApkUrl(artifacts.buildUrl ?? artifacts.applicationArchiveUrl)
  if (!apkUrl) return { ok: false, reason: "artifact is not a direct .apk link" }

  return {
    ok: true,
    release: {
      version,
      versionCode: code,
      apkUrl,
      notes: releaseNotes(fromWorkflow && text(envelope.notes) ? envelope.notes : pick("message")),
      minimumVersion: fromWorkflow ? appVersion(envelope.minimumVersion) : null,
      easBuildId,
      buildProfile,
      gitCommit: text(pick("gitCommitHash")),
      source: fromWorkflow ? "workflow" : "eas_webhook",
    },
  }
}

export interface ReleaseWriter {
  /**
   * Inserts the release, or — when this versionCode is already recorded, as
   * when the webhook and the workflow both report one build — refreshes its
   * link and keeps notes and minimum it already has unless new ones are given.
   */
  upsert(release: ReleaseCandidate): Promise<{ release: StoredRelease; created: boolean }>
  /** The highest versionCode recorded, or null. */
  latestVersionCode(): Promise<number | null>
}

export type RecordOutcome = {
  release: StoredRelease
  created: boolean
  /** No newer versionCode is recorded: this is the release devices should see. */
  isLatest: boolean
}

export async function recordAppRelease(writer: ReleaseWriter, candidate: ReleaseCandidate): Promise<RecordOutcome> {
  const { release, created } = await writer.upsert(candidate)
  const latest = await writer.latestVersionCode()
  return { release, created, isLatest: latest === null || release.versionCode >= latest }
}
