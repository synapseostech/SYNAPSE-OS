export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  formatUgxAnnual,
  listAllCommercialPlans,
  type CommercialPlan,
} from '@synapse/db/commercial-pricing'
import { PRICING_STATES } from '@synapse/db/commercial-pricing'
import { requirePlatformPage } from '../../../../lib/platform/auth'
import { updatePlanAction } from './actions'

export default async function PlatformPricingPage() {
  await requirePlatformPage("/platform/commercial/pricing")
  let plans: CommercialPlan[] = []
  let loadError: string | null = null
  try {
    plans = await listAllCommercialPlans(supabaseAdmin as never)
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: history } = await db
    .from('commercial_price_history')
    .select('id, plan_slug, previous_price_ugx, new_price_ugx, change_reason, created_at')
    .order('created_at', { ascending: false })
    .limit(20)

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#E8B84B]">Commercial</p>
          <h1 className="text-2xl font-bold text-slate-100">Pricing management</h1>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            Canonical annual catalog for synapseos.tech. Changes are audited and do not rewrite
            historical subscription snapshots.
          </p>
        </div>
        <Link
          href="/pricing"
          className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:border-[#E8B84B]/40"
        >
          Preview public pricing →
        </Link>
      </div>

      {loadError ? (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">
          Pricing catalog unavailable ({loadError}). Apply commercial migration before editing live
          prices. Fallback public prices remain in code for the website.
        </div>
      ) : null}

      {plans.length === 0 && !loadError ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-400">
          No commercial plans yet. Seed via migration <code>20260922170000_commercial_platform</code>.
        </div>
      ) : null}

      <div className="space-y-6">
        {plans.map((plan) => (
          <article
            key={plan.slug}
            className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5"
          >
            <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold text-slate-100">{plan.name}</h2>
                <p className="text-xs text-slate-500">
                  {plan.slug} · {formatUgxAnnual(plan.priceUgx, plan.pricingState)} · v{plan.version}
                </p>
              </div>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">
                {plan.pricingState}
              </span>
            </div>

            <form action={updatePlanAction} className="grid gap-3 md:grid-cols-2">
              <input type="hidden" name="slug" value={plan.slug} />
              <label className="text-xs text-slate-400">
                Name
                <input
                  name="name"
                  defaultValue={plan.name}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-400">
                Annual price (UGX)
                <input
                  name="priceUgx"
                  defaultValue={plan.priceUgx ?? ''}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                  placeholder="Leave empty for custom"
                />
              </label>
              <label className="text-xs text-slate-400">
                Pricing state
                <select
                  name="pricingState"
                  defaultValue={plan.pricingState}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                >
                  {PRICING_STATES.map((state) => (
                    <option key={state} value={state}>
                      {state}
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-slate-400">
                Display order
                <input
                  name="displayOrder"
                  type="number"
                  defaultValue={plan.displayOrder}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-400 md:col-span-2">
                Description
                <textarea
                  name="description"
                  defaultValue={plan.description ?? ''}
                  rows={2}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-400 md:col-span-2">
                Features (one per line)
                <textarea
                  name="featureList"
                  defaultValue={plan.featureList.join('\n')}
                  rows={5}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-400">
                CTA label
                <input
                  name="ctaLabel"
                  defaultValue={plan.ctaLabel ?? ''}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-400">
                CTA href
                <input
                  name="ctaHref"
                  defaultValue={plan.ctaHref ?? ''}
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <label className="text-xs text-slate-400 md:col-span-2">
                Change reason (audit)
                <input
                  name="changeReason"
                  placeholder="Why is this price changing?"
                  className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
                />
              </label>
              <div className="flex flex-wrap gap-4 text-xs text-slate-300 md:col-span-2">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" name="publicVisible" defaultChecked={plan.publicVisible} />
                  Public visible
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" name="isActive" defaultChecked={plan.isActive} />
                  Active
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" name="customQuote" defaultChecked={plan.customQuote} />
                  Custom quote
                </label>
              </div>
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A]"
                >
                  Save plan
                </button>
              </div>
            </form>
          </article>
        ))}
      </div>

      <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Price history</h2>
        {(history ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-slate-500">No price changes recorded yet.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {(history ?? []).map(
              (row: {
                id: string
                plan_slug: string
                previous_price_ugx: number | null
                new_price_ugx: number | null
                change_reason: string | null
                created_at: string
              }) => (
                <li key={row.id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
                  <span className="font-medium text-slate-200">{row.plan_slug}</span>
                  <span className="text-slate-500">
                    {' '}
                    · {row.previous_price_ugx ?? '—'} → {row.new_price_ugx ?? '—'} ·{' '}
                    {row.change_reason || 'no reason'} · {new Date(row.created_at).toLocaleString()}
                  </span>
                </li>
              ),
            )}
          </ul>
        )}
      </section>
    </div>
  )
}
