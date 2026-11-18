/**
 * Whether this installed APK should offer, or require, a newer one.
 *
 * Kept free of React Native so it runs under node's test runner. The release
 * comes from GET /api/mobile/app-version; the installed version is the native
 * app version (expo-updates' runtime version under the appVersion policy).
 */

export type AppRelease = {
  latestVersion: string | null
  minimumVersion: string | null
  apkUrl: string | null
  notes: string | null
  versionCode?: number | null
  publishedAt?: string | null
}

/** "Not now" on an optional update: which version, and when. */
export type ApkDismissal = { version: string; at: number }

export type ApkUpdate =
  | { kind: "none" }
  | { kind: "optional" | "required"; version: string; apkUrl: string; notes: string | null }

const SEMVER = /^\d+\.\d+\.\d+$/

/** A dismissed optional update is offered again after this long. */
export const REMIND_AGAIN_MS = 24 * 60 * 60 * 1000

/**
 * An https link to the .apk file itself. Opening it downloads the installer;
 * a link to a page would leave the user hunting for the download, so the
 * prompt is not shown for one.
 */
export function isDirectApkUrl(value: string | null | undefined): value is string {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.pathname.toLowerCase().endsWith(".apk")
  } catch {
    return false
  }
}

/**
 * Reads the stored dismissal. A bare version string is what earlier builds
 * stored; it has no time, so it counts as long expired and the update is
 * offered again.
 */
export function parseDismissal(raw: string | null | undefined): ApkDismissal | null {
  if (!raw) return null
  if (SEMVER.test(raw)) return { version: raw, at: 0 }
  try {
    const value = JSON.parse(raw) as Partial<ApkDismissal>
    return typeof value.version === "string" && typeof value.at === "number" && Number.isFinite(value.at)
      ? { version: value.version, at: value.at }
      : null
  } catch {
    return null
  }
}

export function serialiseDismissal(dismissal: ApkDismissal): string {
  return JSON.stringify(dismissal)
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

/**
 * Nothing when the version is unknown (a development build) or the server
 * announces no complete release with a direct .apk link. Required — the app
 * is covered until it updates — when this install is older than the oldest
 * version still supported; optional when it is merely older than the latest,
 * unless the user dismissed that same version less than a day ago.
 */
export function decideApkUpdate(
  installed: string | null | undefined,
  release: AppRelease | null | undefined,
  dismissal?: ApkDismissal | null,
  now: number = Date.now(),
): ApkUpdate {
  if (!installed || !SEMVER.test(installed)) return { kind: "none" }
  const latest = release?.latestVersion
  const apkUrl = release?.apkUrl
  if (!latest || !SEMVER.test(latest) || !isDirectApkUrl(apkUrl)) return { kind: "none" }
  if (compareAppVersions(installed, latest) >= 0) return { kind: "none" }

  const minimum = release?.minimumVersion
  const notes = release?.notes ?? null
  if (minimum && SEMVER.test(minimum) && compareAppVersions(installed, minimum) < 0) {
    return { kind: "required", version: latest, apkUrl, notes }
  }
  if (dismissal && dismissal.version === latest && now - dismissal.at < REMIND_AGAIN_MS) return { kind: "none" }
  return { kind: "optional", version: latest, apkUrl, notes }
}

/** Checks no more often than this while the app keeps returning to the foreground. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function shouldCheckForUpdates(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
}
