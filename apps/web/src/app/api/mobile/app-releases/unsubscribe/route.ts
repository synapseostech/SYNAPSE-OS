import { NextRequest, NextResponse } from 'next/server'
import { verifyUnsubscribeToken } from '../../../../../lib/app-releases/email'
import { optOutOfReleaseEmails } from '../../../../../lib/app-releases/store'

/**
 * Stops app release emails for the address a signed link was sent to.
 * GET is the link in the email; POST is the one-click List-Unsubscribe that
 * mail clients send (RFC 8058). Neither needs a sign-in: the HMAC in the token
 * is the proof, and it opts out only that one address.
 */
export const dynamic = 'force-dynamic'

function secret(): string | undefined {
  return process.env.APP_RELEASE_EMAIL_SECRET?.trim() || process.env.EAS_WEBHOOK_SECRET?.trim() || undefined
}

async function optOut(req: NextRequest): Promise<boolean> {
  const email = verifyUnsubscribeToken(req.nextUrl.searchParams.get('t'), secret())
  if (!email) return false
  await optOutOfReleaseEmails(email)
  return true
}

export async function GET(req: NextRequest) {
  try {
    const ok = await optOut(req)
    return NextResponse.redirect(new URL(ok ? '/unsubscribed' : '/?unsubscribed=error', req.url))
  } catch (error) {
    console.error(`[app-releases] opt-out failed: ${error instanceof Error ? error.message : String(error)}`)
    return NextResponse.redirect(new URL('/?unsubscribed=error', req.url))
  }
}

export async function POST(req: NextRequest) {
  try {
    return (await optOut(req))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'invalid link' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'could not record opt-out' }, { status: 500 })
  }
}
