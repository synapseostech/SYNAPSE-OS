'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ArrowLeft, CheckCircle } from 'lucide-react'
import { SynapseLogo } from '../../../components/SynapseLogo'

const SYSTEMS = [
  'Paper records only', 'Spreadsheets / Excel', 'OpenMRS', 'Slade360',
  'Another HMIS', 'Custom / in-house system', 'No system at all',
]

export default function HospitalInterestPage() {
  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    hospital_name: '', contact_name: '', contact_email: '',
    contact_phone: '', location: '', beds_count: '',
    current_system: '', notes: '',
  })

  function set(k: keyof typeof form, v: string) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/applications/hospital-interest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hospital_name: form.hospital_name,
          contact_name: form.contact_name,
          contact_email: form.contact_email,
          contact_phone: form.contact_phone,
          location: form.location,
          beds_count: form.beds_count,
          current_system: form.current_system,
          notes: form.notes,
        }),
      })
      if (!res.ok) throw new Error('Submission failed')
      setSubmitted(true)
    } catch {
      setError('Something went wrong. Please try again or visit our contact page.')
    } finally {
      setLoading(false)
    }
  }

  const inp = 'w-full rounded-xl px-4 py-3 text-sm outline-none transition-all'
  const inpStyle = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-edge)',
    color: 'var(--text-primary)',
  }

  if (submitted) {
    return (
      <main
        className="min-h-screen flex flex-col items-center justify-center px-4 py-12"
        style={{ background: 'var(--bg-base)' }}
      >
        <div className="w-full max-w-md text-center">
          <div className="flex justify-center mb-6">
            <div className="flex h-16 w-16 items-center justify-center rounded-full" style={{ background: 'rgba(34,197,94,0.12)' }}>
              <CheckCircle className="h-8 w-8 text-green-500" />
            </div>
          </div>
          <div className="flex justify-center mb-6"><SynapseLogo size="md" /></div>
          <h1 className="text-2xl font-bold mb-3" style={{ color: 'var(--text-primary)' }}>Thank You!</h1>
          <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
            We&apos;ve received your hospital&apos;s interest. Our team will be in touch within 24–48 hours to schedule a personalised demo and discuss your needs.
          </p>
          <div
            className="rounded-xl p-4 mb-8 text-left space-y-2"
            style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-edge)' }}
          >
            <p className="text-xs font-bold uppercase tracking-wide mb-2" style={{ color: 'var(--text-muted)' }}>NEXT STEPS</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>1. Our sales team reviews your submission</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>2. You receive a personalised demo invitation</p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>3. Free 7-day trial — full platform, no credit card</p>
          </div>
          <Link href="/" className="btn-primary inline-block px-8">Back to Home</Link>
        </div>
      </main>
    )
  }

  return (
    <main
      className="min-h-screen flex flex-col items-center justify-center px-4 py-12"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="w-full max-w-lg">
        <div className="flex items-center justify-between mb-8">
          <Link href="/signup" className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <SynapseLogo size="sm" />
        </div>

        <h1 className="text-2xl font-bold mb-1" style={{ color: 'var(--text-primary)' }}>Register Hospital Interest</h1>
        <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
          Tell us about your facility and we&apos;ll set up a personalised demo.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Hospital / Clinic Name *</label>
            <input
              required
              value={form.hospital_name}
              onChange={e => set('hospital_name', e.target.value)}
              placeholder="Mulago National Referral Hospital"
              className={inp}
              style={inpStyle}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Contact Person *</label>
              <input
                required
                value={form.contact_name}
                onChange={e => set('contact_name', e.target.value)}
                placeholder="Dr. James Kato"
                className={inp}
                style={inpStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Contact Email *</label>
              <input
                required
                type="email"
                value={form.contact_email}
                onChange={e => set('contact_email', e.target.value)}
                placeholder="admin@hospital.ug"
                className={inp}
                style={inpStyle}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Phone</label>
              <input
                value={form.contact_phone}
                onChange={e => set('contact_phone', e.target.value)}
                placeholder="+256 7XX XXX XXX"
                className={inp}
                style={inpStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Location</label>
              <input
                value={form.location}
                onChange={e => set('location', e.target.value)}
                placeholder="Kampala, Uganda"
                className={inp}
                style={inpStyle}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Number of Beds</label>
              <input
                type="number"
                min="1"
                value={form.beds_count}
                onChange={e => set('beds_count', e.target.value)}
                placeholder="200"
                className={inp}
                style={inpStyle}
              />
            </div>
            <div>
              <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Current System</label>
              <select
                value={form.current_system}
                onChange={e => set('current_system', e.target.value)}
                className={inp}
                style={{ ...inpStyle, WebkitAppearance: 'none', appearance: 'none' }}
              >
                <option value="">Select</option>
                {SYSTEMS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>Additional Notes</label>
            <textarea
              rows={3}
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Specific requirements, challenges, or questions…"
              className={`${inp} resize-none`}
              style={inpStyle}
            />
          </div>

          {error && <p className="text-sm" style={{ color: '#EF4444' }}>{error}</p>}

          <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-50">
            {loading ? 'Submitting…' : 'Request a Demo'}
          </button>

          <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            We respond within 24 hours. Free 7-day trial — no credit card required.
          </p>
        </form>
      </div>
    </main>
  )
}
