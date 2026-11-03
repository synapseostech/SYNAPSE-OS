/** True when Supabase service-role integration tests can run. */
const supabaseUrl = (process.env.SUPABASE_URL ?? "").trim()
const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()

/** Mirrors scripts/e2e-acceptance-isolation.mjs; ci-db-gate.test.ts keeps the two equal. */
export const PRODUCTION_PROJECT_REF = "qfqakzmjatszisuqjwon"

export function supabaseProjectRef(value: string): string | null {
  try {
    const match = new URL(value).hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * The project ref the operator declared as the disposable acceptance target.
 * Empty means no remote project has been declared.
 */
export const DECLARED_ACCEPTANCE_PROJECT_REF = (process.env.SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF ?? "")
  .trim()
  .toLowerCase()

/**
 * These suites insert fixtures. An operator shell that exports a remote
 * deployment's credentials must fail loudly rather than write to it, and a
 * remote project is accepted only when it is the one explicitly declared for
 * acceptance. Loopback URLs (the harness and CI) need no declaration.
 */
export function assertDisposableDatabaseTarget(
  urlRef: string | null,
  declaredRef: string,
): void {
  if (urlRef === PRODUCTION_PROJECT_REF) {
    throw new Error(
      "[integration] refusing to run database integration tests against the production Supabase project. " +
        "Point SUPABASE_URL at a disposable database, or unset SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to skip them.",
    )
  }
  if (!urlRef) return
  if (!declaredRef) {
    throw new Error(
      `[integration] refusing to run database integration tests against remote Supabase project ${urlRef}: ` +
        "no acceptance target was declared. Set SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF to that project's ref, " +
        "or unset SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to skip these suites.",
    )
  }
  if (urlRef !== declaredRef) {
    throw new Error(
      `[integration] refusing to run database integration tests: SUPABASE_URL names ${urlRef} ` +
        `but SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF declares ${declaredRef}.`,
    )
  }
}

assertDisposableDatabaseTarget(supabaseProjectRef(supabaseUrl), DECLARED_ACCEPTANCE_PROJECT_REF)

export const hasDb = Boolean(supabaseUrl && serviceRoleKey)
export const hasPartialDbConfig = Boolean(supabaseUrl || serviceRoleKey) && !hasDb
