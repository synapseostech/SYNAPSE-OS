'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, Eye, EyeOff, MailCheck } from 'lucide-react'
import { SynapseLogo } from '../../../components/SynapseLogo'

export default function PatientSignupPage() {
  const [showPw, setShowPw] = useState(false)
  const [loading, setLoading] = useState(false)
  const [resending, setResending] = useState(false)
  const [error, setError] = useState('')
  const [submittedEmail, setSubmittedEmail] = useState('')
  const [activationNotice, setActivationNotice] = useState('')
  const [resendFailed, setResendFailed] = useState(false)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    dob: '',
    gender: '',
    password: '',
  })

  function set(k: keyof typeof form, v: string) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (form.password.length < 8) {
      setError('Password must be at least 8 characters.')
      return
    }
    setLoading(true)
    setError('')

    const res = await fetch('/api/auth/signup/patient', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form),
    })
    const data = await res.json().catch(() => ({})) as { error?: string }
    if (!res.ok) {
      setError(data.error ?? 'Could not create account.')
      setLoading(false)
      return
    }

    // The API answers new and existing emails identically (anti-enumeration).
    setActivationNotice('')
    setSubmittedEmail(form.email)
    setLoading(false)
  }

  async function resendActivation() {
    if (!submittedEmail) return
    setResending(true)
    setActivationNotice('')
    const res = await fetch('/api/auth/activation/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: submittedEmail }),
    })
    const data = await res.json().catch(() => ({})) as { error?: string }
    setResending(false)
    if (!res.ok) {
      setResendFailed(true)
      setActivationNotice(data.error ?? 'Could not resend activation email.')
      return
    }
    setResendFailed(false)
    setActivationNotice('If this account is still pending activation, a new link is on its way. Check your inbox and spam folder.')
  }

  const inputCls = 'w-full rounded-xl px-4 py-3 text-sm outline-none transition-all'
  const inputStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-edge)',
    color: 'var(--text-primary)',
  }

  if (submittedEmail) {
    return (
      <main
        className="min-h-screen flex flex-col items-center justify-center px-4 py-12"
        style={{ background: 'var(--bg-base)' }}
      >
        <div className="w-full max-w-md text-center">
          <div className="mb-8 flex justify-center">
            <SynapseLogo size="md" />
          </div>
          <div
            className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full"
            style={{ background: 'rgba(249,115,22,0.12)', color: 'var(--brand-orange)' }}
          >
            <MailCheck className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
            Check your email
          </h1>
          <p className="text-sm leading-6 mb-6" style={{ color: 'var(--text-secondary)' }}>
            If <strong style={{ color: 'var(--text-primary)' }}>{submittedEmail}</strong> can be used for a new account,
            we&apos;ve sent it an activation link. The account stays locked until you open that link.
            Already have an account? Sign in or reset your password instead.
          </p>
          <button
            type="button"
            onClick={resendActivation}
            disabled={resending}
            className="mb-3 block w-full py-2 text-sm font-semibold disabled:opacity-50"
            style={{ color: 'var(--brand-orange)' }}
          >
            {resending ? 'Sending...' : "Didn't get it? Resend activation email"}
          </button>
          {activationNotice && (
            <p className="mb-4 text-sm" style={{ color: resendFailed ? '#EF4444' : '#22C55E' }}>
              {activationNotice}
            </p>
          )}
          <Link href="/login" className="btn-primary block w-full">
            Back to sign in
          </Link>
        </div>
      </main>
    )
  }

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-4 py-12"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="w-full max-w-md">
        <div className="flex items-center justify-between mb-8">
          <Link href="/signup" className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <SynapseLogo size="sm" />
        </div>

        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Create patient account</h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
          Your personal health record starts here.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>First Name</label>
              <input
                required
                autoComplete="given-name"
                value={form.first_name}
                onChange={e => set('first_name', e.target.value)}
                placeholder="Jane"
                className={inputCls}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Last Name</label>
              <input
                required
                autoComplete="family-name"
                value={form.last_name}
                onChange={e => set('last_name', e.target.value)}
                placeholder="Nakato"
                className={inputCls}
                style={inputStyle}
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Email Address</label>
            <input
              required
              type="email"
              autoComplete="email"
              value={form.email}
              onChange={e => set('email', e.target.value)}
              placeholder="jane@example.com"
              className={inputCls}
              style={inputStyle}
            />
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Phone Number</label>
            <input
              type="tel"
              autoComplete="tel"
              value={form.phone}
              onChange={e => set('phone', e.target.value)}
              placeholder="+256 7XX XXX XXX"
              className={inputCls}
              style={inputStyle}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Date of Birth</label>
              <input
                type="date"
                autoComplete="bday"
                value={form.dob}
                onChange={e => set('dob', e.target.value)}
                className={inputCls}
                style={inputStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Sex at birth (optional)</label>
              <select
                value={form.gender}
                onChange={e => set('gender', e.target.value)}
                className={inputCls}
                style={{ ...inputStyle, WebkitAppearance: 'none', appearance: 'none' }}
              >
                <option value="">Select</option>
                <option value="female">Female</option>
                <option value="male">Male</option>
                <option value="intersex">Intersex</option>
                <option value="undisclosed">Prefer not to say</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Password</label>
            <div className="relative">
              <input
                required
                type={showPw ? 'text' : 'password'}
                autoComplete="new-password"
                value={form.password}
                onChange={e => set('password', e.target.value)}
                placeholder="Minimum 8 characters"
                className={`${inputCls} pr-10`}
                style={inputStyle}
              />
              <button
                type="button"
                onClick={() => setShowPw(p => !p)}
                className="absolute right-3 top-1/2 -translate-y-1/2"
                style={{ color: 'var(--text-muted)' }}
              >
                {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>}

          <button
            type="submit"
            disabled={loading || !form.first_name || !form.email || !form.password}
            className="btn-primary w-full mt-2 disabled:opacity-50"
          >
            {loading ? 'Creating account…' : 'Create Account'}
          </button>
        </form>

        <p className="text-xs text-center mt-6" style={{ color: 'var(--text-muted)' }}>
          By signing up, you agree to our{' '}
          <Link href="/legal/terms" style={{ color: 'var(--brand-orange)' }}>Terms</Link>{' '}
          and{' '}
          <Link href="/legal/privacy" style={{ color: 'var(--brand-orange)' }}>Privacy Policy</Link>.
        </p>

        <p className="text-center text-sm mt-4" style={{ color: 'var(--text-muted)' }}>
          Already have an account?{' '}
          <Link href="/login" style={{ color: 'var(--brand-orange)' }}>Sign in</Link>
        </p>
      </div>
    </main>
  )
}
