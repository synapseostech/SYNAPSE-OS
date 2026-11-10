import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { readTallyMovementChunk } from "@/lib/tally/plan"
import type { TallyStorageClient } from "@/lib/tally/storage"
import type { TallyPlanSummary } from "@/lib/tally/types"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

/**
 * GET /api/admin/tally/[id]/replay-timeline?chunk=N
 * One page of the chronological sequence: the stock movements in the order the
 * replay applies them. Paged because a period can carry tens of thousands of
 * movements and the review never needs them all at once.
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
  const replay = summary?.replay
  if (summary?.mode !== "replay" || !replay) {
    return NextResponse.json(
      {
        error: "This session does not rebuild the history, so it has no replay timeline.",
        code: "TALLY_REPLAY_NOT_A_REPLAY",
      },
      { status: 409 },
    )
  }

  const requested = request.nextUrl.searchParams.get("chunk") ?? "0"
  if (!/^\d+$/.test(requested)) {
    return NextResponse.json(
      { error: "chunk must be a whole number starting at 0.", code: "TALLY_REPLAY_CHUNK_INVALID" },
      { status: 400 },
    )
  }
  const chunk = Number(requested)

  if (chunk >= replay.movementChunkCount) {
    return NextResponse.json(
      {
        error: `This replay has ${replay.movementChunkCount} movement chunk${replay.movementChunkCount === 1 ? "" : "s"}; chunk ${chunk} does not exist.`,
        code: "TALLY_REPLAY_CHUNK_OUT_OF_RANGE",
      },
      { status: 400 },
    )
  }

  const movements = await readTallyMovementChunk(storage(), tenantId, id, chunk)
  if (!movements) {
    return NextResponse.json(
      {
        error: "This page of the replay was never saved. Preview the export again.",
        code: "TALLY_REPLAY_CHUNK_MISSING",
      },
      { status: 409 },
    )
  }

  return NextResponse.json(
    {
      chunk,
      totalChunks: replay.movementChunkCount,
      chunkSize: summary.chunkSize,
      movementCount: replay.movementCount,
      cutoffDate: replay.cutoffDate,
      ordering: replay.ordering,
      // What the last page carries is the tail of the sequence, so the screen
      // knows when it has the whole timeline.
      last: chunk === replay.movementChunkCount - 1,
      movements,
    },
    { headers: { "Cache-Control": "no-store" } },
  )
}
