/**
 * The mobile app's latest release, as the server announces it.
 *
 * The APK is installed outside any app store, so nothing tells an installed
 * copy that a newer one exists. The app asks GET /api/mobile/app-version on
 * start and on resume; this decides what that answers.
 *
 * Every finished EAS Android build is recorded in `app_releases` (see
 * app-release-record.ts), and the newest row is the answer. While the table is
 * empty or unreachable, four deployment variables still announce a release:
 *
 *   SYNAPSE_APP_LATEST_VERSION   e.g. 1.3.0 — the newest APK
 *   SYNAPSE_APP_MIN_VERSION      e.g. 1.2.0 — older installs must update first
 *                                (also the minimum for a recorded release that
 *                                does not carry its own)
 *   SYNAPSE_APP_APK_URL          direct https:// link to the .apk file
 *   SYNAPSE_APP_RELEASE_NOTES    one line shown with the prompt
 *
 * Anything missing or malformed is dropped rather than guessed. The link must
 * be the .apk file itself — a page would leave the user one more step from
 * installing — and with no valid version or direct link the answer says there
 * is no release, so a half-configured deployment never sends users astray.
 */

export type AppRelease = {
  latestVersion: string
  minimumVersion: string | null
  apkUrl: string
  notes: string | null
  versionCode: number | null
  publishedAt: string | null
}

/** The columns of `app_releases` this reads. */
export type AppReleaseRow = {
  version: string
  version_code: number
  apk_url: string
  notes: string | null
  minimum_version: string | null
  published_at: string | null
}

export interface AppReleaseReader {
  /** The newest recorded Android release, or null when none is recorded. */
  latest(): Promise<AppReleaseRow | null>
}

const SEMVER = /^\d+\.\d+\.\d+$/
export const RELEASE_NOTES_MAX = 280

export function appVersion(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return SEMVER.test(trimmed) ? trimmed : null
}

/** An https link whose path ends in .apk: tapping it downloads the installer. */
export function directApkUrl(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : ""
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== "https:" || !url.pathname.toLowerCase().endsWith(".apk")) return null
    return url.toString()
  } catch {
    return null
  }
}

export function releaseNotes(value: unknown): string | null {
  if (typeof value !== "string") return null
  // One line: the prompt and the email show it as a sentence, not a changelog.
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ""
  return firstLine.slice(0, RELEASE_NOTES_MAX) || null
}

/** -1, 0 or 1 as `a` is older than, the same as, or newer than `b`. */
export function compareAppVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }
  return 0
}

/** A minimum above the latest would demand an update no one can install. */
function minimumFor(latest: string, ...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    const minimum = appVersion(candidate)
    if (minimum) return compareAppVersions(minimum, latest) <= 0 ? minimum : null
  }
  return null
}

export function readAppRelease(env: Record<string, string | undefined> = process.env): AppRelease | null {
  const latestVersion = appVersion(env.SYNAPSE_APP_LATEST_VERSION)
  const apkUrl = directApkUrl(env.SYNAPSE_APP_APK_URL)
  if (!latestVersion || !apkUrl) return null
  return {
    latestVersion,
    minimumVersion: minimumFor(latestVersion, env.SYNAPSE_APP_MIN_VERSION),
    apkUrl,
    notes: releaseNotes(env.SYNAPSE_APP_RELEASE_NOTES),
    versionCode: null,
    publishedAt: null,
  }
}

export function releaseFromRow(
  row: AppReleaseRow | null,
  env: Record<string, string | undefined> = process.env,
): AppRelease | null {
  if (!row) return null
  const latestVersion = appVersion(row.version)
  const apkUrl = directApkUrl(row.apk_url)
  if (!latestVersion || !apkUrl) return null
  return {
    latestVersion,
    minimumVersion: minimumFor(latestVersion, row.minimum_version, env.SYNAPSE_APP_MIN_VERSION),
    apkUrl,
    notes: releaseNotes(row.notes),
    versionCode: Number.isInteger(row.version_code) ? row.version_code : null,
    publishedAt: row.published_at ?? null,
  }
}

/**
 * The recorded release when there is one, else the deployment's variables.
 * A failed read falls back too: an outage of the table must not hide a
 * release the deployment still announces.
 */
export async function resolveAppRelease(
  reader: AppReleaseReader | null,
  env: Record<string, string | undefined> = process.env,
): Promise<AppRelease | null> {
  if (reader) {
    try {
      const recorded = releaseFromRow(await reader.latest(), env)
      if (recorded) return recorded
    } catch (error) {
      console.error(`[app-release] reading app_releases failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return readAppRelease(env)
}
