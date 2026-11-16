import { NextRequest, NextResponse } from "next/server"
import { requireTallyHistoryAccess } from "@/lib/tally/auth"
import { listTallyHistoryEntries, parseTallyHistoryFilter } from "@/lib/tally/history"
import { tallyErrorResponse } from "@/lib/tally/http"
import { supabaseAdmin } from "@/lib/supabase/admin"

const db = () => supabaseAdmin as any

/**
 * GET /api/admin/tally/history/entries?type=&from=&to=&page=
 * The imported Day Book, oldest first. Only journals a Tally cut-over posted.
 */
export async function GET(request: NextRequest) {
  const auth = await requireTallyHistoryAccess(request)
  if (!auth.ok) return auth.response

  try {
    const filter = parseTallyHistoryFilter(request.nextUrl.searchParams)
    return NextResponse.json(await listTallyHistoryEntries(db(), auth.tenantId, filter))
  } catch (error) {
    return tallyErrorResponse(error, "The imported vouchers could not be loaded.")
  }
}
