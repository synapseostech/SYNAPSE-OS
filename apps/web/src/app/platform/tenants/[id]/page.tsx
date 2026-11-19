export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { supabaseAdmin } from '@synapse/db/admin'
import { requirePlatformPage } from '@/lib/platform/auth'
import { roleHasCapability } from '@/lib/platform/rbac'
import { formatBytes, importStateLabel, loadTenantOverview } from '@/lib/platform/tenants.server'
import { FacilityLifecyclePanel } from '../../facilities/[id]/lifecycle-panel'
import { formatDateTime } from '../../_lib/platform-data'
import { TenantActions, type PendingInvite } from './tenant-actions'

type AuditEntry = { at: string; action: string; who: string | null; detail: string | null; source: string }

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-[#111117] p-5">
      <h2 className="mb-3 text-sm font-semibold text-white">{title}</h2>
      {children}
    </section>
  )
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-200">{value}</dd>
    </div>
  )
}

export default async function TenantControlPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePlatformPage('/platform/tenants/[id]')
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const [{ rows, source }, users, imports, auditLog, lifecycle, onboarding, invites] = await Promise.all([
    loadTenantOverview(),
    db.from('profiles').select('id, full_name, email, role, last_sign_in_at').eq('tenant_id', id).order('last_sign_in_at', { ascending: false, nullsFirst: false }).limit(50),
    db.from('pharmacy_import_sessions').select('id, status, file_name, total_rows, matched_rows, flagged_rows, error_message, created_at, completed_at').eq('tenant_id', id).order('created_at', { ascending: false }).limit(10),
    db.from('audit_log').select('action, user_id, user_role, new_value, created_at, table_name').or(`tenant_id.eq.${id},record_id.eq.${id}`).order('created_at', { ascending: false }).limit(40),
    db.from('facility_lifecycle_events').select('action, actor_id, from_state, to_state, reason, created_at').eq('tenant_id', id).order('created_at', { ascending: false }).limit(20),
    db.from('pharmacy_onboarding').select('current_step, invite_token, invite_sent_at, invite_expires_at, onboarding_completed_at').eq('tenant_id', id).maybeSingle(),
    db.from('facility_invitations').select('id, email, role, status, expires_at').eq('tenant_id', id).in('status', ['PENDING', 'SENT', 'EXPIRED', 'FAILED']).order('created_at', { ascending: false }).limit(20),
  ])

  const tenant = rows.find((r) => r.tenantId === id)
  if (!tenant) notFound()

  const audit: AuditEntry[] = [
    ...((auditLog.data ?? []) as Array<Record<string, unknown>>).map((a) => ({
      at: String(a.created_at),
      action: String(a.action),
      who: (a.user_role as string) ?? null,
      detail: a.new_value && typeof a.new_value === 'object' && 'reason' in (a.new_value as object) ? String((a.new_value as { reason: unknown }).reason) : null,
      source: String(a.table_name ?? 'audit_log'),
    })),
    ...((lifecycle.data ?? []) as Array<Record<string, unknown>>).map((e) => ({
      at: String(e.created_at),
      action: `lifecycle: ${String(e.action)} (${String(e.from_state)} → ${String(e.to_state)})`,
      who: null,
      detail: (e.reason as string) ?? null,
      source: 'facility_lifecycle_events',
    })),
  ].sort((a, b) => b.at.localeCompare(a.at))

  const canManage = roleHasCapability(actor.platformRole, 'tenant.manage')
  const pendingInvites: PendingInvite[] = ((invites.data ?? []) as Array<Record<string, unknown>>).map((i) => ({
    id: String(i.id),
    email: String(i.email),
    role: (i.role as string) ?? null,
    status: String(i.status),
    expiresAt: (i.expires_at as string) ?? null,
  }))
  const productHref =
    tenant.product === 'hospital' ? `/platform/hospitals/${id}` : tenant.product === 'pharmacy' ? '/platform/pharmacy-network' : `/platform/facilities/${id}`

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">
            <Link href="/platform/tenants" className="hover:underline">All tenants</Link> · {tenant.product}
          </p>
          <h1 className="mt-2 text-2xl font-bold">{tenant.name}</h1>
          <p className="mt-1 text-sm text-slate-400">
            {tenant.slug ? `${tenant.slug}.synapseos.tech` : 'No subdomain'}
            {tenant.isSynthetic ? <span className="ml-2 rounded bg-sky-500/10 px-1.5 text-xs text-sky-300">test tenant</span> : null}
          </p>
        </div>
        <Link href={productHref} className="text-sm text-[#F97316] hover:underline">Open in product view →</Link>
      </div>

      <Card title="Overview">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Fact label="Type" value={<span className="capitalize">{tenant.facilityType ?? '—'}</span>} />
          <Fact label="Plan" value={<span className="capitalize">{tenant.plan ?? '—'}{tenant.tier && tenant.tier !== tenant.plan ? ` (${tenant.tier})` : ''}</span>} />
          <Fact label="Status" value={<span className="capitalize">{tenant.lifecycleStatus?.toLowerCase() ?? tenant.status ?? '—'}</span>} />
          <Fact label="Onboarding" value={tenant.onboardingCompleted ? 'Complete' : `Step ${tenant.onboardingStep ?? 0}`} />
          <Fact label="Users" value={tenant.userCount} />
          <Fact label="Last activity" value={tenant.lastActivityAt ? formatDateTime(tenant.lastActivityAt) : 'Never'} />
          <Fact label="Storage" value={source === 'rpc' ? `${formatBytes(tenant.storageBytes)} · ${tenant.storageObjects ?? 0} files` : 'Not measured'} />
          <Fact label="Created" value={tenant.createdAt ? formatDateTime(tenant.createdAt) : '—'} />
        </dl>
      </Card>

      {canManage ? (
        <Card title="Actions">
          <TenantActions
            tenantId={id}
            isPharmacy={tenant.product === 'pharmacy'}
            hasPharmacyInvite={Boolean(onboarding.data?.invite_token) && !onboarding.data?.onboarding_completed_at}
            pendingInvites={pendingInvites}
          />
          <div className="mt-5 border-t border-slate-800 pt-5">
            <p className="mb-3 text-xs text-slate-500">
              Suspend, reactivate, archive and delete. Deleting is only possible for test tenants, by a Super admin, after typing the tenant&apos;s name and confirming with an authenticator code.
            </p>
            <FacilityLifecyclePanel facilityId={id} facilityName={tenant.name} />
          </div>
        </Card>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={`Users (${tenant.userCount})`}>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left text-xs text-slate-500">
                <tr><th className="py-1 pr-3">Name</th><th className="py-1 pr-3">Role</th><th className="py-1">Last sign-in</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {((users.data ?? []) as Array<Record<string, string | null>>).map((u) => (
                  <tr key={String(u.id)}>
                    <td className="py-2 pr-3">
                      <Link href={`/platform/users/${u.id}`} className="hover:text-[#F97316]">{u.full_name ?? u.email}</Link>
                      <span className="block text-xs text-slate-500">{u.email}</span>
                    </td>
                    <td className="py-2 pr-3 text-slate-400">{u.role ?? '—'}</td>
                    <td className="py-2 text-slate-400">{u.last_sign_in_at ? formatDateTime(u.last_sign_in_at) : 'Never'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(users.data ?? []).length === 0 ? <p className="text-sm text-slate-500">No users yet.</p> : null}
          </div>
        </Card>

        {tenant.product === 'pharmacy' ? (
          <Card title={`Tally imports · ${importStateLabel(tenant)}`}>
            <ul className="divide-y divide-slate-800 text-sm">
              {((imports.data ?? []) as Array<Record<string, unknown>>).map((i) => (
                <li key={String(i.id)} className="py-2">
                  <div className="flex justify-between gap-2">
                    <span className="truncate">{String(i.file_name ?? 'Import')}</span>
                    <span className="shrink-0 capitalize text-slate-400">{String(i.status)}</span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatDateTime(i.created_at)} · {Number(i.matched_rows ?? 0)}/{Number(i.total_rows ?? 0)} rows matched
                    {Number(i.flagged_rows ?? 0) ? ` · ${Number(i.flagged_rows)} flagged` : ''}
                  </p>
                  {i.error_message ? <p className="mt-1 text-xs text-red-300">{String(i.error_message).slice(0, 200)}</p> : null}
                </li>
              ))}
            </ul>
            {(imports.data ?? []).length === 0 ? <p className="text-sm text-slate-500">No Tally imports yet.</p> : null}
          </Card>
        ) : null}
      </div>

      <Card title="Audit trail">
        <ol className="divide-y divide-slate-800 text-sm">
          {audit.slice(0, 50).map((a, idx) => (
            <li key={`${a.at}-${idx}`} className="flex flex-wrap justify-between gap-2 py-2">
              <span>
                <span className="font-mono text-xs text-slate-300">{a.action}</span>
                {a.detail ? <span className="ml-2 text-slate-400">“{a.detail}”</span> : null}
              </span>
              <span className="text-xs text-slate-500">{a.who ? `${a.who} · ` : ''}{formatDateTime(a.at)}</span>
            </li>
          ))}
        </ol>
        {audit.length === 0 ? <p className="text-sm text-slate-500">Nothing recorded for this tenant yet.</p> : null}
        <p className="mt-3 text-xs text-slate-500">
          <Link href="/platform/audit-log" className="hover:underline">Full platform audit log →</Link>
        </p>
      </Card>
    </div>
  )
}
