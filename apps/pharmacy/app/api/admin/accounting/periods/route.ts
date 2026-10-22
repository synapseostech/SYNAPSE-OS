import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function GET() {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response

    const { data, error } = await (supabaseAdmin as any)
      .from("pharmacy_accounting_periods")
      .select("id, period_start, period_end, status, closed_at")
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

    const { data, error } = await (supabaseAdmin as any).rpc("close_pharmacy_accounting_period", {
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
      throw error
    }

    return NextResponse.json({ ok: true, period: data }, { status: 201 })
  } catch (error) {
    console.error("Pharmacy accounting periods POST error:", error)
    return NextResponse.json({ error: "Failed to close accounting period" }, { status: 500 })
  }
}
