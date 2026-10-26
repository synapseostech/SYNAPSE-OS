/**
 * `close_snapshot` exists only once 20261026190000_pharmacy_period_close_integrity.sql
 * has been applied. The readiness endpoint has the same dependency and both ship
 * together; there is deliberately no runtime fallback, because one would hide a
 * half-applied deployment instead of surfacing it.
 */
import { NextRequest, NextResponse } from "next/server"
import type { Database } from "@synapse/db/types"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type AccountingPeriodRow = Database["public"]["Tables"]["pharmacy_accounting_periods"]["Row"]
type PeriodListRow = Pick<
  AccountingPeriodRow,
  "id" | "period_start" | "period_end" | "status" | "closed_at" | "close_snapshot"
>
type ClosedPeriod = Pick<
  AccountingPeriodRow,
  "id" | "period_start" | "period_end" | "status" | "close_snapshot"
>
type PgError = { message: string }

/**
 * The admin client is created untyped, and the close RPC is not in the
 * generated `Database` type because 20261026190000 has not been applied. This
 * describes only the two calls below: the select is a `Database` row, the RPC
 * is its migration signature, and neither widens to `any`.
 */
type AccountingClient = {
  from: (table: "pharmacy_accounting_periods") => {
    select: (
      columns: "id, period_start, period_end, status, closed_at, close_snapshot",
    ) => {
      eq: (column: "tenant_id", value: string) => {
        order: (column: "period_start", options: { ascending: boolean }) => {
          limit: (count: number) => PromiseLike<{
            data: PeriodListRow[] | null
            error: PgError | null
          }>
        }
      }
    }
  }
  rpc: (
    fn: "close_pharmacy_accounting_period",
    args: {
      p_tenant_id: string
      p_period_start: string
      p_period_end: string
      p_closed_by: string
    },
  ) => PromiseLike<{ data: ClosedPeriod | null; error: PgError | null }>
}

const db = supabaseAdmin as unknown as AccountingClient

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function GET() {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response

    const { data, error } = await db
      .from("pharmacy_accounting_periods")
      .select("id, period_start, period_end, status, closed_at, close_snapshot")
      .eq("tenant_id", auth.tenantId)
      .order("period_start", { ascending: false })
      .limit(100)
    if (error) throw error
    return NextResponse.json({ periods: data ?? [] })
  } catch (error) {
    console.error("Pharmacy accounting periods GET error:", error)
    return NextResponse.json({ error: "Failed to load accounting periods" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("settings.manage")
    if (!auth.ok) return auth.response

    const body = await request.json().catch(() => null)
    const periodStart = typeof body?.periodStart === "string" ? body.periodStart : ""
    const periodEnd = typeof body?.periodEnd === "string" ? body.periodEnd : ""
    if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodStart > periodEnd) {
      return NextResponse.json({ error: "Enter a valid period in YYYY-MM-DD format." }, { status: 400 })
    }
    if (periodEnd >= new Date().toISOString().slice(0, 10)) {
      return NextResponse.json({ error: "Only a completed accounting period can be closed." }, { status: 400 })
    }

    const { data, error } = await db.rpc("close_pharmacy_accounting_period", {
      p_tenant_id: auth.tenantId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_closed_by: auth.session.user.id,
    })
    if (error) {
      const message = String(error.message ?? "")
      if (message.includes("ACCOUNTING_PERIOD_OVERLAP")) {
        return NextResponse.json({ error: "This date range overlaps a period that is already closed." }, { status: 409 })
      }
      if (message.includes("ACCOUNTING_PERIOD_NOT_ENDED")) {
        return NextResponse.json({ error: "Only a completed accounting period can be closed." }, { status: 400 })
      }
      if (message.includes("ACCOUNTING_PERIOD_OPEN_TILLS")) {
        // The database is the enforcement point; this is the readable half. Its
        // cash is written at till close, so closing now would strand it.
        return NextResponse.json(
          {
            error:
              "A till is still open for this period. Close every till first, or its cash will be recorded after the period is locked and the till will fail to close.",
            code: "ACCOUNTING_PERIOD_OPEN_TILLS",
          },
          { status: 409 },
        )
      }
      throw error
    }

    return NextResponse.json({ ok: true, period: data }, { status: 201 })
  } catch (error) {
    console.error("Pharmacy accounting periods POST error:", error)
    return NextResponse.json({ error: "Failed to close accounting period" }, { status: 500 })
  }
}
