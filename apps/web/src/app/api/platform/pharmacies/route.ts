import { isOfferableNewPharmacyPlan } from "@synapse/db/commercial-pricing"
import { hashFacilityInviteToken } from "@synapse/db/facility-invite-token"
import { NextResponse } from "next/server"
import { createServiceClient } from "../../../../lib/supabase/server"
import { requirePlatformAdminApi } from "../../../../lib/platform/auth"
import { sendHospitalStaffInviteEmail } from "../../../../lib/resend"
import { logPlatformEvent } from "../../../platform/_lib/platform-data"
import { facilityInviteUrl, provisionFacility, pharmacyLoginUrl, pharmacyTenantSlug } from "@synapse/db/facility-provision"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const LEGACY_TIERS = new Set(["trial", "starter", "professional", "enterprise"])

export async function GET(request: Request) {
  const auth = await requirePlatformAdminApi("tenant.read")
  if (!auth.ok) return auth.response

  const raw = new URL(request.url).searchParams.get("slug") ?? ""
  if (!raw) return NextResponse.json({ available: false }, { status: 400 })

  const tenantSlug = pharmacyTenantSlug(raw)
  const supabaseAdmin = createServiceClient()
  const { data } = await (supabaseAdmin as any).from("tenants").select("id").eq("slug", tenantSlug).maybeSingle()
  return NextResponse.json({
    available: !data,
    defaultDomain: pharmacyLoginUrl(tenantSlug),
    slug: tenantSlug,
  })
}

export async function POST(request: Request) {
  const auth = await requirePlatformAdminApi("tenant.manage")
  if (!auth.ok) return auth.response
  const actor = auth.profile
  const body = await request.json().catch(() => ({}))
  const supabaseAdmin = createServiceClient()

  // New pharmacies get the Synapse Pharmacy annual plan only. `plan` is the legacy
  // tenants.plan display tier (trial|starter|professional|enterprise) and never
  // selects a billing plan; any other plan slug is refused.
  const requestedSlug = typeof body.planSlug === "string" ? body.planSlug.trim() : ""
  const tierInput = typeof body.plan === "string" ? body.plan.trim() : ""
  if ((requestedSlug && !isOfferableNewPharmacyPlan(requestedSlug)) || (tierInput && !LEGACY_TIERS.has(tierInput) && !isOfferableNewPharmacyPlan(tierInput))) {
    return NextResponse.json(
      { error: "New pharmacies are provisioned on the Synapse Pharmacy annual plan only.", code: "PLAN_NOT_AVAILABLE" },
      { status: 400 },
    )
  }

  const result = await provisionFacility(supabaseAdmin, {
    facilityType: "pharmacy",
    facilityName: String(body.pharmacyName ?? body.facilityName ?? ""),
    slug: body.slug ? String(body.slug) : undefined,
    district: body.district ? String(body.district) : undefined,
    city: body.city ? String(body.city) : undefined,
    contactName: body.contactName ? String(body.contactName) : undefined,
    contactEmail: body.contactEmail ? String(body.contactEmail) : undefined,
    contactPhone: body.contactPhone ? String(body.contactPhone) : undefined,
    adminName: String(body.adminName ?? body.contactName ?? "Pharmacy Admin"),
    adminEmail: String(body.adminEmail ?? ""),
    adminPhone: body.adminPhone ? String(body.adminPhone) : undefined,
    tier: (LEGACY_TIERS.has(tierInput) ? tierInput : "starter") as "trial" | "starter" | "professional" | "enterprise",
    modules: Array.isArray(body.modules) ? body.modules.map(String) : undefined,
    licenseNumber: body.licenseNumber ? String(body.licenseNumber) : undefined,
    physicalAddress: body.physicalAddress ? String(body.physicalAddress) : undefined,
    networkVisible: body.networkVisible != null ? Boolean(body.networkVisible) : true,
    customDomain: body.customDomain ? String(body.customDomain).toLowerCase() : null,
    createdBy: actor.id,
    sendInvite: true,
  })

  if (result.ok && result.inviteToken && body.sendInvite !== false) {
    try {
      const inviteUrl = facilityInviteUrl("pharmacy", result.slug, result.inviteToken, {
        pharmacyAppUrl: process.env.NEXT_PUBLIC_PHARMACY_APP_URL,
      })
      await sendHospitalStaffInviteEmail({
        to: String(body.adminEmail ?? "").trim().toLowerCase(),
        hospitalName: String(body.pharmacyName ?? result.slug),
        staffName: String(body.adminName ?? body.contactName ?? "Pharmacy Admin"),
        role: "pharmacy_admin",
        inviteUrl,
      })
      await (supabaseAdmin as any)
        .from("facility_invitations")
        .update({ status: "SENT", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("token_hash", hashFacilityInviteToken(result.inviteToken))
      result.inviteStatus = "SENT"
    } catch (err) {
      result.warnings.push(`invite_email: ${err instanceof Error ? err.message : "send_failed"}`)
      result.inviteStatus = "FAILED"
    }
  }

  await logPlatformEvent({
    actorId: actor.id,
    action: result.ok ? "pharmacy.provisioned" : "pharmacy.provision_failed",
    entityType: "facility_provisioning_runs",
    entityId: result.runId,
    tenantId: result.tenantId,
    metadata: {
      slug: result.slug,
      status: result.status,
      inviteStatus: result.inviteStatus,
      // Never log passwords — secure invitation model only
      credentials_email_sent: false,
      secure_invite: true,
    },
  })

  const failed = result.steps.find((s) => s.status === "FAILED")
  return NextResponse.json(
    {
      id: result.tenantId,
      runId: result.runId,
      slug: result.slug,
      ok: result.ok,
      status: result.status,
      defaultDomain: result.workspaceUrl,
      steps: result.steps,
      warnings: result.warnings,
      inviteStatus: result.inviteStatus,
      invitePath: result.inviteToken ? `/invite/facility/${result.inviteToken}` : null,
      credentialsEmailSent: false,
      error: result.error,
      correlationId: result.correlationId,
      failureStep: failed?.step ?? null,
      failureCode: failed?.errorCode ?? null,
      failureReason: failed?.safeErrorMessage ?? result.error ?? null,
    },
    { status: result.ok ? 200 : 400 },
  )
}
