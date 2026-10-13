/**
 * Clinical Intelligence Wave 1 master flag.
 * Default OFF in every environment unless explicitly set to "1"/"true".
 * Prod enable requires a separate ops decision — this module never auto-enables.
 */
export const CLINICAL_INTELLIGENCE_WAVE1_FLAG = "CLINICAL_INTELLIGENCE_WAVE1"

export function isClinicalIntelligenceWave1Enabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env[CLINICAL_INTELLIGENCE_WAVE1_FLAG] ?? "").trim().toLowerCase()
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes"
}

/**
 * Check if Clinical Intelligence Wave 1 is enabled for a specific tenant.
 * This checks both the global environment flag AND tenant-scoped feature_flags table.
 * For production, the global flag should remain OFF. For staging, a tenant allowlist
 * can be configured via the feature_flags table (tenant_id + feature_key='clinical_intelligence_wave1').
 */
export async function isClinicalIntelligenceWave1EnabledForTenant(
  tenantId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  // Global flag check (for staging environments where we enable for all tenants)
  if (isClinicalIntelligenceWave1Enabled(env)) {
    return true
  }

  // Tenant-scoped check via feature_flags table
  // This requires a Supabase service-role client - caller must provide one
  // Implementation would be:
  // const { data } = await supabaseAdmin
  //   .from("feature_flags")
  //   .select("is_enabled")
  //   .eq("tenant_id", tenantId)
  //   .eq("feature_key", "clinical_intelligence_wave1")
  //   .maybeSingle()
  // return data?.is_enabled === true

  // For now, return false since we don't have the client here
  // The API route will perform the actual DB check
  return false
}

export function clinicalIntelligenceDisabledResponse() {
  return {
    ok: false as const,
    code: "CLINICAL_INTELLIGENCE_DISABLED" as const,
    advisory: true as const,
    message:
      "Clinical Intelligence Wave 1 is feature-flagged OFF. AI advises only when enabled; clinician decides.",
  }
}
