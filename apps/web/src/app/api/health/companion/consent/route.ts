import { NextRequest, NextResponse } from "next/server"
import { defaultCompanionDeps, resolveCompanionUser } from "../../../../../lib/health-companion/session"
import { parseConsent } from "../../../../../lib/health-companion/service"

export const dynamic = "force-dynamic"

/**
 * Body: { acceptTerms: true, medications?, appointments?, readings?, labs?, wearables? }
 * Every category defaults to false; sending the body again replaces it.
 */
export async function PUT(req: NextRequest) {
  const userId = await resolveCompanionUser(req)
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const consent = parseConsent(await req.json().catch(() => null), new Date())
  if (!consent) return NextResponse.json({ error: "invalid_body" }, { status: 400 })
  try {
    await defaultCompanionDeps().store.saveConsent(userId, consent)
    return NextResponse.json({ consent }, { headers: { "cache-control": "no-store" } })
  } catch {
    return NextResponse.json({ error: "companion_error" }, { status: 500 })
  }
}
