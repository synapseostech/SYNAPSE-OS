export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { supabaseAdmin } from '@synapse/db/admin'
import { MEETING_STATUSES, isMeetingStatus } from '@synapse/db/commercial-crm'
import { requirePlatformPage } from '../../../../lib/platform/auth'
import { updateMeetingStatusAction } from './actions'

export default async function CommercialMeetingsPage() {
  await requirePlatformPage("/platform/commercial/meetings")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: meetings } = await db
    .from('commercial_meetings')
    .select(
      'id, lead_id, status, requester_name, requester_email, requester_phone, organization_name, facility_name, facility_type, country, products_interested, preferred_at, scheduled_at, message, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(200)

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-[#E8B84B]">Commercial</p>
          <h1 className="text-2xl font-bold">Meetings</h1>
          <p className="text-sm text-slate-400">
            Book-a-Meeting requests. Scheduling providers (Calendly/Cal.com) can attach later via
            external_event_id without redesigning CRM.
          </p>
        </div>
        <Link href="/platform/commercial/leads" className="rounded-lg border border-slate-700 px-3 py-2 text-sm">
          ← Leads
        </Link>
      </div>

      {(meetings ?? []).length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-10 text-center text-sm text-slate-500">
          No meeting requests yet.
        </div>
      ) : (
        <div className="space-y-3">
          {(meetings ?? []).map(
            (m: {
              id: string
              status: string
              requester_name: string
              requester_email: string
              organization_name?: string
              facility_name?: string
              preferred_at?: string
              message?: string
              products_interested?: string[]
            }) => (
              <article key={m.id} className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-semibold text-slate-100">{m.requester_name}</p>
                    <p className="text-sm text-slate-400">
                      {m.requester_email} · {m.organization_name || m.facility_name || '—'}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      Preferred: {m.preferred_at ? new Date(m.preferred_at).toLocaleString() : 'not set'} ·{' '}
                      {(m.products_interested ?? []).join(', ') || 'no products listed'}
                    </p>
                    {m.message ? <p className="mt-2 text-sm text-slate-300">{m.message}</p> : null}
                  </div>
                  <form action={updateMeetingStatusAction} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={m.id} />
                    <select
                      name="status"
                      defaultValue={isMeetingStatus(m.status) ? m.status : 'requested'}
                      className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs"
                    >
                      {MEETING_STATUSES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                    <button type="submit" className="rounded border border-slate-700 px-2 py-1 text-xs">
                      Update
                    </button>
                  </form>
                </div>
              </article>
            ),
          )}
        </div>
      )}
    </div>
  )
}
