/**
 * Generic facility provisioning entry points.
 * Hospital path reuses durable hospital-provision workflow.
 * Pharmacy / laboratory use the same run/step model with type-specific adapters.
 */

import {
  provisionHospital,
  resumeFacilityProvision as resumeHospitalProvision,
  getProvisionRun,
  type DbClient,
  type ProvisionHospitalInput,
  type ProvisionHospitalResult,
  type ProvisionMode,
} from "./hospital-provision"
import { generateFacilityInviteToken, hashFacilityInviteToken, rotateFacilityInviteToken } from "./facility-invite-token"
import {
  FACILITY_TYPES,
  defaultModulesForFacilityType,
  pharmacyLoginUrl,
  pharmacyTenantSlug,
  slugify,
  type FacilityType,
  type FacilityLevel,
  type FacilityOwnership,
} from "./facility-provision-catalog"

export * from "./facility-provision-catalog"
export {
  provisionHospital,
  getProvisionRun,
  PROVISION_STEP_KEYS,
  type ProvisionHospitalResult,
  type ProvisionStepResult,
  type ProvisionRunStatus,
} from "./hospital-provision"

export type ProvisionFacilityInput = {
  facilityType: FacilityType
  facilityName: string
  slug?: string
  country?: string
  district?: string
  city?: string
  ownership?: FacilityOwnership
  facilityLevel?: FacilityLevel
  facilitySubtype?: string
  bedCapacity?: number
  contactName?: string
  contactEmail?: string
  contactPhone?: string
  adminName: string
  adminEmail: string
  adminPhone?: string
  tier?: "trial" | "starter" | "professional" | "enterprise"
  modules?: string[]
  licenseNumber?: string
  regulatoryNumber?: string
  accreditationStatus?: "NOT_ACCREDITED" | "IN_PROGRESS" | "ACCREDITED" | "UNKNOWN"
  accreditationIdentifier?: string
  laboratoryType?: string
  laboratorySections?: string[]
  physicalAddress?: string
  networkVisible?: boolean
  customDomain?: string | null
  mode?: ProvisionMode
  idempotencyKey?: string
  createdBy: string
  sendInvite?: boolean
  includeLab?: boolean
  includeDispensing?: boolean
}

function nowIso() {
  return new Date().toISOString()
}

function assertFacilityType(t: string): asserts t is FacilityType {
  if (!FACILITY_TYPES.includes(t as FacilityType)) {
    throw new Error(`Unsupported facilityType: ${t}`)
  }
}

/**
 * Provision any first-class facility type.
 * Hospitals / clinics / health centres share the hospital adapter.
 * Pharmacy and laboratory use dedicated adapters on the same run table.
 */
export async function provisionFacility(
  db: DbClient,
  input: ProvisionFacilityInput,
): Promise<ProvisionHospitalResult & { facilityType: FacilityType; workspaceUrl?: string }> {
  assertFacilityType(input.facilityType)

  if (
    input.facilityType === "hospital" ||
    input.facilityType === "clinic" ||
    input.facilityType === "health_centre"
  ) {
    const level: FacilityLevel =
      input.facilityType === "clinic"
        ? "CLINIC"
        : input.facilityType === "health_centre"
          ? "HEALTH_CENTRE"
          : (input.facilityLevel ?? "GENERAL_HOSPITAL")

    const modules =
      input.modules ??
      defaultModulesForFacilityType(input.facilityType, level, {
        includeLab: input.includeLab,
        includeDispensing: input.includeDispensing,
      })

    const hospitalInput: ProvisionHospitalInput = {
      facilityName: input.facilityName,
      slug: input.slug,
      country: input.country,
      district: input.district,
      city: input.city,
      ownership: input.ownership ?? "PUBLIC",
      facilityLevel: level,
      bedCapacity: input.bedCapacity,
      contactName: input.contactName,
      contactEmail: input.contactEmail,
      contactPhone: input.contactPhone,
      adminName: input.adminName,
      adminEmail: input.adminEmail,
      adminPhone: input.adminPhone,
      tier: input.tier,
      modules,
      includeLabAddon: Boolean(input.includeLab),
      facilityType: input.facilityType,
      mode: input.mode,
      idempotencyKey:
        input.idempotencyKey ??
        `${input.facilityType}:${input.mode ?? "REAL"}:${slugify(input.slug || input.facilityName)}:${input.adminEmail.trim().toLowerCase()}`,
      createdBy: input.createdBy,
      sendInvite: input.sendInvite,
    }

    const result = await provisionHospital(db, hospitalInput)

    // Align tenant facility_type for clinic / health_centre (hospital adapter defaults to hospital)
    if (result.tenantId && input.facilityType !== "hospital") {
      await db
        .from("tenants")
        .update({ facility_type: input.facilityType, updated_at: nowIso() })
        .eq("id", result.tenantId)
    }

    return {
      ...result,
      facilityType: input.facilityType,
      workspaceUrl: result.slug ? `https://${result.slug}.synapseos.tech` : undefined,
    }
  }

  if (input.facilityType === "pharmacy") {
    return provisionPharmacyFacility(db, input)
  }

  return provisionLaboratoryFacility(db, input)
}

/** Resume through the adapter that owns the facility lifecycle. */
export async function resumeFacilityProvision(
  db: DbClient,
  runId: string,
  createdBy: string,
): Promise<ProvisionHospitalResult & { facilityType?: FacilityType; workspaceUrl?: string }> {
  const detail = await getProvisionRun(db, runId)
  const run = detail?.run as Record<string, unknown> | undefined
  const runMetadata = (run?.metadata as Record<string, unknown>) ?? {}
  const facilityType = String(runMetadata.facility_type ?? "hospital") as FacilityType
  if (facilityType !== "pharmacy") {
    return resumeHospitalProvision(db, runId, createdBy)
  }

  const metadata = runMetadata
  const contact = (metadata.contact as Record<string, unknown>) ?? {}
  let adminEmail = String(contact.email ?? "").toLowerCase()
  let adminName = String(contact.name ?? "")
  if ((!adminEmail || !adminName) && run?.tenant_id) {
    const { data: tenant } = await db
      .from("tenants")
      .select("email, name")
      .eq("id", run.tenant_id)
      .maybeSingle()
    adminEmail ||= String(tenant?.email ?? "").toLowerCase()
    adminName ||= String(tenant?.name ?? "")
  }
  return provisionFacility(db, {
    facilityType: "pharmacy",
    facilityName: String(run?.facility_name ?? ""),
    slug: String(run?.slug ?? ""),
    country: String(metadata.country ?? "UG"),
    district: metadata.district ? String(metadata.district) : undefined,
    city: metadata.city ? String(metadata.city) : undefined,
    ownership: String(run?.ownership ?? "PRIVATE") as FacilityOwnership,
    adminName: adminName || "Facility Admin",
    adminEmail,
    adminPhone: contact.phone ? String(contact.phone) : undefined,
    tier: String(metadata.tier ?? "starter") as "trial" | "starter" | "professional" | "enterprise",
    createdBy,
    mode: String(run?.mode) === "SYNTHETIC_ACCEPTANCE" ? "SYNTHETIC_ACCEPTANCE" : "REAL",
    idempotencyKey: String(run?.idempotency_key ?? ""),
  })
}

async function provisionPharmacyFacility(
  db: DbClient,
  input: ProvisionFacilityInput,
): Promise<ProvisionHospitalResult & { facilityType: FacilityType; workspaceUrl?: string }> {
  const mode: ProvisionMode = input.mode ?? "REAL"
  const slug = pharmacyTenantSlug(input.slug || input.facilityName)
  const facilityName = input.facilityName.trim()
  const adminEmail = input.adminEmail.trim().toLowerCase()
  const correlationId = crypto.randomUUID()
  const idempotencyKey =
    input.idempotencyKey?.trim() || `pharmacy:${mode}:${slug}:${adminEmail}`
  const modules = input.modules ?? defaultModulesForFacilityType("pharmacy")
  const warnings: string[] = []
  const steps: ProvisionHospitalResult["steps"] = []

  const { data: existingRun } = await db
    .from("facility_provisioning_runs")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle()

  if (existingRun?.status === "COMPLETE" && existingRun.tenant_id) {
    const { data: existingInvite } = await db
      .from("facility_invitations")
      .select("status")
      .eq("run_id", existingRun.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    await db
      .from("facility_provisioning_runs")
      .update({ failure_code: null, updated_at: nowIso() })
      .eq("id", existingRun.id)
    return {
      ok: true,
      runId: existingRun.id,
      tenantId: existingRun.tenant_id,
      hospitalId: null,
      slug: existingRun.slug,
      status: "COMPLETE",
      correlationId: existingRun.correlation_id,
      steps: [],
      // Only the hash is stored, so a replay cannot re-reveal the invite secret.
      inviteToken: null,
      inviteStatus: existingInvite?.status ?? null,
      warnings: ["Idempotent replay — existing COMPLETE pharmacy run"],
      facilityType: "pharmacy",
      workspaceUrl: pharmacyLoginUrl(existingRun.slug),
    }
  }

  let runId = existingRun?.id as string | undefined
  if (!runId) {
    const { data: created, error } = await db
      .from("facility_provisioning_runs")
      .insert({
        created_by: input.createdBy,
        mode,
        status: "PENDING",
        current_step: "validate",
        correlation_id: correlationId,
        idempotency_key: idempotencyKey,
        slug,
        facility_name: facilityName,
        ownership: input.ownership ?? "PRIVATE",
        facility_level: "CLINIC",
        metadata: {
          facility_type: "pharmacy",
          contact: {
            name: input.contactName ?? input.adminName,
            email: input.contactEmail ?? adminEmail,
            phone: input.contactPhone ?? input.adminPhone ?? null,
          },
          city: input.city ?? null,
          district: input.district ?? null,
          country: input.country ?? "UG",
          tier: input.tier ?? "starter",
          license_number: input.licenseNumber ?? null,
          physical_address: input.physicalAddress ?? null,
        },
        started_at: nowIso(),
      })
      .select("id")
      .single()
    if (error || !created) {
      return {
        ok: false,
        runId: "",
        tenantId: null,
        hospitalId: null,
        slug,
        status: "FAILED",
        correlationId,
        steps: [],
        warnings: [],
        error: error?.message ?? "Failed to create pharmacy provisioning run",
        facilityType: "pharmacy",
      }
    }
    runId = created.id
  }

  let tenantId: string | null = existingRun?.tenant_id ?? null
  let inviteToken: string | null = null

  const fail = async (step: string, code: string, message: string) => {
    await db.from("facility_provisioning_steps").upsert(
      {
        run_id: runId,
        step,
        status: "FAILED",
        error_code: code,
        safe_error_message: message,
        completed_at: nowIso(),
        updated_at: nowIso(),
      },
      { onConflict: "run_id,step" },
    )
    await db
      .from("facility_provisioning_runs")
      .update({
        status: "FAILED",
        failure_code: code,
        failed_at: nowIso(),
        current_step: step,
        updated_at: nowIso(),
        metadata: { last_error: message, facility_type: "pharmacy" },
      })
      .eq("id", runId)
    if (tenantId) {
      await db
        .from("tenants")
        .update({ status: "failed", is_active: false, updated_at: nowIso() })
        .eq("id", tenantId)
    }
    steps.push({ step: step as never, status: "FAILED", errorCode: code, safeErrorMessage: message })
    return {
      ok: false,
      runId: runId!,
      tenantId,
      hospitalId: null,
      slug,
      status: "FAILED" as const,
      correlationId,
      steps,
      warnings,
      error: message,
      facilityType: "pharmacy" as const,
    }
  }

  const complete = async (step: string, evidence: Record<string, unknown> = {}) => {
    await db.from("facility_provisioning_steps").upsert(
      {
        run_id: runId,
        step,
        status: "COMPLETE",
        evidence,
        completed_at: nowIso(),
        error_code: null,
        safe_error_message: null,
        updated_at: nowIso(),
      },
      { onConflict: "run_id,step" },
    )
    steps.push({ step: step as never, status: "COMPLETE", evidence })
  }

  // validate
  await db
    .from("facility_provisioning_runs")
    .update({ status: "RUNNING", current_step: "validate", updated_at: nowIso() })
    .eq("id", runId)
  if (!facilityName || !adminEmail || !input.adminName?.trim()) {
    return fail("validate", "VALIDATION", "Pharmacy name, admin name and email are required")
  }
  const { data: slugConflict } = await db.from("tenants").select("id").eq("slug", slug).maybeSingle()
  if (slugConflict && slugConflict.id !== tenantId) {
    return fail("validate", "SLUG_TAKEN", `Slug "${slug}" is already taken`)
  }
  await complete("validate", { slug })

  // core_tenant
  if (!tenantId) {
    tenantId = crypto.randomUUID()
    const { error: tenantErr } = await db.from("tenants").insert({
      id: tenantId,
      slug,
      name: facilityName,
      facility_type: "pharmacy",
      district: input.district || null,
      country: input.country ?? "UG",
      email: adminEmail,
      phone: input.contactPhone || input.adminPhone || null,
      plan: input.tier ?? "starter",
      status: "provisioning",
      is_active: false,
      default_subdomain: slug,
      modules_enabled: modules,
      custom_domain: input.customDomain || null,
      onboarding_completed: false,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    if (tenantErr) {
      return fail("core_tenant", "TENANT_INSERT", tenantErr.message)
    }
    await db
      .from("facility_provisioning_runs")
      .update({ tenant_id: tenantId, updated_at: nowIso() })
      .eq("id", runId)
  } else {
    await db
      .from("tenants")
      .update({ status: "provisioning", is_active: false, updated_at: nowIso() })
      .eq("id", tenantId)
  }
  await complete("core_tenant", { tenantId })

  // facility_profile (pharmacy_profiles)
  {
    const { data: existing } = await db
      .from("pharmacy_profiles")
      .select("tenant_id")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (!existing) {
      const workspace = pharmacyLoginUrl(slug)
      const { error } = await db.from("pharmacy_profiles").insert({
        tenant_id: tenantId,
        pharmacy_name: facilityName,
        license_number: input.licenseNumber || null,
        district: input.district || null,
        physical_address: input.physicalAddress || null,
        contact_person: input.contactName || input.adminName,
        contact_phone: input.contactPhone || input.adminPhone || null,
        contact_email: adminEmail,
        default_domain: workspace,
        custom_domain: input.customDomain || null,
        domain_status: input.customDomain ? "REQUESTED" : "NOT_REQUESTED",
        is_network_visible: Boolean(input.networkVisible ?? true),
        migration_status: "ready",
        created_at: nowIso(),
        updated_at: nowIso(),
      })
      if (error) return fail("facility_profile", "PHARMACY_PROFILE_INSERT", error.message)
    }
    await complete("facility_profile", { tenantId })
  }

  // modules (feature_flags)
  {
    const flagRows = modules.map((feature_key) => ({
      tenant_id: tenantId,
      feature_key,
      is_enabled: true,
      enabled_by: input.createdBy,
      enabled_at: nowIso(),
      notes: "Enabled during pharmacy facility provisioning.",
    }))
    const { error } = await db.from("feature_flags").upsert(flagRows, { onConflict: "tenant_id,feature_key" })
    if (error) return fail("modules", "MODULES_UPSERT", error.message)
    await complete("modules", { modules })
  }

  // subscription
  {
    // Prefer canonical annual pharmacy catalog; keep legacy slugs as fallback only.
    const planSlugMap: Record<string, string> = {
      trial: "synapse_pharmacy_annual",
      starter: "synapse_pharmacy_annual",
      professional: "synapse_pharmacy_annual",
      enterprise: "synapse_pharmacy_annual",
    }
    const target = planSlugMap[input.tier ?? "starter"] ?? "synapse_pharmacy_annual"
    const { data: planRow } = await db
      .from("subscription_plans")
      .select("id")
      .eq("slug", target)
      .eq("is_active", true)
      .maybeSingle()
    // New pharmacies get the annual plan only — no legacy fallback.
    if (!planRow?.id) {
      return fail(
        "subscription",
        "PHARMACY_PLAN_MISSING",
        "Canonical pharmacy annual plan is missing. Provisioning aborted.",
      )
    }
    const trialEnd = new Date(Date.now() + 7 * 86400000).toISOString()
    const { error } = await db.from("tenant_subscriptions").upsert(
      {
        tenant_id: tenantId,
        plan_id: planRow.id,
        status: "trialing",
        starts_at: nowIso(),
        trial_ends: trialEnd,
        current_period_start: nowIso(),
        current_period_end: trialEnd,
      },
      { onConflict: "tenant_id" },
    )
    if (error) {
      return fail("subscription", "SUBSCRIPTION_UPSERT", error.message)
    }
    await complete("subscription", { planId: planRow.id, planSlug: target })
  }

  // store
  {
    const { data: existingStore } = await db
      .from("pharmacy_stores")
      .select("id")
      .eq("tenant_id", tenantId)
      .limit(1)
      .maybeSingle()
    if (!existingStore) {
      const { error } = await db.from("pharmacy_stores").insert({
        tenant_id: tenantId,
        name: `${facilityName} — Main Branch`,
        store_type: "main",
        is_active: true,
      })
      if (error) return fail("store", "STORE_INSERT", error.message)
    }
    await complete("store", { main: true })
  }

  // administrator (no password — invite sets it)
  let profileId: string | null = null
  {
    const { data: existingProfile } = await db
      .from("profiles")
      .select("id, tenant_id")
      .eq("email", adminEmail)
      .maybeSingle()
    if (existingProfile) {
      if (existingProfile.tenant_id && existingProfile.tenant_id !== tenantId) {
        return fail("administrator", "EMAIL_IN_USE", `Email ${adminEmail} already belongs to another facility`)
      }
      await db
        .from("profiles")
        .update({
          tenant_id: tenantId,
          role: "pharmacy_admin",
          is_admin: true,
          must_change_password: true,
          onboarding_complete: true,
          updated_at: nowIso(),
        })
        .eq("id", existingProfile.id)
      profileId = existingProfile.id
    } else {
      profileId = crypto.randomUUID()
      const parts = input.adminName.trim().split(/\s+/)
      const { error } = await db.from("profiles").insert({
        id: profileId,
        email: adminEmail,
        full_name: input.adminName.trim(),
        first_name: parts[0] ?? "Pharmacy",
        last_name: parts.slice(1).join(" ") || "Admin",
        role: "pharmacy_admin",
        tenant_id: tenantId,
        is_admin: true,
        must_change_password: true,
        verification_status: "verified",
        phone: input.adminPhone || input.contactPhone || null,
        onboarding_complete: true,
      })
      if (error) return fail("administrator", "PROFILE_INSERT", error.message)
    }
    const { data: existingSettings } = await db
      .from("pharmacy_user_settings")
      .select("id")
      .eq("profile_id", profileId)
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (!existingSettings) {
      const { error: settingsErr } = await db.from("pharmacy_user_settings").insert({
        profile_id: profileId,
        tenant_id: tenantId,
        pharmacy_role: "pharmacy_admin",
        permissions: [],
        is_active: true,
        must_change_password: true,
        created_by: input.createdBy,
      })
      if (settingsErr) warnings.push(`pharmacy_user_settings: ${settingsErr.message}`)
    }
    await complete("administrator", { profileId })
  }

  // invitation (secure — never email a password)
  {
    const { data: existingInvite } = await db
      .from("facility_invitations")
      .select("id, status")
      .eq("run_id", runId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (existingInvite) {
      // Raw secrets are never stored: issue a fresh one for a still-open invite.
      inviteToken = ["PENDING", "SENT"].includes(existingInvite.status)
        ? await rotateFacilityInviteToken(db, existingInvite.id)
        : null
      await complete("invitation", { inviteId: existingInvite.id, resumed: true })
    } else {
      inviteToken = generateFacilityInviteToken()
      const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString()
      const { data: invite, error } = await db
        .from("facility_invitations")
        .insert({
          tenant_id: tenantId,
          run_id: runId,
          email: adminEmail,
          full_name: input.adminName.trim(),
          role: "pharmacy_admin",
          token_hash: hashFacilityInviteToken(inviteToken),
          invite_token: null,
          status: "PENDING",
          expires_at: expiresAt,
          profile_id: profileId,
          created_by: input.createdBy,
        })
        .select("id")
        .single()
      if (error) {
        return fail("invitation", "INVITE_INSERT", error.message)
      } else {
        await complete("invitation", { inviteId: invite.id })
      }
    }
  }

  // domain (record only — pharm.synapseos.tech?tenant=slug)
  const workspaceUrl = pharmacyLoginUrl(slug)
  await complete("domain", {
    strategy: "pharm_login_tenant_query",
    workspaceUrl,
    customDomain: input.customDomain ?? null,
  })

  // finalize
  const hardFail = steps.some(
    (s) =>
      ["core_tenant", "facility_profile", "modules", "store", "administrator"].includes(s.step) &&
      s.status === "FAILED",
  )
  const finalStatus = hardFail ? "FAILED" : warnings.length ? "READY_WITH_WARNINGS" : "COMPLETE"
  if (finalStatus === "FAILED") {
    await db
      .from("tenants")
      .update({ status: "failed", is_active: false, updated_at: nowIso() })
      .eq("id", tenantId)
  } else {
    await db
      .from("tenants")
      .update({
        status: "active",
        is_active: true,
        onboarding_completed: true,
        updated_at: nowIso(),
      })
      .eq("id", tenantId)
    await db.from("pharmacy_onboarding").upsert(
      {
        tenant_id: tenantId,
        admin_email: adminEmail,
        admin_name: input.adminName.trim(),
        current_step: 5,
        onboarding_completed_at: nowIso(),
        enrolled_by: input.createdBy,
        account_created_at: nowIso(),
        invite_sent_at: nowIso(),
        updated_at: nowIso(),
      },
      { onConflict: "tenant_id" },
    )
  }
  await complete("finalize", { finalStatus })
  await db
    .from("facility_provisioning_runs")
    .update({
      status: finalStatus,
      completed_at: finalStatus === "FAILED" ? null : nowIso(),
      failed_at: finalStatus === "FAILED" ? nowIso() : null,
      failure_code: finalStatus === "FAILED" ? undefined : null,
      current_step: "finalize",
      updated_at: nowIso(),
    })
    .eq("id", runId)

  return {
    ok: finalStatus !== "FAILED",
    runId: runId!,
    tenantId,
    hospitalId: null,
    slug,
    status: finalStatus,
    correlationId,
    steps,
    inviteToken,
    inviteStatus: inviteToken ? "PENDING" : null,
    warnings,
    facilityType: "pharmacy",
    workspaceUrl,
  }
}

async function provisionLaboratoryFacility(
  db: DbClient,
  input: ProvisionFacilityInput,
): Promise<ProvisionHospitalResult & { facilityType: FacilityType; workspaceUrl?: string }> {
  // Laboratory foundation: reuse hospital provisioner with lab-only modules + facility_type override
  const modules = input.modules ?? defaultModulesForFacilityType("laboratory")
  const result = await provisionHospital(db, {
    facilityName: input.facilityName,
    slug: input.slug,
    country: input.country,
    district: input.district,
    city: input.city,
    ownership: input.ownership ?? "PUBLIC",
    facilityLevel: "SPECIALIST_HOSPITAL",
    bedCapacity: 0,
    contactName: input.contactName,
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    adminName: input.adminName,
    adminEmail: input.adminEmail,
    adminPhone: input.adminPhone,
    tier: input.tier ?? "trial",
    modules,
    facilityType: "laboratory",
    mode: input.mode,
    idempotencyKey:
      input.idempotencyKey ??
      `laboratory:${input.mode ?? "REAL"}:${slugify(input.slug || input.facilityName)}:${input.adminEmail.trim().toLowerCase()}`,
    createdBy: input.createdBy,
    sendInvite: input.sendInvite,
    laboratorySections: input.laboratorySections,
  })

  if (result.tenantId) {
    await db
      .from("tenants")
      .update({
        facility_type: "laboratory",
        laboratory_profile: {
          licenseNumber: input.licenseNumber ?? null,
          regulatoryNumber: input.regulatoryNumber ?? null,
          accreditationStatus: input.accreditationStatus ?? "UNKNOWN",
          accreditationIdentifier: input.accreditationIdentifier ?? null,
          laboratoryType: input.laboratoryType ?? "GENERAL_DIAGNOSTIC",
          enabledSections: input.laboratorySections ?? ["reception", "phlebotomy", "processing", "hematology", "chemistry", "microbiology", "quality"],
        },
        updated_at: nowIso(),
      })
      .eq("id", result.tenantId)
    if (result.hospitalId) {
      await db
        .from("hospitals")
        .update({
          type: "general",
          facility_kind: "laboratory",
          settings: {
            tenant_id: result.tenantId,
            facility_type: "laboratory",
            source: "platform_onboarding",
            ownership: input.ownership ?? "PUBLIC",
          },
        })
        .eq("id", result.hospitalId)
    }
  }

  // A new laboratory starts with the starter test list (no prices) so the
  // desk can register a walk-in on day one. Best effort: the lab admin can
  // load it later from Catalogue, and a missing function (migration
  // 20261121093700 not applied yet) must not fail provisioning.
  if (result.tenantId && typeof (db as { rpc?: unknown }).rpc === "function") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).rpc("lab_seed_starter_catalog", { p_tenant_id: result.tenantId })
    } catch {
      // ignored: see above
    }
  }

  return {
    ...result,
    facilityType: "laboratory",
    workspaceUrl: result.slug ? `https://${result.slug}.synapseos.tech` : undefined,
  }
}
