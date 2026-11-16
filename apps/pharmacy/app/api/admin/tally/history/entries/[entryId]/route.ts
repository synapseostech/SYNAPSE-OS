import { NextRequest, NextResponse } from "next/server"
import { requireTallyHistoryAccess } from "@/lib/tally/auth"
import { loadTallyHistoryEntry } from "@/lib/tally/history"
import { tallyErrorResponse } from "@/lib/tally/http"
import { supabaseAdmin } from "@/lib/supabase/admin"

const db = () => supabaseAdmin as any

/** GET /api/admin/tally/history/entries/[entryId] — one imported voucher and its lines. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entryId: string }> },
) {
  const auth = await requireTallyHistoryAccess(request)
  if (!auth.ok) return auth.response
  const { entryId } = await params

  try {
    const result = await loadTallyHistoryEntry(db(), auth.tenantId, entryId)
    if (!result) {
      return NextResponse.json({ error: "Imported voucher not found" }, { status: 404 })
    }
    return NextResponse.json(result)
  } catch (error) {
    return tallyErrorResponse(error, "The imported voucher could not be loaded.")
  }
}
