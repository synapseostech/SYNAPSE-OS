import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase/admin"

export const dynamic = "force-dynamic"

async function probeDatabase() {
  const started = Date.now()
  // This route is unauthenticated: the driver's error text carries table,
  // constraint and host detail, so it is logged and never returned.
  const failure = { ok: false, latencyMs: 0, detail: "database probe failed" }
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabaseAdmin as any).from("tenants").select("id").limit(1)
    if (error) {
      console.error("[ready] database probe failed:", error.message)
      return { ...failure, latencyMs: Date.now() - started }
    }
    return { ok: true, latencyMs: Date.now() - started, detail: "tenants query succeeded" }
  } catch (error) {
    console.error("[ready] database probe threw:", error)
    return { ...failure, latencyMs: Date.now() - started }
  }
}

/** Readiness — can this Pharmacy deployment serve requests? */
export async function GET() {
  const database = await probeDatabase()
  const ready = database.ok
  const commitSha = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? null
  return NextResponse.json(
    {
      status: ready ? "ready" : "not_ready",
      checkedAt: new Date().toISOString(),
      commitSha,
      checks: { database },
    },
    {
      status: ready ? 200 : 503,
      headers: { "Cache-Control": "no-store, max-age=0" },
    },
  )
}
