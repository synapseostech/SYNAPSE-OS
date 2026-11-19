export const dynamic = "force-dynamic"

import Link from "next/link"
import { notFound } from "next/navigation"
import { requirePlatformPage } from "@/lib/platform/auth"
import { isAccountSuspended } from "@synapse/auth/account-suspension"
import { formatDate, safeRows } from "../../_lib/platform-data"
import { UserActions } from "../UserActions"

type ProfileRow = {
  id?: string
  full_name?: string | null
  email?: string | null
  role?: string | null
  synapse_id?: string | null
  verification_status?: string | null
  email_verified_at?: string | null
  is_deleted?: boolean | null
  created_at?: string | null
  last_sign_in_at?: string | null
  tenant_id?: string | null
}

type MembershipRow = {
  id?: string
  tenant_id?: string | null
  is_active?: boolean | null
  role?: string | null
}

export default async function PlatformUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  // Same capability as the /platform/users list (control-plane route policy maps it to user.read).
  const admin = await requirePlatformPage("/platform/users/[id]")
  const { id } = await params
  const profiles = await safeRows<ProfileRow>(
    "profiles",
    "id, full_name, email, role, synapse_id, verification_status, email_verified_at, is_deleted, created_at, last_sign_in_at, tenant_id",
    { filters: [["id", id]], limit: 1 },
  )
  const profile = profiles[0]
  if (!profile?.id || !profile.email) notFound()
  // Suspension is a SUSPENDED platform membership; fail safe to "suspended" display if the lookup errors.
  const accountSuspended = await isAccountSuspended(profile.id).catch(() => true)
  const effectiveStatus = accountSuspended ? "suspended" : profile.verification_status

  const memberships = await safeRows<MembershipRow>(
    "staff_scope_assignments",
    "id, tenant_id, is_active, role",
    { filters: [["profile_id", profile.id]], limit: 50 },
  )
  const mfa = await safeRows<{ id?: string; verified?: boolean | null }>(
    "mfa_enrollments",
    "id, verified",
    { filters: [["user_id", profile.id]], limit: 5 },
  )

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Identity</p>
        <h1 className="mt-1 text-2xl font-bold text-white">{profile.full_name ?? profile.email}</h1>
        <p className="mt-1 text-sm text-slate-400">{profile.email}</p>
      </div>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5 text-sm">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div><dt className="text-slate-500">Role</dt><dd>{profile.role ?? "—"}</dd></div>
          <div><dt className="text-slate-500">Synapse ID</dt><dd className="font-mono text-xs">{profile.synapse_id ?? "—"}</dd></div>
          <div><dt className="text-slate-500">Account status</dt><dd>{profile.is_deleted ? "archived" : effectiveStatus ?? "unknown"}</dd></div>
          <div><dt className="text-slate-500">Activation</dt><dd>{profile.email_verified_at ? "activated" : "pending activation"}</dd></div>
          <div><dt className="text-slate-500">MFA</dt><dd>{mfa.some((row) => row.verified) ? "enrolled" : "not enrolled"}</dd></div>
          <div><dt className="text-slate-500">Created</dt><dd>{formatDate(profile.created_at)}</dd></div>
          <div><dt className="text-slate-500">Last login</dt><dd>{profile.last_sign_in_at ? formatDate(profile.last_sign_in_at) : "Never"}</dd></div>
          <div><dt className="text-slate-500">Home facility</dt><dd className="font-mono text-xs">{profile.tenant_id ?? "—"}</dd></div>
        </dl>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold text-slate-200">Memberships</h2>
        <p className="mt-1 text-xs text-slate-500">Removing a membership does not delete this identity.</p>
        {memberships.length === 0 ? <p className="mt-3 text-sm text-slate-500">No facility scope assignments.</p> : (
          <ul className="mt-3 space-y-2 text-sm text-slate-300">
            {memberships.map((row) => (
              <li key={row.id ?? row.tenant_id}>
                <Link href={`/platform/facilities/${row.tenant_id}`} className="font-mono text-xs text-[#E8B84B] hover:underline">
                  {row.tenant_id}
                </Link>
                {" · "}{row.role ?? "member"}{" · "}{row.is_active === false ? "inactive" : "active"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <UserActions
        userId={profile.id}
        email={profile.email}
        role={profile.role ?? null}
        emailVerified={Boolean(profile.email_verified_at)}
        isDeleted={Boolean(profile.is_deleted)}
        verificationStatus={effectiveStatus}
        allowPurge
        isSelf={profile.id === admin.id}
      />
      <Link href="/platform/users" className="inline-block text-sm text-[#E8B84B] hover:underline">
        Back to users
      </Link>
    </div>
  )
}
