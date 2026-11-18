import { NextResponse } from 'next/server'
import { resolveAppRelease } from '../../../../lib/app-release'
import { appReleaseReader } from '../../../../lib/app-releases/store'

/**
 * GET /api/mobile/app-version
 * The latest Synapse APK and the oldest one still supported, so an installed
 * copy can offer the update itself. Public and read-only: it is asked before
 * sign-in and carries nothing but the release itself. The newest build
 * recorded in app_releases wins; the SYNAPSE_APP_* variables answer while none
 * is recorded.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const release = await resolveAppRelease(appReleaseReader)
  return NextResponse.json(
    release ?? { latestVersion: null, minimumVersion: null, apkUrl: null, notes: null, versionCode: null, publishedAt: null },
    // Short enough that a new release reaches devices within minutes.
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
}
