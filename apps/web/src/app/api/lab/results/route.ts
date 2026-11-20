import { NextResponse } from "next/server"
import { supabaseAdmin } from "@synapse/db/admin"
import { isLabContextError, requireLabAccess } from "@/lib/lab/access"

export const dynamic = "force-dynamic"

/** Results with accession and patient embedded: one query, paged by created_at. */
export async function GET(request: Request) {
  const ctx = await requireLabAccess("result.read")
  if (isLabContextError(ctx)) return ctx

  const params = new URL(request.url).searchParams
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 100)
  const before = params.get("before")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db
    .from("lab_results")
    .select(
      "id, lab_order_id, test_name, loinc_code, result_value, unit, reference_range, status, is_critical, is_abnormal, abnormal_flag, analyzer, result_source, verified_at, created_at, lab_orders(accession_number, section, patients(full_name))",
    )
    .eq("tenant_id", ctx.tenantId)
    .eq("is_synthetic", false)
  if (params.get("critical") === "1") query = query.eq("is_critical", true)
  if (before && !Number.isNaN(Date.parse(before))) query = query.lt("created_at", new Date(before).toISOString())
  const { data, error } = await query.order("created_at", { ascending: false }).limit(limit)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const results = ((data ?? []) as Record<string, unknown>[]).map(({ lab_orders: order, ...row }): Record<string, unknown> => {
    const o = order as { accession_number?: string | null; section?: string | null; patients?: { full_name?: string | null } | null } | null
    return { ...row, accession_number: o?.accession_number ?? null, section: o?.section ?? null, patient_name: o?.patients?.full_name ?? null }
  })
  const next = results.length === limit ? String(results[results.length - 1]?.created_at ?? "") || null : null
  return NextResponse.json({ results, nextBefore: next, source: "database" })
}
