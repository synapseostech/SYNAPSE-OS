import { NextResponse } from "next/server"
import { supabaseAdmin } from "@synapse/db/admin"
import { isLabContextError, requireLabAccess } from "@/lib/lab/access"

export const dynamic = "force-dynamic"

/** Specimens, newest first. Was readable by any facility role; now lab.order.read. */
export async function GET(request: Request) {
  const ctx = await requireLabAccess("order.read")
  if (isLabContextError(ctx)) return ctx

  const params = new URL(request.url).searchParams
  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 100)
  const before = params.get("before")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db
    .from("lab_specimens")
    .select("id, accession_number, barcode, specimen_type, container, status, collected_at, received_at, lab_order_id, patients(full_name, mrn)")
    .eq("tenant_id", ctx.tenantId)
  if (params.get("status")) query = query.eq("status", params.get("status"))
  if (before && !Number.isNaN(Date.parse(before))) query = query.lt("collected_at", new Date(before).toISOString())
  const { data, error } = await query.order("collected_at", { ascending: false }).limit(limit)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  const specimens = (data ?? []) as Array<{ collected_at?: string | null }>
  const next = specimens.length === limit ? specimens[specimens.length - 1]?.collected_at ?? null : null
  return NextResponse.json({ specimens, nextBefore: next, source: "database" })
}
