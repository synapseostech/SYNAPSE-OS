/**
 * Clinical Intelligence Wave 1 master flag.
 * Default OFF in every environment unless explicitly set to "1"/"true".
 * Prod enable requires a separate ops decision — this module never auto-enables.
 */
import { supabaseAdmin } from "@synapse/db/admin"

export const CLINICAL_INTELLIGENCE_WAVE1_FLAG = "CLINICAL_INTELLIGENCE_WAVE1"
export const CLINICAL_INTELLIGENCE_TENANT_FEATURE_KEY = "clinical_intelligence_wave1"

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
  if (!tenantId) return false

  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select("is_enabled")
    .eq("tenant_id", tenantId)
    .eq("feature_key", CLINICAL_INTELLIGENCE_TENANT_FEATURE_KEY)
    .maybeSingle()

  // This flag decides whether clinical content is produced at all, so a failed
  // read is OFF: the gate never opens on an error.
  if (error) return false
  return data?.is_enabled === true
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
