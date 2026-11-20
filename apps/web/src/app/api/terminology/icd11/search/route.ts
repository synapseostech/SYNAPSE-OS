import { NextRequest, NextResponse } from "next/server"
import { getCurrentUser } from "@/lib/auth/getCurrentUser"
import { searchIcd11Index } from "@synapse/interop/icd11-index"

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!user.tenantId) return NextResponse.json({ error: "Tenant context required" }, { status: 403 })

  const q = req.nextUrl.searchParams.get("q") ?? ""
  if (!q.trim()) {
    return NextResponse.json({ error: "q is required" }, { status: 400 })
  }

  // The full WHO 2026-01 MMS index ships with the app, so search works
  // offline from WHO and needs no API credentials.
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "15")
  const hits = searchIcd11Index(q, Number.isFinite(limit) ? limit : 15)
  return NextResponse.json(
    { release: "2026-01", linearization: "mms", source: "who-tabulation", degraded: false, hits },
    { headers: { "Cache-Control": "private, max-age=300" } },
  )
}
