import { requirePlatformPage } from '@/lib/platform/auth'
import { createServiceClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export default async function PlatformSubscriptionsPage() {
  await requirePlatformPage("/platform/subscriptions")
  const db = createServiceClient() as any
  const { data: grants } = await db
    .from('subscription_grants')
    .select('id, subject_type, subject_id, tenant_id, grant_type, starts_at, ends_at, status, reason, created_at, subscription_plans(slug, name)')
    .order('created_at', { ascending: false })
    .limit(100)

  return (
    <main className="min-h-screen bg-[#071018] px-8 py-10 text-slate-100">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Control plane</p>
            <h1 className="mt-2 text-3xl font-semibold">Manual subscription grants</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-400">Grant pilot or compassionate access without creating a fake payment. Every change is tenant-scoped and audited.</p>
          </div>
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-200">Payment remains separate</span>
        </div>
        <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-lg font-semibold">Grant access</h2>
          <form action="/api/platform/subscription-grants" method="post" className="mt-4 grid gap-4 md:grid-cols-4">
            <label className="text-sm text-slate-300">Subject type<select name="subject_type" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" defaultValue="TENANT"><option>TENANT</option><option>FACILITY</option><option>PHARMACY</option><option>LABORATORY</option><option>CLINIC</option><option>HOSPITAL</option><option>ORGANIZATION</option><option>USER</option></select></label>
            <label className="text-sm text-slate-300">Subject ID<input required name="subject_id" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" placeholder="UUID" /></label>
            <label className="text-sm text-slate-300">Plan slug<input name="plan_slug" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" placeholder="pilot or professional" /></label>
            <label className="text-sm text-slate-300">Tenant ID<input name="tenant_id" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" placeholder="Required for tenant scope" /></label>
            <label className="text-sm text-slate-300">Starts at<input required type="datetime-local" name="starts_at" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" /></label>
            <label className="text-sm text-slate-300">Ends at<input required type="datetime-local" name="ends_at" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" /></label>
            <label className="text-sm text-slate-300">Grant type<select name="grant_type" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"><option>PILOT</option><option>MANUAL</option><option>COMPASSIONATE</option><option>PROMOTIONAL</option><option>PARTNER</option></select></label>
            <label className="text-sm text-slate-300">Reason<input required name="reason" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" placeholder="Pilot onboarding" /></label>
            <div className="md:col-span-4"><button type="submit" className="rounded-lg bg-[#E8B84B] px-4 py-2 text-sm font-semibold text-slate-950">Create manual grant</button></div>
          </form>
        </section>
        <section className="mt-8 overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60">
          <div className="border-b border-slate-800 px-5 py-4"><h2 className="font-semibold">Grant history</h2></div>
          <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase tracking-wide text-slate-500"><tr><th className="px-5 py-3">Subject</th><th className="px-5 py-3">Plan</th><th className="px-5 py-3">Status</th><th className="px-5 py-3">Window</th><th className="px-5 py-3">Reason</th></tr></thead><tbody>{(grants ?? []).map((grant: any) => <tr key={grant.id} className="border-t border-slate-800"><td className="px-5 py-3">{grant.subject_type}<br /><span className="font-mono text-xs text-slate-500">{grant.subject_id}</span></td><td className="px-5 py-3">{grant.subscription_plans?.name ?? grant.subscription_plans?.slug ?? 'Default plan'}</td><td className="px-5 py-3"><span className="rounded-full border border-amber-400/30 px-2 py-1 text-xs text-amber-200">{grant.status}</span></td><td className="px-5 py-3 text-xs text-slate-400">{new Date(grant.starts_at).toLocaleDateString()} - {new Date(grant.ends_at).toLocaleDateString()}</td><td className="px-5 py-3 text-slate-300">{grant.reason}</td></tr>)}</tbody></table></div>
        </section>
      </div>
    </main>
  )
}
