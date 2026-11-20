import { NextResponse } from "next/server"
import { hasPlatformAdminAccess, requirePlatformAdminApi } from "@/lib/platform/auth"
import { getSimulationEngine, serializeRun } from "@/lib/platform/simulation-runtime"
import { isLabContextError, peekLabSessionClaims, requireLabAccess } from "@/lib/lab/access"
import { fetchLabWorklist } from "@/lib/lab/worklist"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  // Only platform operators see the simulation; checking the signed claim
  // first keeps everyone else at one database call.
  const claims = await peekLabSessionClaims()
  if (!claims) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const admin = hasPlatformAdminAccess(claims.role, claims.email) ? await requirePlatformAdminApi() : { ok: false as const }
  if (admin.ok) {
    const engine = getSimulationEngine()
    const orders = engine.lab.snapshot().orders.map((order) => {
      const run = engine.runs.find((item) => item.labOrder?.id === order.id)
      return {
        ...order,
        patientName: run?.patient?.demographics.fullName ?? null,
        synapseId: run?.patient?.synapseId ?? null,
      }
    })
    return NextResponse.json({
      orders,
      results: engine.lab.snapshot().results,
      runs: engine.runs.map(serializeRun),
      source: "simulation",
    })
  }

  const ctx = await requireLabAccess("order.read")
  if (isLabContextError(ctx)) return ctx

  const params = new URL(request.url).searchParams
  const { orders, nextCursor, error } = await fetchLabWorklist(ctx, {
    section: params.get("section"),
    view: params.get("view"),
    status: params.get("status"),
    encounterId: params.get("encounter_id") ?? params.get("encounterId"),
    q: params.get("q"),
    cursor: params.get("cursor"),
    limit: Number(params.get("limit")) || null,
  })
  if (error) return NextResponse.json({ error }, { status: 500 })

  return NextResponse.json({ orders, nextCursor, results: [], runs: [], source: "database" })
}
