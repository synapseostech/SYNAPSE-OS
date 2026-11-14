import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { readTallyPlaybackChunk } from "@/lib/tally/plan"
import type { TallyStorageClient } from "@/lib/tally/storage"
import type { TallyPlanSummary } from "@/lib/tally/types"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/**
 * GET /api/admin/tally/[id]/playback?chunk=N
 * One page of the dated walkthrough, in the order the plan carries it.
 * Paged because a cut-over covers tens of thousands of vouchers and the
 * screen walks them a day at a time.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.read")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  const { data: session, error } = await db()
    .from("pharmacy_import_sessions")
    .select("id, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()

  if (error || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }

  const mapping = (session.ai_mapping ?? {}) as Record<string, unknown>
  const summary = (mapping.summary as TallyPlanSummary | undefined) ?? null
  if (!summary) {
    return NextResponse.json(
      {
        error: "Preview the export before walking through what it carries.",
        code: "TALLY_PLAYBACK_NOT_PREPARED",
      },
      { status: 409 },
    )
  }

  const playback = summary.playback
  if (!playback) {
    return NextResponse.json(
      {
        error: "This cut-over states closing balances only, so it has no dated history to walk through.",
        code: "TALLY_PLAYBACK_EMPTY",
      },
      { status: 409 },
    )
  }

  const requested = request.nextUrl.searchParams.get("chunk") ?? "0"
  if (!/^\d+$/.test(requested)) {
    return NextResponse.json(
      { error: "chunk must be a whole number starting at 0.", code: "TALLY_PLAYBACK_CHUNK_INVALID" },
      { status: 400 },
    )
  }
  const chunk = Number(requested)

  if (chunk >= playback.chunkCount) {
    return NextResponse.json(
      {
        error: `This walkthrough has ${playback.chunkCount} chunk${playback.chunkCount === 1 ? "" : "s"}; chunk ${chunk} does not exist.`,
        code: "TALLY_PLAYBACK_CHUNK_OUT_OF_RANGE",
      },
      { status: 400 },
    )
  }

  const events = await readTallyPlaybackChunk(storage(), tenantId, id, chunk)
  if (!events) {
    return NextResponse.json(
      {
        error: "This page of the walkthrough was never saved. Preview the export again.",
        code: "TALLY_PLAYBACK_CHUNK_MISSING",
      },
      { status: 409 },
    )
  }

  return NextResponse.json(
    {
      chunk,
      totalChunks: playback.chunkCount,
      chunkSize: playback.chunkSize,
      mode: playback.mode,
      firstDate: playback.firstDate,
      lastDate: playback.lastDate,
      last: chunk === playback.chunkCount - 1,
      events,
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
