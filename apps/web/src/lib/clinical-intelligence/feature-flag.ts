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

export function clinicalIntelligenceDisabledResponse() {
  return {
    ok: false as const,
    code: "CLINICAL_INTELLIGENCE_DISABLED" as const,
    advisory: true as const,
    message:
      "Clinical Intelligence Wave 1 is feature-flagged OFF. AI advises only when enabled; clinician decides.",
  }
}
