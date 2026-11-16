/**
 * The mobile app's latest release, as the server announces it.
 *
 * The APK is installed outside any app store, so nothing tells an installed
 * copy that a newer one exists. The app asks GET /api/mobile/app-version on
 * start; this reads what that answers from the deployment's environment, so a
 * release is announced by setting four variables, not by shipping code:
 *
 *   SYNAPSE_APP_LATEST_VERSION   e.g. 1.3.0 — the newest APK
 *   SYNAPSE_APP_MIN_VERSION      e.g. 1.2.0 — older installs must update first
 *   SYNAPSE_APP_APK_URL          https:// link the APK downloads from
 *   SYNAPSE_APP_RELEASE_NOTES    one line shown with the prompt
 *
 * Anything missing or malformed is dropped rather than guessed, and with no
 * valid latest version or download link the answer says there is no release,
 * so a half-configured deployment never sends users to a broken link.
 */

export type AppRelease = {
  latestVersion: string
  minimumVersion: string | null
  apkUrl: string
  notes: string | null
}

const SEMVER = /^\d+\.\d+\.\d+$/

function version(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ""
  return SEMVER.test(trimmed) ? trimmed : null
}

function httpsUrl(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? ""
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    return url.protocol === "https:" ? url.toString() : null
  } catch {
    return null
  }
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

export function readAppRelease(env: Record<string, string | undefined> = process.env): AppRelease | null {
  const latestVersion = version(env.SYNAPSE_APP_LATEST_VERSION)
  const apkUrl = httpsUrl(env.SYNAPSE_APP_APK_URL)
  if (!latestVersion || !apkUrl) return null
  const minimum = version(env.SYNAPSE_APP_MIN_VERSION)
  const notes = env.SYNAPSE_APP_RELEASE_NOTES?.trim().slice(0, 280) || null
  return {
    latestVersion,
    // A minimum above the latest would demand an update no one can install.
    minimumVersion: minimum && compareAppVersions(minimum, latestVersion) <= 0 ? minimum : null,
    apkUrl,
    notes,
  }
}
