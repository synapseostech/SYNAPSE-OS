import { NextRequest, NextResponse } from "next/server"
import { requireTallyHistoryAccess } from "@/lib/tally/auth"
import { listTallyHistorySessions, loadTallyHistorySummary } from "@/lib/tally/history"
import { tallyErrorResponse } from "@/lib/tally/http"
import { supabaseAdmin } from "@/lib/supabase/admin"

const db = () => supabaseAdmin as any

/**
 * GET /api/admin/tally/history
 * What Tally imports wrote: every applied session, its plan's figures, its
 * apply's report and what the ledger holds now, side by side. Read-only.
 */
export async function GET(request: NextRequest) {
  const auth = await requireTallyHistoryAccess(request)
  if (!auth.ok) return auth.response

  try {
    const sessions = await listTallyHistorySessions(db(), auth.tenantId)
    if (sessions.length === 0) {
      return NextResponse.json(
        { error: "No Tally import has been applied for this pharmacy yet.", code: "TALLY_HISTORY_EMPTY" },
        { status: 404 },
      )
    }
    return NextResponse.json(await loadTallyHistorySummary(db(), auth.tenantId, sessions))
  } catch (error) {
    return tallyErrorResponse(error, "The Tally import history could not be loaded.")
  }
}
