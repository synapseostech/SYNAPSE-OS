import { hashFacilityInviteToken, rotateFacilityInviteToken } from "@synapse/db/facility-invite-token"
import { NextResponse } from "next/server"
import { createServiceClient } from "../../../../lib/supabase/server"
import { requirePlatformAdminApi } from "../../../../lib/platform/auth"
import { sendHospitalStaffInviteEmail } from "../../../../lib/resend"
import { logPlatformEvent } from "../../../platform/_lib/platform-data"
import {
  CANONICAL_HOSPITAL_MODULES,
  FACILITY_LEVELS,
  FACILITY_OWNERSHIP,
  provisionHospital,
  getProvisionRun,
  slugify,
  type FacilityLevel,
  type FacilityOwnership,
  type ProvisionMode,
} from "@synapse/db/hospital-provision"
import { facilityInviteUrl } from "@synapse/db/facility-provision"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const auth = await requirePlatformAdminApi("tenant.read")
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const slug = url.searchParams.get("slug")
  const runId = url.searchParams.get("runId")
  const modules = url.searchParams.get("modules")
  const supabaseAdmin = createServiceClient()

  if (modules === "1") {
    return NextResponse.json({ modules: CANONICAL_HOSPITAL_MODULES })
  }

  if (runId) {
    const detail = await getProvisionRun(supabaseAdmin, runId)
    if (!detail) return NextResponse.json({ error: "Run not found" }, { status: 404 })
    return NextResponse.json(detail)
  }

  if (!slug) {
    return NextResponse.json({ available: false }, { status: 400 })
  }

  const normalized = slugify(slug)
  const { data } = await (supabaseAdmin as any)
    .from("tenants")
    .select("id")
    .eq("slug", normalized)
    .maybeSingle()

  return NextResponse.json({ available: !data, slug: normalized })
}

export async function POST(request: Request) {
  const auth = await requirePlatformAdminApi("tenant.manage")
  if (!auth.ok) return auth.response
  const actor = auth.profile

  const body = await request.json().catch(() => ({}))
  const supabaseAdmin = createServiceClient()

  // Resend invitation for an existing run
  if (body.action === "resend_invite") {
    const runId = String(body.runId ?? "")
    const detail = await getProvisionRun(supabaseAdmin, runId)
    if (!detail?.invite) {
      return NextResponse.json({ error: "Invitation not found" }, { status: 404 })
    }
    // Only the hash is stored: a resend issues a fresh secret (old link stops working).
    const freshToken = await rotateFacilityInviteToken(supabaseAdmin, detail.invite.id)
    if (!freshToken) {
      return NextResponse.json({ error: "Invitation is no longer open" }, { status: 409 })
    }
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://synapseos.tech"
      await sendHospitalStaffInviteEmail({
        to: detail.invite.email,
        hospitalName: detail.run.facility_name,
        staffName: detail.invite.full_name || "Hospital Admin",
        role: detail.invite.role,
        inviteUrl: facilityInviteUrl("hospital", detail.run.slug, freshToken, { appUrl }),
      })
      await (supabaseAdmin as any)
        .from("facility_invitations")
        .update({ status: "SENT", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", detail.invite.id)
      await logPlatformEvent({
        actorId: actor.id,
        action: "hospital.invite_resent",
        entityType: "facility_invitations",
        entityId: detail.invite.id,
        tenantId: detail.run.tenant_id,
      })
      return NextResponse.json({ ok: true, status: "SENT" })
    } catch (err) {
      const message = err instanceof Error ? err.message : "invite_send_failed"
      await (supabaseAdmin as any)
        .from("facility_invitations")
        .update({ status: "FAILED", last_error: message, updated_at: new Date().toISOString() })
        .eq("id", detail.invite.id)
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }

  // Resume failed / incomplete provisioning
  if (body.action === "resume") {
    const runId = String(body.runId ?? "")
    if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 })
    const { resumeFacilityProvision } = await import("@synapse/db/hospital-provision")
    const result = await resumeFacilityProvision(supabaseAdmin, runId, actor.id)
    const failed = result.steps.find((s) => s.status === "FAILED")
    if (result.ok && result.inviteToken && body.sendInvite !== false) {
      try {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://synapseos.tech"
        await sendHospitalStaffInviteEmail({
          to: String(body.adminEmail ?? "").trim().toLowerCase() || "noreply@synapseos.tech",
          hospitalName: result.slug,
          staffName: "Facility Admin",
          role: "hospital_admin",
          inviteUrl: facilityInviteUrl("hospital", result.slug, result.inviteToken, { appUrl }),
        })
      } catch {
        /* invite email is retryable */
      }
    }
    return NextResponse.json(
      {
        id: result.tenantId,
        runId: result.runId,
        slug: result.slug,
        status: result.status,
        ok: result.ok,
        steps: result.steps,
        warnings: result.warnings,
        error: result.error,
        correlationId: result.correlationId,
        failureStep: failed?.step ?? null,
        failureCode: failed?.errorCode ?? null,
        failureReason: failed?.safeErrorMessage ?? result.error ?? null,
      },
      { status: result.ok ? 200 : 400 },
    )
  }

  const ownership = String(body.ownership ?? "").toUpperCase() as FacilityOwnership
  const facilityLevel = String(body.facilityLevel ?? body.facility_level ?? "").toUpperCase() as FacilityLevel
  const mode = (String(body.mode ?? "REAL").toUpperCase() === "SYNTHETIC_ACCEPTANCE"
    ? "SYNTHETIC_ACCEPTANCE"
    : "REAL") as ProvisionMode

  if (!FACILITY_OWNERSHIP.includes(ownership)) {
    return NextResponse.json(
      { error: `ownership must be one of: ${FACILITY_OWNERSHIP.join(", ")}` },
      { status: 400 },
    )
  }
  if (!FACILITY_LEVELS.includes(facilityLevel)) {
    return NextResponse.json(
      { error: `facilityLevel must be one of: ${FACILITY_LEVELS.join(", ")}` },
      { status: 400 },
    )
  }

  const result = await provisionHospital(supabaseAdmin, {
    facilityName: String(body.hospitalName ?? body.facilityName ?? ""),
    slug: body.subdomain ? String(body.subdomain) : undefined,
    country: body.country ? String(body.country) : "UG",
    district: body.district ? String(body.district) : undefined,
    city: body.city ? String(body.city) : undefined,
    ownership,
    facilityLevel,
    bedCapacity: body.bedsCount != null ? Number(body.bedsCount) : undefined,
    contactName: body.contactName ? String(body.contactName) : undefined,
    contactEmail: body.contactEmail ? String(body.contactEmail) : undefined,
    contactPhone: body.contactPhone ? String(body.contactPhone) : undefined,
    adminName: String(body.adminName ?? body.contactName ?? "Hospital Admin"),
    adminEmail: String(body.adminEmail ?? ""),
    adminPhone: body.adminPhone ? String(body.adminPhone) : undefined,
    tier: (body.tier as "trial" | "starter" | "professional" | "enterprise") || "trial",
    modules: Array.isArray(body.modules) ? body.modules.map(String) : undefined,
    mode,
    idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
    createdBy: actor.id,
    sendInvite: true,
  })

  // External side-effect: invitation email (retryable)
  if (result.ok && result.inviteToken && body.sendInvite !== false) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://synapseos.tech"
      const inviteUrl = facilityInviteUrl("hospital", result.slug, result.inviteToken, { appUrl })
      await sendHospitalStaffInviteEmail({
        to: String(body.adminEmail ?? "").trim().toLowerCase(),
        hospitalName: String(body.hospitalName ?? body.facilityName ?? result.slug),
        staffName: String(body.adminName ?? body.contactName ?? "Hospital Admin"),
        role: "hospital_admin",
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
      if (result.status === "COMPLETE") result.status = "READY_WITH_WARNINGS"
      await (supabaseAdmin as any)
        .from("facility_invitations")
        .update({
          status: "FAILED",
          last_error: err instanceof Error ? err.message : "send_failed",
          updated_at: new Date().toISOString(),
        })
        .eq("token_hash", hashFacilityInviteToken(result.inviteToken))
    }
  }

  await logPlatformEvent({
    actorId: actor.id,
    action: result.ok ? "hospital.provisioned" : "hospital.provision_failed",
    entityType: "facility_provisioning_runs",
    entityId: result.runId,
    tenantId: result.tenantId,
    metadata: {
      slug: result.slug,
      status: result.status,
      mode,
      warnings: result.warnings,
      inviteStatus: result.inviteStatus,
    },
  })

  return NextResponse.json(
    {
      id: result.tenantId,
      runId: result.runId,
      slug: result.slug,
      status: result.status,
      ok: result.ok,
      steps: result.steps,
      warnings: result.warnings,
      inviteStatus: result.inviteStatus,
      invitePath: result.inviteToken ? `/invite/facility/${result.inviteToken}` : null,
      error: result.error,
      correlationId: result.correlationId,
      failureStep: result.steps.find((s) => s.status === "FAILED")?.step ?? null,
      failureCode: result.steps.find((s) => s.status === "FAILED")?.errorCode ?? null,
      failureReason:
        result.steps.find((s) => s.status === "FAILED")?.safeErrorMessage ?? result.error ?? null,
    },
    { status: result.ok ? 200 : 400 },
  )
}
