import { NextRequest, NextResponse } from "next/server"
import { requireTallyPermission, tallyIsAdmin } from "@/lib/tally/auth"
import { findCompletedCutover } from "@/lib/tally/cutover"

/**
 * GET /api/admin/tally/status
 * Tells the Tally workspace whether this account may run the cut-over and
 * whether it has already run. Every other Tally route enforces the same two
 * facts; this one only reports them so the page can render the right state.
 */
export async function GET(request: NextRequest) {
  const auth = await requireTallyPermission(request, "inventory.read")
  if (!auth.ok) return auth.response

  const isAdmin = tallyIsAdmin(auth)
  if (!isAdmin) {
    return NextResponse.json({ isAdmin: false, cutoverComplete: false, completedAt: null })
  }

  const cutover = await findCompletedCutover(auth.tenantId)
  return NextResponse.json({
    isAdmin: true,
    cutoverComplete: Boolean(cutover),
    completedAt: cutover?.completedAt ?? null,
  })
}
