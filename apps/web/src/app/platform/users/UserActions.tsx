'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import {
  activateUserAccount,
  archiveUserAccount,
  permanentlyDeleteIdentity,
  reactivateUserAccount,
  restoreUserAccount,
  revokeUserSessions,
  sendPasswordResetForUser,
  suspendUserAccount,
} from './actions'
import { platformNotices } from './notice-bus'
import { fetchJson, useStepUp } from '../_components/step-up'

type Props = {
  userId: string
  email: string
  role: string | null
  emailVerified: boolean
  isDeleted: boolean
  verificationStatus?: string | null
  allowPurge?: boolean
  /** True when this row is the signed-in operator. Self-destructive actions are hidden (server also refuses them). */
  isSelf?: boolean
}

const PHARMACY_URL =
  process.env.NEXT_PUBLIC_PHARMACY_URL ?? 'https://pharm.synapseos.tech'

export function UserActions({ userId, email, role, emailVerified, isDeleted, verificationStatus, allowPurge = false, isSelf = false }: Props) {
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [imitatePending, setImitatePending] = useState(false)
  const { withStepUp, dialog: stepUpDialog } = useStepUp()

  const isPharmacyUser =
    role !== 'platform_admin' &&
    role !== 'superadmin' &&
    role !== null

  function run(action: () => Promise<{ ok: boolean; error?: string; email?: string }>, success: string) {
    setMessage(null)
    setError(null)
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        setMessage(success)
        platformNotices.publish(`${success} (${email})`)
      } else {
        setError(result.error ?? 'Action failed.')
        platformNotices.publish(`${result.error ?? 'Action failed.'} (${email})`, 'error')
      }
    })
  }

  function onReset() {
    if (!confirm(`Send a password reset link to ${email}?`)) return
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      fd.set('email', email)
      return sendPasswordResetForUser(fd)
    }, `Reset link sent to ${email}. Valid ~15 minutes.`)
  }

  function onActivate() {
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      return activateUserAccount(fd)
    }, 'Account activated (email verified). Login guards still apply.')
  }

  function onSuspend() {
    const reason = window.prompt('Reason for suspending this account (required):')
    if (!reason?.trim()) return
    if (!confirm(`Suspend ${email}? The identity and historical authorship stay. Sessions will be revoked.`)) return
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      fd.set('reason', reason.trim())
      return suspendUserAccount(fd)
    }, 'Account suspended. Sessions revoked. Identity preserved.')
  }

  function onReactivate() {
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      return reactivateUserAccount(fd)
    }, 'Account reactivated.')
  }

  function onPurge() {
    const typed = window.prompt(`Permanent deletion keeps no profile row. Type ${email} to confirm. Historical authorship blocks this action.`)
    if (!typed) return
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      fd.set('typed_email', typed)
      return permanentlyDeleteIdentity(fd)
    }, 'Identity deleted. This is only allowed when no protected authorship exists.')
  }

  function onRestore() {
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      return restoreUserAccount(fd)
    }, 'Identity restored.')
  }

  function onArchive() {
    const reason = window.prompt('Reason for archiving this identity (required):')
    if (!reason?.trim()) return
    if (!confirm(`Archive ${email}? Historical authorship is kept. This is not a permanent delete.`)) return
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      fd.set('reason', reason.trim())
      return archiveUserAccount(fd)
    }, 'Identity archived. Authorship preserved.')
  }

  function onRevokeSessions() {
    if (!confirm(`Revoke all sessions for ${email}?`)) return
    run(async () => {
      const fd = new FormData()
      fd.set('user_id', userId)
      return revokeUserSessions(fd)
    }, 'Sessions revoked.')
  }

  async function onImpersonate() {
    if (!confirm(`Open a 2-hour impersonation session as ${email}?`)) return
    setError(null)
    setImitatePending(true)
    const tab = window.open('', '_blank')
    if (!tab) {
      setError('Pop-up blocked — allow pop-ups for this site and try again.')
      setImitatePending(false)
      return
    }
    try {
      const data = await withStepUp(() =>
        fetchJson('/api/platform/impersonate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetUserId: userId }),
        }),
      )
      if (!data.ok || typeof data.token !== 'string') {
        tab.close()
        setError(data.error ?? 'Could not start impersonation session.')
        return
      }
      const params = new URLSearchParams({ token: data.token })
      tab.location.href = `${PHARMACY_URL}/api/auth/impersonate/start?${params}`
    } catch {
      tab.close()
      setError('Network error — please try again.')
    } finally {
      setImitatePending(false)
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {stepUpDialog}
      <div className="flex flex-wrap items-center justify-end gap-1.5" role="group" aria-label={`Actions for ${email}`}>
        <Link
          href={`/platform/users/${userId}`}
          className="rounded-md border border-slate-700 px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-[#E8B84B]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E8B84B]"
        >
          View
        </Link>
        {!emailVerified && !isDeleted ? (
          <button
            type="button"
            onClick={onActivate}
            disabled={pending}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300 hover:border-emerald-500/60 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            Activate
          </button>
        ) : null}
        {isPharmacyUser && !isDeleted ? (
          <button
            type="button"
            onClick={onImpersonate}
            disabled={imitatePending}
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-300 hover:border-amber-500/60 hover:text-amber-200 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
          >
            {imitatePending ? 'Starting…' : 'Impersonate'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onRevokeSessions}
          disabled={pending || isDeleted}
          className="rounded-md border border-slate-700 bg-[#07070A] px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E8B84B]"
        >
          Revoke sessions
        </button>
        <button
          type="button"
          onClick={onReset}
          disabled={pending || !email || isDeleted}
          className="rounded-md border border-slate-700 bg-[#07070A] px-2.5 py-1 text-xs font-medium text-slate-200 hover:border-[#F97316]/40 hover:text-[#F97316] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E8B84B]"
        >
          {pending ? 'Working…' : 'Reset password'}
        </button>
        {!isDeleted ? (
          <>
            {verificationStatus === "suspended" ? (
              <button
                type="button"
                onClick={onReactivate}
                disabled={pending}
                className="rounded-md border border-emerald-500/30 px-2.5 py-1 text-xs font-medium text-emerald-300 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
              >
                Reactivate
              </button>
            ) : null}
            {isSelf ? null : (
            <>
            <button
              type="button"
              onClick={onSuspend}
              disabled={pending}
              className="rounded-md border border-amber-500/30 px-2.5 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
            >
              Suspend
            </button>
            <button
              type="button"
              onClick={onArchive}
              disabled={pending}
              className="rounded-md border border-red-500/30 px-2.5 py-1 text-xs font-medium text-red-300 hover:bg-red-500/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
            >
              Archive
            </button>
            </>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={onRestore}
            disabled={pending}
            className="rounded-md border border-emerald-500/30 px-2.5 py-1 text-xs font-medium text-emerald-300 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
          >
            Restore
          </button>
        )}
      </div>
      {allowPurge && !isDeleted && !isSelf ? (
        <button
          type="button"
          onClick={onPurge}
          disabled={pending}
          className="rounded-md border border-red-700/50 px-2.5 py-1 text-xs font-medium text-red-400 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400"
        >
          Delete identity
        </button>
      ) : null}
      {isSelf ? (
        <span className="text-[10px] text-slate-500">Your account: suspend, archive and delete are disabled</span>
      ) : null}
      {role === 'platform_admin' ? (
        <span className="text-[10px] text-slate-600">Platform admin — impersonation disabled</span>
      ) : null}
      {message ? <p className="max-w-[240px] text-right text-[10px] text-green-400" role="status">{message}</p> : null}
      {error ? <p className="max-w-[240px] text-right text-[10px] text-red-400" role="alert">{error}</p> : null}
    </div>
  )
}
