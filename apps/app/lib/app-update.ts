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
}

export type ApkUpdate =
  | { kind: "none" }
  | { kind: "optional" | "required"; version: string; apkUrl: string; notes: string | null }

const SEMVER = /^\d+\.\d+\.\d+$/

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
 * announces no complete release. Required when this install is older than the
 * oldest version still supported; optional when it is merely older than the
 * latest and the user has not dismissed that version.
 */
export function decideApkUpdate(
  installed: string | null | undefined,
  release: AppRelease | null | undefined,
  dismissedVersion?: string | null,
): ApkUpdate {
  if (!installed || !SEMVER.test(installed)) return { kind: "none" }
  const latest = release?.latestVersion
  const apkUrl = release?.apkUrl
  if (!latest || !SEMVER.test(latest) || !apkUrl || !apkUrl.startsWith("https://")) return { kind: "none" }
  if (compareAppVersions(installed, latest) >= 0) return { kind: "none" }

  const minimum = release?.minimumVersion
  const notes = release?.notes ?? null
  if (minimum && SEMVER.test(minimum) && compareAppVersions(installed, minimum) < 0) {
    return { kind: "required", version: latest, apkUrl, notes }
  }
  if (dismissedVersion === latest) return { kind: "none" }
  return { kind: "optional", version: latest, apkUrl, notes }
}

/** Checks no more often than this while the app keeps returning to the foreground. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export function shouldCheckForUpdates(lastCheckedAt: number | null, now: number): boolean {
  return lastCheckedAt === null || now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS
}
