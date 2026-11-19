'use client'

import { useState, useTransition } from 'react'
import { resendFacilityInvitation, resendPharmacyInvite, resetTenantOnboarding } from './actions'

export type PendingInvite = { id: string; email: string; role: string | null; status: string; expiresAt: string | null }

export function TenantActions({
  tenantId,
  isPharmacy,
  hasPharmacyInvite,
  pendingInvites,
}: {
  tenantId: string
  isPharmacy: boolean
  hasPharmacyInvite: boolean
  pendingInvites: PendingInvite[]
}) {
  const [pending, start] = useTransition()
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null)

  function run(fn: () => Promise<{ ok: true; message: string } | { ok: false; error: string }>) {
    start(async () => {
      const r = await fn()
      setNotice(r.ok ? { ok: true, text: r.message } : { ok: false, text: r.error })
    })
  }

  return (
    <div className="space-y-3">
      {notice ? (
        <p role="status" className={`rounded-lg border px-3 py-2 text-sm ${notice.ok ? 'border-green-500/30 bg-green-500/10 text-green-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
          {notice.text}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {isPharmacy ? (
          <button
            type="button"
            disabled={pending || !hasPharmacyInvite}
            title={hasPharmacyInvite ? undefined : 'No onboarding invite on record'}
            onClick={() => run(() => resendPharmacyInvite(tenantId))}
            className="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-200 disabled:opacity-50"
          >
            Resend onboarding invite
          </button>
        ) : null}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            const reason = window.prompt('Reason for resetting onboarding (recorded in the audit trail):')
            if (!reason?.trim()) return
            run(() => resetTenantOnboarding(tenantId, reason))
          }}
          className="rounded-lg border border-amber-500/40 px-3 py-2 text-sm text-amber-200 disabled:opacity-50"
        >
          Reset onboarding
        </button>
      </div>
      {pendingInvites.length > 0 ? (
        <div>
          <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">Staff invitations not yet accepted</p>
          <ul className="divide-y divide-slate-800 rounded-lg border border-slate-800">
            {pendingInvites.map((inv) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span>
                  {inv.email}
                  <span className="ml-2 text-xs text-slate-500">{inv.role ?? ''} · {inv.status.toLowerCase()}</span>
                </span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => resendFacilityInvitation(tenantId, inv.id))}
                  className="text-xs text-[#F97316] hover:underline disabled:opacity-50"
                >
                  Resend
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
