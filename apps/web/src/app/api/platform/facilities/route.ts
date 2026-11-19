import { hashFacilityInviteToken } from "@synapse/db/facility-invite-token"
import { NextResponse } from "next/server"
import { createServiceClient } from "../../../../lib/supabase/server"
import { requirePlatformAdminApi } from "../../../../lib/platform/auth"
import { sendHospitalStaffInviteEmail } from "../../../../lib/resend"
import { logPlatformEvent } from "../../../platform/_lib/platform-data"
import {
  FACILITY_TYPES,
  provisionFacility,
  resumeFacilityProvision,
  getProvisionRun,
  facilityInviteUrl,
  slugify,
  type FacilityType,
  type FacilityLevel,
  type FacilityOwnership,
} from "@synapse/db/facility-provision"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const auth = await requirePlatformAdminApi("tenant.read")
  if (!auth.ok) return auth.response

  const url = new URL(request.url)
  const runId = url.searchParams.get("runId")
  const slug = url.searchParams.get("slug")
  const supabaseAdmin = createServiceClient()

  if (runId) {
    const detail = await getProvisionRun(supabaseAdmin, runId)
    if (!detail) return NextResponse.json({ error: "Run not found" }, { status: 404 })
    return NextResponse.json(detail)
  }

  if (!slug) return NextResponse.json({ available: false }, { status: 400 })
  const normalized = slugify(slug)
  const { data } = await (supabaseAdmin as any).from("tenants").select("id").eq("slug", normalized).maybeSingle()
  return NextResponse.json({ available: !data, slug: normalized })
}

export async function POST(request: Request) {
  const auth = await requirePlatformAdminApi("tenant.manage")
  if (!auth.ok) return auth.response
  const actor = auth.profile
  const body = await request.json().catch(() => ({}))
  const supabaseAdmin = createServiceClient()

  if (body.action === "resume") {
    const runId = String(body.runId ?? "")
    if (!runId) return NextResponse.json({ error: "runId required" }, { status: 400 })
    const result = await resumeFacilityProvision(supabaseAdmin, runId, actor.id)
    const failed = result.steps.find((s) => s.status === "FAILED")
    return NextResponse.json(
      {
        ok: result.ok,
        id: result.tenantId,
        runId: result.runId,
        slug: result.slug,
        status: result.status,
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

  const facilityType = String(body.facilityType ?? "hospital").toLowerCase() as FacilityType
  if (!FACILITY_TYPES.includes(facilityType)) {
    return NextResponse.json(
      { error: `facilityType must be one of: ${FACILITY_TYPES.join(", ")}` },
      { status: 400 },
    )
  }

  const result = await provisionFacility(supabaseAdmin, {
    facilityType,
    facilityName: String(body.facilityName ?? body.hospitalName ?? body.pharmacyName ?? ""),
    slug: body.slug ? String(body.slug) : body.subdomain ? String(body.subdomain) : undefined,
    country: body.country ? String(body.country) : "UG",
    district: body.district ? String(body.district) : undefined,
    city: body.city ? String(body.city) : undefined,
    ownership: body.ownership
      ? (String(body.ownership).toUpperCase() as FacilityOwnership)
      : facilityType === "pharmacy"
        ? "PRIVATE"
        : "PUBLIC",
    facilityLevel: body.facilityLevel
      ? (String(body.facilityLevel).toUpperCase() as FacilityLevel)
      : undefined,
    bedCapacity: body.bedsCount != null ? Number(body.bedsCount) : undefined,
    contactName: body.contactName ? String(body.contactName) : undefined,
    contactEmail: body.contactEmail ? String(body.contactEmail) : undefined,
    contactPhone: body.contactPhone ? String(body.contactPhone) : undefined,
    adminName: String(body.adminName ?? body.contactName ?? "Facility Admin"),
    adminEmail: String(body.adminEmail ?? ""),
    adminPhone: body.adminPhone ? String(body.adminPhone) : undefined,
    tier: (body.tier as "trial" | "starter" | "professional" | "enterprise") || "trial",
    modules: Array.isArray(body.modules) ? body.modules.map(String) : undefined,
    licenseNumber: body.licenseNumber ? String(body.licenseNumber) : undefined,
    regulatoryNumber: body.regulatoryNumber ? String(body.regulatoryNumber) : undefined,
    accreditationStatus: body.accreditationStatus ? String(body.accreditationStatus).toUpperCase() as "NOT_ACCREDITED" | "IN_PROGRESS" | "ACCREDITED" | "UNKNOWN" : undefined,
    accreditationIdentifier: body.accreditationIdentifier ? String(body.accreditationIdentifier) : undefined,
    laboratoryType: body.laboratoryType ? String(body.laboratoryType) : undefined,
    laboratorySections: Array.isArray(body.laboratorySections) ? body.laboratorySections.map(String) : undefined,
    physicalAddress: body.physicalAddress ? String(body.physicalAddress) : undefined,
    networkVisible: body.networkVisible != null ? Boolean(body.networkVisible) : true,
    customDomain: body.customDomain ? String(body.customDomain).toLowerCase() : null,
    mode: String(body.mode ?? "REAL").toUpperCase() === "SYNTHETIC_ACCEPTANCE" ? "SYNTHETIC_ACCEPTANCE" : "REAL",
    idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : undefined,
    createdBy: actor.id,
    sendInvite: true,
    includeLab: Boolean(body.includeLab),
    includeDispensing: Boolean(body.includeDispensing),
  })

  if (result.ok && result.inviteToken && result.inviteStatus === "PENDING" && body.sendInvite !== false) {
    try {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "https://synapseos.tech"
      const inviteUrl = facilityInviteUrl(facilityType, result.slug, result.inviteToken, {
        appUrl,
        pharmacyAppUrl: process.env.NEXT_PUBLIC_PHARMACY_APP_URL,
      })
      await sendHospitalStaffInviteEmail({
        to: String(body.adminEmail ?? "").trim().toLowerCase(),
        hospitalName: String(body.facilityName ?? result.slug),
        staffName: String(body.adminName ?? "Facility Admin"),
        role: facilityType === "pharmacy" ? "pharmacy_admin" : facilityType === "laboratory" ? "lab_admin" : "hospital_admin",
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
    action: result.ok ? "facility.provisioned" : "facility.provision_failed",
    entityType: "facility_provisioning_runs",
    entityId: result.runId,
    tenantId: result.tenantId,
    metadata: {
      facilityType,
      slug: result.slug,
      status: result.status,
      warnings: result.warnings,
      paymentStatus: body.paymentStatus ?? "ONLINE_REQUIRED",
    },
  })

  if (result.ok && result.tenantId && body.paymentStatus) {
    const paymentMap: Record<string, string> = {
      ONLINE_REQUIRED: "unpaid",
      OFFLINE_RECEIVED: "pending",
      PENDING: "pending",
      COMPLIMENTARY: "unpaid",
    }
    const nextStatus = paymentMap[String(body.paymentStatus)]
    if (nextStatus) {
      await (supabaseAdmin as any)
        .from("tenant_subscriptions")
        .update({
          payment_status: nextStatus,
          commercial_notes: `Provisioning payment intent: ${body.paymentStatus}`,
          updated_at: new Date().toISOString(),
        })
        .eq("tenant_id", result.tenantId)
    }
  }

  const failed = result.steps.find((s) => s.status === "FAILED")
  return NextResponse.json(
    {
      id: result.tenantId,
      runId: result.runId,
      slug: result.slug,
      status: result.status,
      ok: result.ok,
      facilityType: result.facilityType,
      workspaceUrl: result.workspaceUrl,
      steps: result.steps,
      warnings: result.warnings,
      inviteStatus: result.inviteStatus,
      invitePath: result.inviteToken ? `/invite/facility/${result.inviteToken}` : null,
      paymentStatus: body.paymentStatus ?? "ONLINE_REQUIRED",
      error: result.error,
      correlationId: result.correlationId,
      failureStep: failed?.step ?? null,
      failureCode: failed?.errorCode ?? null,
      failureReason: failed?.safeErrorMessage ?? result.error ?? null,
    },
    { status: result.ok ? 200 : 400 },
  )
}
