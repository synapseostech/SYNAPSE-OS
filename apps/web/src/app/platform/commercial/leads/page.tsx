export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { supabaseAdmin } from '@synapse/db/admin'
import { CRM_STAGES, normalizeCrmStage } from '@synapse/db/commercial-crm'
import { requirePlatformPage } from '../../../../lib/platform/auth'
import { updateLeadStageAction } from './actions'

export default async function CommercialLeadsPage({
  searchParams,
}: {
  searchParams?: Promise<{ stage?: string; q?: string }>
}) {
  await requirePlatformPage("/platform/commercial/leads")
  const params = (await searchParams) ?? {}
  const stageFilter = params.stage ? normalizeCrmStage(params.stage) : null
  const q = (params.q ?? '').trim().toLowerCase()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: leads } = await db
    .from('hospital_leads')
    .select(
      'id, hospital_name, organization_name, facility_name, facility_type, contact_name, contact_email, contact_phone, location, country, district, stage, status, source, expected_value_ugx, next_action, next_action_at, meeting_preferred_at, requested_products, created_at, updated_at',
    )
    .order('updated_at', { ascending: false })
    .limit(300)

  const rows = (leads ?? []).filter((lead: { stage?: string; hospital_name?: string; contact_email?: string; organization_name?: string }) => {
    const stage = normalizeCrmStage(lead.stage)
    if (stageFilter && stage !== stageFilter) return false
    if (!q) return true
    const hay = `${lead.hospital_name ?? ''} ${lead.organization_name ?? ''} ${lead.contact_email ?? ''}`.toLowerCase()
    return hay.includes(q)
  })

  const byStage = new Map<string, number>()
  for (const stage of CRM_STAGES) byStage.set(stage, 0)
  for (const lead of leads ?? []) {
    const stage = normalizeCrmStage(lead.stage) ?? 'LEAD'
    byStage.set(stage, (byStage.get(stage) ?? 0) + 1)
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#E8B84B]">Commercial</p>
          <h1 className="text-2xl font-bold">Leads & pipeline</h1>
          <p className="text-sm text-slate-400">
            Platform CRM for prospects — never exposed to facility users.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/platform/commercial/meetings"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300"
          >
            Meetings
          </Link>
          <Link
            href="/platform/commercial/pricing"
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300"
          >
            Pricing
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/platform/commercial/leads"
          className={`rounded-full border px-3 py-1 text-xs ${!stageFilter ? 'border-[#E8B84B]/50 text-[#E8B84B]' : 'border-slate-700 text-slate-400'}`}
        >
          All ({(leads ?? []).length})
        </Link>
        {CRM_STAGES.map((stage) => (
          <Link
            key={stage}
            href={`/platform/commercial/leads?stage=${stage}`}
            className={`rounded-full border px-3 py-1 text-xs ${stageFilter === stage ? 'border-[#E8B84B]/50 text-[#E8B84B]' : 'border-slate-700 text-slate-400'}`}
          >
            {stage} ({byStage.get(stage) ?? 0})
          </Link>
        ))}
      </div>

      <form className="flex gap-2">
        <input
          name="q"
          defaultValue={params.q ?? ''}
          placeholder="Search organization, facility, email…"
          className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"
        />
        <button type="submit" className="rounded-lg bg-slate-800 px-3 py-2 text-sm text-slate-200">
          Search
        </button>
      </form>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-10 text-center text-sm text-slate-500">
          No leads yet. Public Book a Meeting submissions will appear here.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-800">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Organization</th>
                <th className="px-3 py-2">Contact</th>
                <th className="px-3 py-2">Products</th>
                <th className="px-3 py-2">Stage</th>
                <th className="px-3 py-2">Next</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(
                (lead: {
                  id: string
                  organization_name?: string
                  facility_name?: string
                  hospital_name?: string
                  contact_name?: string
                  contact_email?: string
                  contact_phone?: string
                  stage?: string
                  next_action?: string
                  requested_products?: string[]
                }) => (
                  <tr key={lead.id} className="border-t border-slate-800">
                    <td className="px-3 py-3">
                      <p className="font-medium text-slate-100">
                        {lead.organization_name || lead.hospital_name || '—'}
                      </p>
                      <p className="text-xs text-slate-500">{lead.facility_name || lead.hospital_name}</p>
                    </td>
                    <td className="px-3 py-3 text-slate-300">
                      <p>{lead.contact_name || '—'}</p>
                      <p className="text-xs text-slate-500">{lead.contact_email}</p>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-400">
                      {(lead.requested_products ?? []).join(', ') || '—'}
                    </td>
                    <td className="px-3 py-3">
                      <form action={updateLeadStageAction} className="flex gap-1">
                        <input type="hidden" name="id" value={lead.id} />
                        <select
                          name="stage"
                          defaultValue={normalizeCrmStage(lead.stage) ?? 'LEAD'}
                          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                        >
                          {CRM_STAGES.map((stage) => (
                            <option key={stage} value={stage}>
                              {stage}
                            </option>
                          ))}
                        </select>
                        <button type="submit" className="rounded border border-slate-700 px-2 py-1 text-xs">
                          Move
                        </button>
                      </form>
                    </td>
                    <td className="px-3 py-3 text-xs text-slate-500">{lead.next_action || '—'}</td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
