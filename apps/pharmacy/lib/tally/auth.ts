/**
 * Auth for the Tally workspace.
 *
 * Portal requests arrive with the pharmacy session cookie. The mobile app has
 * no cookie, so it sends the same bearer token the mobile BFF accepts. Only the
 * Tally routes opt into that second path; every other portal API stays
 * cookie-only.
 */

import { NextResponse, type NextRequest } from "next/server"
import { validateSession, verifyToken } from "@synapse/auth"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { sessionHasCapability, normalizePharmacyRole, type PharmacyCapability } from "@/lib/capabilities"
import { supabaseAdmin } from "@/lib/supabase/admin"

const db = () => supabaseAdmin as any

/** Roles the mobile BFF lets into pharmacy APIs. */
const MOBILE_PHARMACY_ROLES = new Set([
  "pharmacist",
  "pharmacy_admin",
  "pharmacy_store_manager",
  "pharmacy_cashier",
  "cashier",
  "pharmacy_staff",
  "pharmacy_ceo",
  "inventory_officer",
])

export type TallyAuth = {
  ok: true
  tenantId: string
  actorId: string
  role: string
  pharmacyRole: string | null
  permissions: string[]
  isAdmin: boolean
}

export type TallyAuthFailure = { ok: false; response: NextResponse }

export type TallyAuthResult = TallyAuth | TallyAuthFailure

export function tallyHasCapability(auth: TallyAuth, capability: PharmacyCapability): boolean {
  return sessionHasCapability(
    {
      role: auth.role,
      pharmacyRole: auth.pharmacyRole,
      permissions: auth.permissions,
      isAdmin: auth.isAdmin,
    },
    capability,
  )
}

export async function requireTallyPermission(
  request: NextRequest,
  capability: PharmacyCapability,
): Promise<TallyAuthResult> {
  const header = request.headers.get("authorization") ?? ""
  if (!header.toLowerCase().startsWith("bearer ")) {
    const auth = await requirePharmacyPermission(capability)
    if (!auth.ok) return auth
    return {
      ok: true,
      tenantId: auth.tenantId,
      actorId: auth.session.user.id,
      role: auth.session.role,
      pharmacyRole: auth.session.pharmacyRole ?? null,
      permissions: auth.session.permissions ?? [],
      isAdmin: auth.session.isAdmin,
    }
  }

  const token = header.slice(7).trim()
  if (!token) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) {
    return { ok: false, response: NextResponse.json({ error: "Invalid token" }, { status: 401 }) }
  }

  const { valid } = await validateSession(token)
  if (!valid) {
    return { ok: false, response: NextResponse.json({ error: "Session expired" }, { status: 401 }) }
  }

  const role = normalizePharmacyRole(String(payload.role ?? ""))
  if (!MOBILE_PHARMACY_ROLES.has(role)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Pharmacy role required" }, { status: 403 }),
    }
  }

  const tenantId = String(payload.tenant_id ?? "")
  if (!tenantId) {
    return { ok: false, response: NextResponse.json({ error: "No tenant context" }, { status: 403 }) }
  }

  const { data } = await db()
    .from("pharmacy_user_settings")
    .select("pharmacy_role, permissions, is_active")
    .eq("profile_id", payload.sub)
    .maybeSingle()

  if (data?.is_active === false) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Account deactivated", code: "ACCOUNT_INACTIVE" }, { status: 403 }),
    }
  }

  const auth: TallyAuth = {
    ok: true,
    tenantId,
    actorId: String(payload.sub),
    role,
    // The settings role is what the portal uses; the token role is the fallback.
    pharmacyRole: normalizePharmacyRole((data?.pharmacy_role as string | null) ?? role),
    permissions: Array.isArray(data?.permissions) ? (data.permissions as string[]) : [],
    isAdmin: false,
  }

  if (!tallyHasCapability(auth, capability)) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `Missing capability: ${capability}` },
        { status: 403 },
      ),
    }
  }
  return auth
}
