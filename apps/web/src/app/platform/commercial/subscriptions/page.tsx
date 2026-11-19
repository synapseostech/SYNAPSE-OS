export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { requirePlatformPage } from '@/lib/platform/auth'
import { createServiceClient } from '@/lib/supabase/server'

type SubRow = {
  id: string
  tenant_id: string
  status: string
  payment_status: string | null
  activation_source: string | null
  current_period_end: string | null
  agreed_price_ugx: number | null
  agreed_currency: string | null
  last_payment_at: string | null
  tenants?: { name?: string; facility_type?: string; slug?: string } | null
  subscription_plans?: { name?: string; slug?: string } | null
}

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}

export default async function CommercialSubscriptionsPage() {
  await requirePlatformPage("/platform/commercial/subscriptions")
  const db = createServiceClient() as any

  const [{ data: subs }, { data: recentOffline }] = await Promise.all([
    db
      .from('tenant_subscriptions')
      .select(
        `id, tenant_id, status, payment_status, activation_source, current_period_end,
         agreed_price_ugx, agreed_currency, last_payment_at,
         tenants ( name, facility_type, slug ),
         subscription_plans ( name, slug )`,
      )
      .order('updated_at', { ascending: false })
      .limit(500),
    db
      .from('subscription_payments')
      .select('id, tenant_id, amount_ugx, method, provider, status, confirmed_at, created_at')
      .eq('provider', 'manual')
      .order('created_at', { ascending: false })
      .limit(25),
  ])

  const rows: SubRow[] = subs ?? []
  const now = Date.now()
  const metrics = {
    active: rows.filter((r) => r.status === 'active').length,
    expiringSoon: rows.filter((r) => {
      const d = daysUntil(r.current_period_end)
      return r.status === 'active' && d != null && d >= 0 && d <= 30
    }).length,
    expired: rows.filter((r) => {
      const end = r.current_period_end ? new Date(r.current_period_end).getTime() : null
      return r.status === 'expired' || (end != null && end < now && r.status !== 'active')
    }).length,
    pendingPayment: rows.filter((r) => r.payment_status === 'pending' || r.payment_status === 'unpaid').length,
    partialPayment: rows.filter((r) => r.payment_status === 'partially_paid').length,
    offline: rows.filter(
      (r) => r.activation_source === 'OFFLINE_PAYMENT' || r.activation_source === 'MANUAL_ADMIN',
    ).length,
    online: rows.filter((r) => r.activation_source === 'FLUTTERWAVE').length,
    complimentary: rows.filter((r) => r.activation_source === 'COMPLIMENTARY').length,
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#E8B84B]">Commercial</p>
          <h1 className="text-2xl font-bold text-slate-100">Subscriptions</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Canonical tenant subscriptions — online and offline payments converge here. Activate from
            a facility&apos;s Subscription tab.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/platform/commercial/pricing"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-[#E8B84B]/40"
          >
            Pricing
          </Link>
          <Link
            href="/platform/facilities"
            className="rounded-lg bg-[#E8B84B] px-3 py-2 text-sm font-semibold text-slate-950"
          >
            Facilities →
          </Link>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {(
          [
            ['Active', metrics.active],
            ['Expiring ≤30d', metrics.expiringSoon],
            ['Expired', metrics.expired],
            ['Pending payment', metrics.pendingPayment],
            ['Partial payment', metrics.partialPayment],
            ['Offline activated', metrics.offline],
            ['Online (Flutterwave)', metrics.online],
            ['Complimentary', metrics.complimentary],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-slate-800 bg-slate-900/50 px-4 py-3">
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-2xl font-semibold text-slate-100">{value}</p>
          </div>
        ))}
      </div>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="font-semibold text-slate-100">Tenant subscriptions</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">Facility</th>
                <th className="px-5 py-3">Plan</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Payment</th>
                <th className="px-5 py-3">Source</th>
                <th className="px-5 py-3">Expires</th>
                <th className="px-5 py-3">Agreed</th>
                <th className="px-5 py-3" />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-8 text-slate-500">
                    No subscriptions yet.
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const d = daysUntil(r.current_period_end)
                  return (
                    <tr key={r.id} className="border-t border-slate-800">
                      <td className="px-5 py-3">
                        <div className="text-slate-100">{r.tenants?.name ?? '—'}</div>
                        <div className="font-mono text-[10px] text-slate-500">{r.tenants?.slug}</div>
                      </td>
                      <td className="px-5 py-3">{r.subscription_plans?.name ?? r.subscription_plans?.slug ?? '—'}</td>
                      <td className="px-5 py-3">{r.status}</td>
                      <td className="px-5 py-3">{r.payment_status ?? '—'}</td>
                      <td className="px-5 py-3 text-xs">{r.activation_source ?? '—'}</td>
                      <td className="px-5 py-3 text-xs text-slate-400">
                        {r.current_period_end
                          ? new Date(r.current_period_end).toLocaleDateString('en-GB', {
                              timeZone: 'Africa/Kampala',
                            })
                          : '—'}
                        {d != null ? (
                          <span className="ml-1 text-slate-600">({d}d)</span>
                        ) : null}
                      </td>
                      <td className="px-5 py-3 text-xs">
                        {r.agreed_price_ugx != null
                          ? `${r.agreed_currency ?? 'UGX'} ${Number(r.agreed_price_ugx).toLocaleString()}`
                          : '—'}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Link
                          href={`/platform/facilities/${r.tenant_id}?tab=subscription`}
                          className="text-xs text-[#E8B84B] hover:underline"
                        >
                          Manage
                        </Link>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/50">
        <div className="border-b border-slate-800 px-5 py-4">
          <h2 className="font-semibold text-slate-100">Recent offline payments</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-5 py-3">When</th>
                <th className="px-5 py-3">Amount</th>
                <th className="px-5 py-3">Method</th>
                <th className="px-5 py-3">Status</th>
                <th className="px-5 py-3">Tenant</th>
              </tr>
            </thead>
            <tbody>
              {(recentOffline ?? []).length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-6 text-slate-500">
                    No manual/offline payments recorded.
                  </td>
                </tr>
              ) : (
                (recentOffline ?? []).map(
                  (p: {
                    id: string
                    confirmed_at?: string
                    created_at?: string
                    amount_ugx: number
                    method?: string
                    status: string
                    tenant_id: string
                  }) => (
                    <tr key={p.id} className="border-t border-slate-800">
                      <td className="px-5 py-3 text-xs text-slate-400">
                        {new Date(p.confirmed_at ?? p.created_at ?? '').toLocaleString('en-GB', {
                          timeZone: 'Africa/Kampala',
                        })}
                      </td>
                      <td className="px-5 py-3">UGX {Number(p.amount_ugx).toLocaleString()}</td>
                      <td className="px-5 py-3">{p.method ?? '—'}</td>
                      <td className="px-5 py-3">{p.status}</td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/platform/facilities/${p.tenant_id}?tab=subscription`}
                          className="font-mono text-xs text-[#E8B84B] hover:underline"
                        >
                          {p.tenant_id.slice(0, 8)}…
                        </Link>
                      </td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
