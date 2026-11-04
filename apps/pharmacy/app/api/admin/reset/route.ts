import { NextRequest, NextResponse } from "next/server"
import { logAudit } from "@synapse/db"
import { requirePharmacyAdmin } from "@/lib/api-auth"
import { consumeRateLimit } from "@/lib/distributed-rate-limit"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { PHARMACY_IMPORT_BUCKET } from "@/lib/pharmacy-storage"

const db = () => supabaseAdmin as any

/** The Storage API accepts at most 1000 paths per removal. */
const REMOVE_BATCH = 1000
/** A tenant's imports are a few files per session; this only bounds a runaway walk. */
const MAX_STORAGE_OBJECTS = 20_000
const MAX_DEPTH = 5

type ResetBody = { confirmName: string; dryRun: boolean }

function invalid(error: string, code: string, status = 400) {
  return NextResponse.json({ error, code }, { status })
}

function readBody(body: unknown): ResetBody | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "The request must be a JSON object."
  }
  const record = body as Record<string, unknown>
  if (record.dryRun !== undefined && typeof record.dryRun !== "boolean") {
    return "dryRun must be true or false."
  }
  const dryRun = record.dryRun === true
  // Only a real run has to be confirmed by name; a preview changes nothing.
  if (record.confirmName !== undefined && typeof record.confirmName !== "string") {
    return "confirmName must be text."
  }
  const confirmName = typeof record.confirmName === "string" ? record.confirmName.trim() : ""
  if (confirmName.length > 200) return "That is not the pharmacy's name."
  if (!dryRun && confirmName === "") return "Type the pharmacy's name to confirm the reset."
  return { confirmName, dryRun }
}

/**
 * Every object under the tenant's import prefix.
 *
 * Supabase Storage has no recursive delete: a folder is listed as an entry with
 * no id, and its contents have to be walked. Depth is bounded because the only
 * writer of this prefix is the Tally flow, which nests five levels at most.
 */
async function collectImportPaths(tenantId: string): Promise<string[]> {
  const bucket = db().storage.from(PHARMACY_IMPORT_BUCKET)
  const paths: string[] = []

  async function walk(prefix: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || paths.length >= MAX_STORAGE_OBJECTS) return
    const { data, error } = await bucket.list(prefix, { limit: 1000 })
    if (error || !Array.isArray(data)) return
    for (const entry of data as Array<{ name?: string; id?: string | null }>) {
      if (!entry.name) continue
      const path = `${prefix}/${entry.name}`
      if (entry.id == null) {
        await walk(path, depth + 1)
      } else {
        paths.push(path)
        if (paths.length >= MAX_STORAGE_OBJECTS) return
      }
    }
  }

  await walk(`tenants/${tenantId}`, 1)
  return paths
}

/**
 * POST /api/admin/reset
 *
 * Erases one pharmacy tenant's data so its Tally cut-over can be run again.
 * The wipe itself is the purge_pharmacy_tenant_data RPC, which is the only
 * sanctioned way through the accounting, Tally-mirror and append-only-sales
 * guards. Staff logins and the tenant row survive, so the admin stays signed in.
 *
 * Body: { confirmName: string, dryRun?: boolean }. `confirmName` must equal the
 * pharmacy's own name; a dry run returns the per-table counts and changes
 * nothing.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    let parsed: unknown
    try {
      parsed = await request.json()
    } catch {
      return invalid("The request is not valid JSON.", "PHARMACY_RESET_INVALID")
    }
    const body = readBody(parsed)
    if (typeof body === "string") {
      return invalid(body, "PHARMACY_RESET_INVALID")
    }

    // A preview changes nothing, so it never consumes the destructive budget:
    // otherwise a few looks would lock the admin out of the reset itself.
    if (!body.dryRun) {
      const decision = await consumeRateLimit("pharmacy-reset", tenantId, 3, 3600)
      if (!decision.allowed) {
        return NextResponse.json(
          { error: "Too many reset attempts. Try again later.", code: "PHARMACY_RESET_RATE_LIMITED" },
          { status: 429, headers: { "Retry-After": String(decision.retryAfter) } },
        )
      }
    }

    if (!body.dryRun) {
      const { data: settings } = await db()
        .from("pharmacy_settings")
        .select("pharmacy_name")
        .eq("tenant_id", tenantId)
        .maybeSingle()
      let pharmacyName =
        typeof settings?.pharmacy_name === "string" ? settings.pharmacy_name.trim() : ""
      if (!pharmacyName) {
        const { data: tenant } = await db()
          .from("tenants")
          .select("name")
          .eq("id", tenantId)
          .maybeSingle()
        pharmacyName = typeof tenant?.name === "string" ? tenant.name.trim() : ""
      }
      if (!pharmacyName) {
        return invalid(
          "This pharmacy has no name to confirm against, so the reset cannot be verified.",
          "PHARMACY_RESET_NO_NAME",
          409,
        )
      }
      if (body.confirmName !== pharmacyName) {
        return invalid(
          "That is not the pharmacy's name. Nothing was deleted.",
          "PHARMACY_RESET_NAME_MISMATCH",
        )
      }
    }

    const { data, error } = await db().rpc("purge_pharmacy_tenant_data", {
      p_tenant_id: tenantId,
      p_actor_id: session.userId,
      p_dry_run: body.dryRun,
    })

    if (error) {
      const message = String(error.message ?? "")
      const code = String(error.code ?? "")
      if (code === "PGRST202" || /does not exist|schema cache/i.test(message)) {
        return NextResponse.json(
          {
            error: "The reset needs the tenant purge migration, which is not applied here.",
            code: "PHARMACY_RESET_MIGRATION_MISSING",
          },
          { status: 503 },
        )
      }
      if (message.includes("PHARMACY_PURGE_NOT_PHARMACY")) {
        return invalid("This account is not a pharmacy tenant.", "PHARMACY_RESET_NOT_PHARMACY", 403)
      }
      if (message.includes("PHARMACY_PURGE_TENANT_NOT_FOUND")) {
        return invalid("That pharmacy was not found.", "PHARMACY_RESET_TENANT_NOT_FOUND", 404)
      }
      console.error("[pharmacy-reset] purge failed:", message)
      return invalid("The reset failed. Nothing was deleted.", "PHARMACY_RESET_FAILED", 500)
    }

    const result = (data ?? {}) as {
      dryRun?: boolean
      totalRows?: number
      counts?: Record<string, number>
    }
    const counts = result.counts ?? {}
    const totalRows = Number(result.totalRows ?? 0)

    if (body.dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, totalRows, counts })
    }

    // The database is already wiped; a leftover import file is harmless and the
    // admin can re-run the import over it. A failure here is reported, not fatal.
    let storageCleanup: "done" | "failed" | "skipped" = "skipped"
    try {
      const paths = await collectImportPaths(tenantId)
      const bucket = db().storage.from(PHARMACY_IMPORT_BUCKET)
      for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
        const { error: removeError } = await bucket.remove(paths.slice(i, i + REMOVE_BATCH))
        if (removeError) throw new Error(removeError.message)
      }
      storageCleanup = "done"
    } catch (cleanupError) {
      console.error(
        "[pharmacy-reset] import files left behind:",
        cleanupError instanceof Error ? cleanupError.message : "error",
      )
      storageCleanup = "failed"
    }

    await logAudit({
      actor_id: session.userId,
      action: "PHARMACY_DATA_RESET",
      resource_type: "pharmacy_tenant",
      resource_id: tenantId,
      tenant_id: tenantId,
      after_state: { totalRows, counts, storageCleanup },
      app_surface: "pharmacy",
    })

    return NextResponse.json({ ok: true, dryRun: false, totalRows, counts, storageCleanup })
  } catch (error) {
    console.error("[pharmacy-reset] unexpected error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export const dynamic = "force-dynamic"
