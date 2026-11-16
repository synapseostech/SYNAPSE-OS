import { NextResponse } from 'next/server'
import { readAppRelease } from '@/lib/app-release'

/**
 * GET /api/mobile/app-version
 * The latest Synapse APK and the oldest one still supported, so an installed
 * copy can offer the update itself. Public and read-only: it is asked before
 * sign-in and carries nothing but the release the deployment announces.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const release = readAppRelease()
  return NextResponse.json(
    release ?? { latestVersion: null, minimumVersion: null, apkUrl: null, notes: null },
    // Short enough that a new release reaches devices within minutes.
    { headers: { 'Cache-Control': 'public, max-age=300' } },
  )
}
