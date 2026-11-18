import { NextRequest, NextResponse } from 'next/server'
import { brandedEmail, FROM_EMAIL, FROM_NAME, resend } from '../../../../lib/resend'
import { announceReleaseByEmail, type SendReleaseEmail } from '../../../../lib/app-releases/email'
import { parseBuildReport, recordAppRelease, verifyExpoSignature } from '../../../../lib/app-releases/record'
import { appReleaseWriter, releaseEmailStore } from '../../../../lib/app-releases/store'

/**
 * POST /api/mobile/app-releases
 * A finished EAS build reports itself here — from the EAS build webhook, or
 * from the "EAS Android preview APK" workflow after `eas build --wait`. Both
 * sign the raw body with EAS_WEBHOOK_SECRET (`expo-signature: sha1=<hex>`).
 *
 * A finished Android .apk build is recorded in app_releases, which is what
 * GET /api/mobile/app-version answers from, and — when it is the newest
 * release — emailed once to each admin and opted-in address. Builds that are
 * not announced (another platform, a development profile, an .aab) are
 * acknowledged with 202 so EAS does not retry them.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const sendWithResend: SendReleaseEmail = async (message) => {
  const result = await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [message.to],
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
  })
  return { id: result.data?.id ?? null }
}

export async function POST(req: NextRequest) {
  const secret = process.env.EAS_WEBHOOK_SECRET?.trim()
  if (!secret) {
    return NextResponse.json({ error: 'release webhook is not configured' }, { status: 503 })
  }
  const raw = await req.text()
  if (!verifyExpoSignature(raw, req.headers.get('expo-signature'), secret)) {
    return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'body is not JSON' }, { status: 400 })
  }

  const parsed = parseBuildReport(body)
  if (!parsed.ok) {
    return NextResponse.json({ recorded: false, reason: parsed.reason }, { status: 202 })
  }

  try {
    const outcome = await recordAppRelease(appReleaseWriter, parsed.release)
    const email = outcome.isLatest
      ? await announceReleaseByEmail({
          release: outcome.release,
          store: releaseEmailStore,
          send: sendWithResend,
          render: brandedEmail,
          secret: process.env.APP_RELEASE_EMAIL_SECRET?.trim() || secret,
          baseUrl: req.nextUrl.origin,
        })
      : null
    console.info(
      `[app-releases] recorded version=${outcome.release.version} code=${outcome.release.versionCode} ` +
        `created=${outcome.created} latest=${outcome.isLatest} source=${parsed.release.source} ` +
        `emailed=${email?.sent ?? 0} failed=${email?.failed ?? 0}`,
    )
    return NextResponse.json({
      recorded: true,
      created: outcome.created,
      latest: outcome.isLatest,
      version: outcome.release.version,
      versionCode: outcome.release.versionCode,
      email,
    })
  } catch (error) {
    console.error(`[app-releases] ${error instanceof Error ? error.message : String(error)}`)
    // 500 lets EAS redeliver; recording and every claimed email are idempotent.
    return NextResponse.json({ error: 'could not record release' }, { status: 500 })
  }
}
