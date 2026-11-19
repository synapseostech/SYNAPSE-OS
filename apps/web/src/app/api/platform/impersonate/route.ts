import { NextRequest, NextResponse } from "next/server"
import { requirePlatformAdminApi } from "@/lib/platform/auth"
import { signToken } from "@synapse/auth/tokens"
import { createServiceClient } from "@/lib/supabase/server"
import { logPlatformEvent } from "../../../platform/_lib/platform-data"
import { createHash } from "node:crypto"
import { stepUpResponse } from "@/lib/platform/step-up"

const IMPERSONATION_TTL = "2h"
const IMPERSONATION_TTL_MS = 2 * 60 * 60 * 1000

export async function POST(req: NextRequest) {
  // Impersonation mints a tenant session: it needs its own capability (not
  // merely any platform membership) and a fresh authenticator code.
  const gate = await requirePlatformAdminApi("tenant.impersonate")
  if (!gate.ok) return gate.response
  const admin = gate.profile
  const stepUp = await stepUpResponse(admin)
  if (stepUp) return stepUp

  const body = await req.json().catch(() => ({}))
  const targetUserId = String(body.targetUserId ?? "").trim()

  if (!targetUserId) {
    return NextResponse.json({ error: "targetUserId required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Fetch target user profile
  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, email, role, full_name, tenant_id")
    .eq("id", targetUserId)
    .maybeSingle()

  if (profileError || !profile) {
    return NextResponse.json({ error: "User not found" }, { status: 404 })
  }

  // Platform admins cannot impersonate other platform admins
  if (profile.role === "platform_admin" || profile.role === "superadmin") {
    return NextResponse.json({ error: "Cannot impersonate a platform admin" }, { status: 403 })
  }

  // ...nor any control-plane member, whatever their profile role says.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: membership } = await (supabase as any)
    .from("platform_memberships")
    .select("user_id")
    .eq("user_id", profile.id as string)
    .maybeSingle()
  if (membership) {
    return NextResponse.json({ error: "Cannot impersonate a platform control-plane member" }, { status: 403 })
  }

  if (!profile.tenant_id) {
    return NextResponse.json({ error: "User has no tenant — cannot open pharmacy portal" }, { status: 422 })
  }

  // Fetch tenant name for the banner
  const { data: tenant } = await supabase
    .from("tenants")
    .select("name")
    .eq("id", profile.tenant_id as string)
    .maybeSingle()

  const token = await signToken(
    {
      sub: profile.id as string,
      email: profile.email as string,
      role: profile.role as string,
      tenant_id: profile.tenant_id as string,
      app: "pharmacy",
      is_impersonation: true,
      impersonator_id: admin.id,
    },
    IMPERSONATION_TTL
  )

  // Store token hash in synapse_sessions so middleware validates it
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MS).toISOString()

  const { error: sessionError } = await supabase.from("synapse_sessions").insert({
    user_id: profile.id as string,
    token_hash: tokenHash,
    app: "pharmacy",
    expires_at: expiresAt,
  })

  if (sessionError) {
    return NextResponse.json({ error: "Failed to create impersonation session" }, { status: 500 })
  }

  await logPlatformEvent({
    actorId: admin.id,
    action: "IMPERSONATION_START",
    entityType: "impersonation",
    entityId: targetUserId,
    tenantId: profile.tenant_id as string,
    metadata: {
      target_email: profile.email,
      target_name: profile.full_name,
      target_role: profile.role,
      tenant_name: tenant?.name ?? null,
    },
  })

  return NextResponse.json({
    ok: true,
    token,
    targetName: (profile.full_name as string | null) ?? (profile.email as string),
    tenantName: (tenant?.name as string | null) ?? "Unknown tenant",
  })
}
