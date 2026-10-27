import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@synapse/db/admin"

export const dynamic = "force-dynamic"
export const maxDuration = 60

/** Mirrors the `status` check constraint on public.synapse_domain_events. */
const EVENT_STATUSES = ["pending", "published", "failed", "dead"] as const
type EventStatus = (typeof EVENT_STATUSES)[number]

/**
 * Domain event outbox health check — reports queue depth by status and
 * the age of the oldest pending event.
 * Alert threshold is controlled by DOMAIN_EVENT_PENDING_ALERT_MINUTES (default 60).
 * Auth: Authorization: Bearer $CRON_SECRET or x-cron-secret header.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: "CRON_SECRET not configured" }, { status: 503 })
  }
  const auth = req.headers.get("authorization")
  const alt = req.headers.get("x-cron-secret")
  if (auth !== `Bearer ${secret}` && alt !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // A malformed threshold must not read as "never alert": NaN would make the
  // comparison below false forever, turning a config typo into a silent pass.
  const configuredMinutes = Number(process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES ?? 60)
  const alertMinutes =
    Number.isFinite(configuredMinutes) && configuredMinutes > 0 ? configuredMinutes : 60
  const alertThreshold = new Date(Date.now() - alertMinutes * 60_000).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  // Counts are taken one status at a time with `head: true`, so PostgREST
  // answers with a Content-Range total and no rows. Selecting the rows and
  // counting them here would be silent under PostgREST's row cap: this table
  // is never drained, so past that cap every count would read as "at most the
  // cap", which is the one number this route exists to get right.
  const statusCounts: Record<EventStatus, number> = { pending: 0, published: 0, failed: 0, dead: 0 }
  for (const status of EVENT_STATUSES) {
    const { count, error: statusError } = await db
      .from("synapse_domain_events")
      .select("id", { count: "exact", head: true })
      .eq("status", status)
    if (statusError) {
      return NextResponse.json(
        { error: "Failed to fetch status counts", code: statusError.code, details: statusError.message },
        { status: 500 },
      )
    }
    statusCounts[status] = count ?? 0
  }

  // Get oldest pending event
  const { data: oldestPending, error: oldestError } = await db
    .from("synapse_domain_events")
    .select("created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()

  if (oldestError) {
    return NextResponse.json(
      { error: "Failed to fetch oldest pending event", code: oldestError.code, details: oldestError.message },
      { status: 500 },
    )
  }

  const oldestPendingAt = oldestPending?.created_at ?? null
  const isStale = oldestPendingAt !== null && oldestPendingAt < alertThreshold

  return NextResponse.json({
    ok: !isStale,
    statusCounts,
    oldestPendingAt,
    alertThresholdMinutes: alertMinutes,
  }, { status: isStale ? 500 : 200 })
}