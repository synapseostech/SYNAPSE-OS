/**
 * The Supabase side of app releases: the service-role reads and writes behind
 * the pure logic in record.ts, email.ts and ../app-release.ts. Server only.
 */
import { supabaseAdmin } from "@synapse/db/admin"
import type { AppReleaseReader, AppReleaseRow } from "../app-release"
import type { ReleaseEmailStore } from "./email"
import type { ReleaseCandidate, ReleaseWriter, StoredRelease } from "./record"

// The generated Database types predate these tables.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const PLATFORM = "android"
const PAGE = 1000

/** Roles that run a facility or pharmacy and should hear about every APK. */
export const RELEASE_ADMIN_ROLES = [
  "admin",
  "hospital_admin",
  "overall_admin",
  "lab_admin",
  "imaging_admin",
  "pharmacy_admin",
] as const
const PHARMACY_ADMIN_ROLES = ["pharmacy_ceo", "pharmacy_admin"] as const

type ReleaseRow = AppReleaseRow & {
  id: string
  eas_build_id: string
  build_profile: string | null
  git_commit: string | null
  source: ReleaseCandidate["source"]
  published_at: string
}

const RELEASE_COLUMNS =
  "id, version, version_code, apk_url, notes, minimum_version, eas_build_id, build_profile, git_commit, source, published_at"

function stored(row: ReleaseRow): StoredRelease {
  return {
    id: row.id,
    version: row.version,
    versionCode: row.version_code,
    apkUrl: row.apk_url,
    notes: row.notes,
    minimumVersion: row.minimum_version,
    easBuildId: row.eas_build_id,
    buildProfile: row.build_profile,
    gitCommit: row.git_commit,
    source: row.source,
    publishedAt: row.published_at,
  }
}

function fail(what: string, error: { message?: string } | null): never {
  throw new Error(`[app-releases] ${what}: ${error?.message ?? "unknown error"}`)
}

/** Every page of a query, so a large tenant list is not cut at the API's row cap. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function allRows<T>(what: string, query: () => any): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query().range(from, from + PAGE - 1)
    if (error) fail(what, error)
    rows.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE) return rows
  }
}

export const appReleaseReader: AppReleaseReader = {
  async latest() {
    const { data, error } = await db()
      .from("app_releases")
      .select("version, version_code, apk_url, notes, minimum_version, published_at")
      .eq("platform", PLATFORM)
      .order("version_code", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) fail("read latest release", error)
    return (data as AppReleaseRow | null) ?? null
  },
}

export const appReleaseWriter: ReleaseWriter = {
  async upsert(release) {
    const refresh = async () => {
      const patch: Record<string, unknown> = {
        apk_url: release.apkUrl,
        eas_build_id: release.easBuildId,
        build_profile: release.buildProfile,
        git_commit: release.gitCommit,
        version: release.version,
        updated_at: new Date().toISOString(),
      }
      if (release.notes) patch.notes = release.notes
      if (release.minimumVersion) patch.minimum_version = release.minimumVersion
      const { data, error } = await db()
        .from("app_releases")
        .update(patch)
        .eq("platform", PLATFORM)
        .eq("version_code", release.versionCode)
        .select(RELEASE_COLUMNS)
        .single()
      if (error) fail("refresh release", error)
      return { release: stored(data as ReleaseRow), created: false }
    }

    const { data: existing, error: readError } = await db()
      .from("app_releases")
      .select("id")
      .eq("platform", PLATFORM)
      .eq("version_code", release.versionCode)
      .maybeSingle()
    if (readError) fail("look up release", readError)
    if (existing) return refresh()

    const { data, error } = await db()
      .from("app_releases")
      .insert({
        platform: PLATFORM,
        version: release.version,
        version_code: release.versionCode,
        apk_url: release.apkUrl,
        notes: release.notes,
        minimum_version: release.minimumVersion,
        eas_build_id: release.easBuildId,
        build_profile: release.buildProfile,
        git_commit: release.gitCommit,
        source: release.source,
      })
      .select(RELEASE_COLUMNS)
      .single()
    // The other sender recorded the same build in between: take theirs.
    if (error?.code === "23505") return refresh()
    if (error) fail("record release", error)
    return { release: stored(data as ReleaseRow), created: true }
  },

  async latestVersionCode() {
    const { data, error } = await db()
      .from("app_releases")
      .select("version_code")
      .eq("platform", PLATFORM)
      .order("version_code", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) fail("read latest versionCode", error)
    return (data as { version_code: number } | null)?.version_code ?? null
  },
}

export const releaseEmailStore: ReleaseEmailStore = {
  async adminEmails() {
    const byRole = await allRows<{ email: string | null }>("read admin profiles", () =>
      db()
        .from("profiles")
        .select("email")
        .in("role", RELEASE_ADMIN_ROLES)
        .not("email", "is", null)
        .or("is_deleted.is.null,is_deleted.eq.false")
        .order("id"),
    )
    const pharmacyAdmins = await allRows<{ profile_id: string }>("read pharmacy admins", () =>
      db()
        .from("pharmacy_user_settings")
        .select("profile_id")
        .in("pharmacy_role", PHARMACY_ADMIN_ROLES)
        .eq("is_active", true)
        .order("id"),
    )
    const ids = [...new Set(pharmacyAdmins.map((row) => row.profile_id))]
    const byPharmacyRole: { email: string | null }[] = []
    for (let index = 0; index < ids.length; index += 200) {
      const { data, error } = await db()
        .from("profiles")
        .select("email")
        .in("id", ids.slice(index, index + 200))
        .not("email", "is", null)
        .or("is_deleted.is.null,is_deleted.eq.false")
      if (error) fail("read pharmacy admin profiles", error)
      byPharmacyRole.push(...((data ?? []) as { email: string | null }[]))
    }
    return [...byRole, ...byPharmacyRole].map((row) => row.email).filter((email): email is string => Boolean(email))
  },

  async optedInEmails() {
    const [preferences, waitlist] = await Promise.all([
      allRows<{ email: string }>("read release opt-ins", () =>
        db().from("app_release_email_preferences").select("email").eq("opted_in", true).is("opted_out_at", null).order("email"),
      ),
      // People who asked to hear when the APK is out.
      allRows<{ email: string }>("read APK waitlist", () => db().from("apk_waitlist").select("email").order("email")),
    ])
    return [...preferences, ...waitlist].map((row) => row.email)
  },

  async optedOutEmails() {
    const rows = await allRows<{ email: string }>("read release opt-outs", () =>
      db().from("app_release_email_preferences").select("email").not("opted_out_at", "is", null).order("email"),
    )
    return rows.map((row) => row.email)
  },

  async claim(releaseId, emails) {
    const claimed: string[] = []
    for (let index = 0; index < emails.length; index += 500) {
      const { data, error } = await db()
        .from("app_release_email_deliveries")
        .upsert(
          emails.slice(index, index + 500).map((email) => ({ release_id: releaseId, email })),
          { onConflict: "release_id,email", ignoreDuplicates: true },
        )
        // With ignoreDuplicates only the rows actually inserted come back.
        .select("email")
      if (error) fail("claim deliveries", error)
      claimed.push(...((data ?? []) as { email: string }[]).map((row) => row.email))
    }
    return claimed
  },

  async markSent(releaseId, email, providerId) {
    const { error } = await db()
      .from("app_release_email_deliveries")
      .update({ status: "sent", provider_id: providerId, sent_at: new Date().toISOString() })
      .eq("release_id", releaseId)
      .eq("email", email)
    if (error) fail("mark delivery sent", error)
  },

  async markFailed(releaseId, email, message) {
    const { error } = await db()
      .from("app_release_email_deliveries")
      .update({ status: "failed", error: message })
      .eq("release_id", releaseId)
      .eq("email", email)
    if (error) fail("mark delivery failed", error)
  },
}

/** Records an opt-out; it outranks any opt-in and any admin role. */
export async function optOutOfReleaseEmails(email: string): Promise<void> {
  const now = new Date().toISOString()
  const { error } = await db()
    .from("app_release_email_preferences")
    .upsert({ email, opted_in: false, opted_out_at: now, updated_at: now }, { onConflict: "email" })
  if (error) fail("record opt-out", error)
}
