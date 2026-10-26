import { NextRequest, NextResponse } from "next/server"

import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  assessCloseReadiness,
  closeSnapshot,
  type CloseReadinessFacts,
  type TillSessionFacts,
} from "@/lib/accounting/close-readiness"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toFacts(row: Record<string, unknown>): CloseReadinessFacts {
  const sessions = Array.isArray(row.tillSessions) ? row.tillSessions : []
  return {
    periodStart: String(row.periodStart ?? ""),
    periodEnd: String(row.periodEnd ?? ""),
    today: String(row.assessedOn ?? ""),
    tillSessions: sessions
      .filter((session): session is Record<string, unknown> => Boolean(session) && typeof session === "object")
      .map(
        (session): TillSessionFacts => ({
          status: String(session.status ?? ""),
          openedOn: String(session.openedOn ?? ""),
          closedOn: session.closedOn == null ? null : String(session.closedOn),
        }),
      ),
    unmatchedBankLines: num(row.unmatchedBankLines),
    unmatchedBankValue: num(row.unmatchedBankValue),
    journalEntries: num(row.journalEntries),
    journalDebitTotal: num(row.journalDebitTotal),
    salesCount: num(row.salesCount),
    salesTotal: num(row.salesTotal),
    cashSalesTotal: num(row.cashSalesTotal),
  }
}

/**
 * GET /api/admin/accounting/periods/readiness?start=YYYY-MM-DD&end=YYYY-MM-DD
 *
 * Read-only. Tells the operator what would go wrong if they closed the period
 * now, before they commit to something irreversible.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response

    const periodStart = request.nextUrl.searchParams.get("start") ?? ""
    const periodEnd = request.nextUrl.searchParams.get("end") ?? ""
    if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodStart > periodEnd) {
      return NextResponse.json({ error: "Enter a valid period in YYYY-MM-DD format." }, { status: 400 })
    }

    const { data, error } = await (supabaseAdmin as any).rpc("pharmacy_accounting_close_readiness", {
      p_tenant_id: auth.tenantId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    })
    if (error) {
      const message = String(error.message ?? "")
      // PGRST202 is PostgREST saying the function is not in the schema cache.
      // That means migration 20261026190000 has not been applied here, which is a
      // deployment gap rather than a bad request.
      if (String(error.code ?? "") === "PGRST202" || message.includes("Could not find the function")) {
        console.error("Pharmacy close readiness RPC is missing:", error)
        return NextResponse.json(
          { error: "The close readiness check is not available on this deployment." },
          { status: 503 },
        )
      }
      throw error
    }

    if (!data || typeof data !== "object") {
      return NextResponse.json({ error: "The close readiness check returned no data." }, { status: 502 })
    }

    const facts = toFacts(data as Record<string, unknown>)
    const readiness = assessCloseReadiness(facts)

    return NextResponse.json({
      readiness,
      // What the close would record. Shown so the evidence is not a surprise.
      snapshot: closeSnapshot(facts),
    })
  } catch (error) {
    console.error("Pharmacy accounting readiness GET error:", error)
    return NextResponse.json({ error: "Failed to check accounting period readiness." }, { status: 500 })
  }
}
