import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@synapse/db/admin"
import {
  assertPurgeConfirmation,
  isMissingRelationError,
  normalizeLifecycleState,
  previewFacilityLifecycle,
  type FacilityLifecycleAction,
  type LifecycleCounts,
} from "@synapse/db/facility-lifecycle"
import { hasRecentVerifiedMfa } from "@synapse/auth"
import { requirePlatformAdminApi } from "@/lib/platform/auth"
import { logPlatformEvent } from "@/app/platform/_lib/platform-data"
import { roleHasCapability } from "@/lib/platform/rbac"

export const dynamic = "force-dynamic"

const ACTIONS = new Set<FacilityLifecycleAction>([
  "suspend",
  "resume",
  "archive",
  "restore",
  "request_delete",
  "cancel_delete",
  "purge",
])

const DEPENDENCY_QUERIES: Array<{ key: keyof LifecycleCounts; table: string; column?: string }> = [
  { key: "patients", table: "patients" },
  { key: "encounters", table: "encounters" },
  { key: "invoices", table: "billing_invoices" },
  { key: "prescriptions", table: "clinical_prescriptions" },
  { key: "labOrders", table: "lab_orders" },
  { key: "payments", table: "billing_payments" },
  { key: "subscriptions", table: "subscriptions" },
  { key: "signedDocuments", table: "clinical_documents" },
  { key: "referrals", table: "facility_referrals" },
  { key: "deathRecords", table: "death_pronouncements" },
  { key: "mortuaryRecords", table: "mortuary_records" },
  { key: "auditEvents", table: "facility_lifecycle_events" },
  { key: "devices", table: "lab_devices" },
  { key: "memberships", table: "staff_scope_assignments" },
]

async function countTenantRows(table: string, tenantId: string, activeOnly = false) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let query = db.from(table).select("id", { count: "exact", head: true }).eq("tenant_id", tenantId)
  if (activeOnly) query = query.eq("is_active", true)
  const { count, error } = await query
  if (!error) return { count: count ?? 0, uncertain: false }
  const message = String(error.message ?? "")
  if (isMissingRelationError(error.code, message)) return { count: 0, uncertain: false }
  return { count: 0, uncertain: true, message }
}

async function loadImpact(tenantId: string): Promise<{ counts: LifecycleCounts; uncertain: string[] }> {
  const counts: LifecycleCounts = {
    staffExclusive: 0,
    staffShared: 0,
    patients: 0,
    encounters: 0,
    invoices: 0,
    prescriptions: 0,
    labOrders: 0,
    payments: 0,
    subscriptions: 0,
    signedDocuments: 0,
    referrals: 0,
    deathRecords: 0,
    mortuaryRecords: 0,
    auditEvents: 0,
    devices: 0,
    memberships: 0,
  }
  const uncertain: string[] = []
  await Promise.all(
    DEPENDENCY_QUERIES.map(async (item) => {
      const result = await countTenantRows(item.table, tenantId, item.key === "memberships")
      counts[item.key] = result.count
      if (result.uncertain) uncertain.push(item.table)
    }),
  )
  counts.staffExclusive = counts.memberships
  return { counts, uncertain }
}

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdminApi("tenant.read")
  if (!auth.ok) return auth.response
  const { id } = await context.params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: tenant, error } = await db
    .from("tenants")
    .select("id, status, is_active, lifecycle_status, facility_type, name, slug, is_synthetic")
    .eq("id", id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!tenant) return NextResponse.json({ error: "Facility not found" }, { status: 404 })
  const impact = await loadImpact(id)
  const counts = impact.counts
  const isSynthetic = Boolean(
    tenant.is_synthetic === true ||
      String(tenant.name ?? "").toLowerCase().includes("synthetic") ||
      String(tenant.slug ?? "").includes("accept") ||
      String(tenant.slug ?? "").includes("syn-accept"),
  )
  return NextResponse.json({
    tenantId: id,
    name: tenant.name,
    currentState: normalizeLifecycleState(tenant.lifecycle_status ?? tenant.status, tenant.is_active !== false),
    isSynthetic,
    counts,
    analysisIncomplete: impact.uncertain,
  })
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = await requirePlatformAdminApi("tenant.manage")
  if (!auth.ok) return auth.response
  const { id } = await context.params
  const body = await req.json().catch(() => null) as {
    action?: string
    reason?: string
    typedConfirmation?: string
    acknowledged?: boolean
  } | null
  const action = body?.action as FacilityLifecycleAction | undefined
  if (!action || !ACTIONS.has(action)) {
    return NextResponse.json({ error: "Unknown lifecycle action" }, { status: 400 })
  }
  // Permanent deletion is its own capability (Super admin only), on top of
  // tenant.manage, the typed confirmation and the authenticator step-up below.
  if (action === "purge" && !roleHasCapability(auth.profile.platformRole, "tenant.purge")) {
    return NextResponse.json(
      { code: "PLATFORM_FORBIDDEN", error: "Only a Super admin can permanently delete a tenant" },
      { status: 403 },
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: tenant, error } = await db
    .from("tenants")
    .select("id, status, is_active, lifecycle_status, facility_type, name, slug, is_synthetic")
    .eq("id", id)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!tenant) return NextResponse.json({ error: "Facility not found" }, { status: 404 })

  const currentState = normalizeLifecycleState(tenant.lifecycle_status ?? tenant.status, tenant.is_active !== false)
  const impact = await loadImpact(id)
  const counts = impact.counts
  const isSynthetic = Boolean(
    tenant.is_synthetic === true ||
      String(tenant.name ?? "").toLowerCase().includes("synthetic") ||
      String(tenant.slug ?? "").includes("accept") ||
      String(tenant.slug ?? "").includes("syn-accept"),
  )
  const preview = previewFacilityLifecycle({
    tenantId: id,
    currentState,
    action,
    isSynthetic,
    allowHardPurge: process.env.SYNAPSE_ALLOW_HARD_PURGE === "true",
    counts,
  })

  if (["suspend", "archive", "request_delete", "purge"].includes(action) && !String(body?.reason ?? "").trim()) {
    return NextResponse.json({ preview, error: "Reason required" }, { status: 400 })
  }

  if (action === "purge") {
    if (impact.uncertain.length > 0) {
      preview.allowed = false
      preview.nextState = null
      preview.blockers.push(`Dependency analysis incomplete for: ${impact.uncertain.join(", ")}`)
    }
    const confirmation = assertPurgeConfirmation({
      facilityName: String(tenant.name ?? ""),
      facilityId: id,
      typedConfirmation: body?.typedConfirmation,
      acknowledged: body?.acknowledged === true,
    })
    if (!confirmation.ok) {
      preview.allowed = false
      preview.blockers.push(confirmation.error)
      return NextResponse.json({ preview, error: confirmation.error }, { status: 400 })
    }
    const recentMfa = await hasRecentVerifiedMfa(auth.profile.id, auth.profile.sessionId)
    if (!recentMfa) {
      return NextResponse.json(
        { preview, error: "Recent authenticator verification is required", code: "MFA_STEP_UP_REQUIRED" },
        { status: 403 },
      )
    }
  }

  if (!preview.allowed || !preview.nextState) {
    return NextResponse.json({ preview }, { status: 409 })
  }

  const next = preview.nextState
  // tenants.status CHECK allows only provisioning|active|suspended|trial.
  // lifecycle_status holds ARCHIVE / DELETION_PENDING / DELETED.
  const operationalStatus =
    next === "ACTIVE" ? (tenant.status === "trial" ? "trial" : "active") : "suspended"
  const { error: updateError } = await db
    .from("tenants")
    .update({
      lifecycle_status: next,
      status: operationalStatus,
      is_active: next === "ACTIVE",
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (updateError) return NextResponse.json({ error: updateError.message, preview }, { status: 500 })

  const correlationId = crypto.randomUUID()
  await db.from("facility_lifecycle_events").insert({
    tenant_id: id,
    actor_id: auth.profile.id,
    action,
    from_state: currentState,
    to_state: next,
    reason: body?.reason ?? null,
    correlation_id: correlationId,
    impact: preview,
  })
  await logPlatformEvent({
    actorId: auth.profile.id,
    actorRole: auth.profile.platformRole,
    action: `FACILITY_${action.toUpperCase()}`,
    entityType: "tenant",
    entityId: id,
    metadata: { correlation_id: correlationId, from: currentState, to: next },
  }).catch(() => {})

  return NextResponse.json({ preview: { ...preview, correlationId } })
}
