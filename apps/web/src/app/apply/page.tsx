'use client'
import { useState } from 'react'
import Link from 'next/link'
import { SynapseLogo } from '../../components/SynapseLogo'

const DEPARTMENTS = [
  'OPD / Outpatient',
  'Emergency A&E',
  'Maternity',
  'Paediatrics',
  'HIV / ART',
  'ICU',
  'Surgery / Theatre',
  'Cardiology',
  'Oncology',
  'Mental Health',
  'Renal / Dialysis',
  'Laboratory',
  'Pharmacy',
  'Radiology',
  'Finance',
  'Community Health',
  'Telemedicine',
]

const SYSTEMS = [
  'Paper records only',
  'Spreadsheets / Excel',
  'Another HMIS (OpenMRS, Slade360, etc.)',
  'Custom / in-house system',
  'No system at all',
]

export default function ApplyPage() {
  const [step, setStep]           = useState<1 | 2 | 3>(1)
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState('')
  const [departments, setDepts]   = useState<string[]>([])

  const [form, setForm] = useState({
    name: '', email: '', phone: '',
    hospital_name: '', location: '', bed_count: '',
    current_system: '', message: '',
  })

  function set(k: keyof typeof form, v: string) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  function toggleDept(d: string) {
    setDepts(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/applications/pilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, departments }),
      })
      const payload = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(payload.error || 'Submission failed')
      window.location.href = '/apply/thank-you'
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again or visit our contact page.')
    } finally {
      setLoading(false)
    }
  }

  const inputCls = `w-full px-4 py-3 rounded-xl text-sm transition-all outline-none`
  const inputStyle = {
    background: 'var(--bg-elevated)',
    border: '1px solid var(--border-edge)',
    color: 'var(--text-primary)',
  }

  return (
    <main
      className="min-h-screen px-4 py-16"
      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      {/* Nav */}
      <div className="max-w-xl mx-auto mb-10">
        <Link href="/">
          <SynapseLogo size="md" />
        </Link>
      </div>

      <div className="max-w-xl mx-auto">
        {/* Progress */}
        <div className="flex items-center gap-3 mb-10">
          {([1, 2, 3] as const).map(s => (
            <div key={s} className="flex items-center gap-3 flex-1">
              <div
                className="flex items-center justify-center rounded-full font-bold text-xs shrink-0"
                style={{
                  width: '2rem', height: '2rem',
                  background: step >= s ? 'var(--brand-orange)' : 'var(--bg-elevated)',
                  color: step >= s ? '#07070A' : 'var(--text-muted)',
                  border: step >= s ? 'none' : '1px solid var(--border-edge)',
                }}
              >
                {s}
              </div>
              {s < 3 && (
                <div style={{
                  flex: 1, height: '2px',
                  background: step > s ? 'var(--brand-orange)' : 'var(--bg-elevated)',
                  borderRadius: '1px',
                }} />
              )}
            </div>
          ))}
        </div>

        <form onSubmit={handleSubmit}>
          {/* Step 1 — Contact details */}
          {step === 1 && (
            <div style={{ animation: 'fadeIn 0.3s ease forwards' }}>
              <h1 className="font-display font-bold text-2xl mb-2">Apply for Pilot Access</h1>
              <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
                Tell us about yourself and your hospital. We review every application personally.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Your Full Name *
                  </label>
                  <input
                    required
                    value={form.name}
                    onChange={e => set('name', e.target.value)}
                    placeholder="Dr. Jane Nakato"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Work Email *
                  </label>
                  <input
                    required
                    type="email"
                    value={form.email}
                    onChange={e => set('email', e.target.value)}
                    placeholder="you@hospital.ug"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Phone Number
                  </label>
                  <input
                    value={form.phone}
                    onChange={e => set('phone', e.target.value)}
                    placeholder="+256 7XX XXX XXX"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>
              </div>

              <button
                type="button"
                onClick={() => setStep(2)}
                disabled={!form.name || !form.email}
                className="w-full mt-8 py-3.5 rounded-xl font-bold text-sm transition-all"
                style={{
                  background: form.name && form.email ? 'var(--brand-orange)' : 'var(--bg-elevated)',
                  color: form.name && form.email ? '#07070A' : 'var(--text-muted)',
                }}
              >
                Continue
              </button>
            </div>
          )}

          {/* Step 2 — Hospital details */}
          {step === 2 && (
            <div style={{ animation: 'fadeIn 0.3s ease forwards' }}>
              <h2 className="font-display font-bold text-2xl mb-2">About Your Hospital</h2>
              <p className="text-sm mb-8" style={{ color: 'var(--text-secondary)' }}>
                Help us understand your facility so we can tailor the pilot.
              </p>

              <div className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Hospital / Clinic Name *
                  </label>
                  <input
                    required
                    value={form.hospital_name}
                    onChange={e => set('hospital_name', e.target.value)}
                    placeholder="Mulago National Referral Hospital"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Location (District / City)
                  </label>
                  <input
                    value={form.location}
                    onChange={e => set('location', e.target.value)}
                    placeholder="Kampala, Uganda"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Number of Beds (approx.)
                  </label>
                  <input
                    type="number"
                    value={form.bed_count}
                    onChange={e => set('bed_count', e.target.value)}
                    placeholder="200"
                    className={inputCls}
                    style={inputStyle}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                    Current Records System
                  </label>
                  <select
                    value={form.current_system}
                    onChange={e => set('current_system', e.target.value)}
                    title="Current records system"
                    className={inputCls}
                    style={{ ...inputStyle, appearance: 'none' }}
                  >
                    <option value="">Select one</option>
                    {SYSTEMS.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              <div className="flex gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setStep(1)}
                  className="flex-1 py-3.5 rounded-xl font-semibold text-sm transition-all"
                  style={{
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-edge)',
                  }}
                >
                  Back
                </button>
                <button
                  type="button"
                  onClick={() => setStep(3)}
                  disabled={!form.hospital_name}
                  className="flex-[2] py-3.5 rounded-xl font-bold text-sm transition-all"
                  style={{
                    background: form.hospital_name ? 'var(--brand-orange)' : 'var(--bg-elevated)',
                    color: form.hospital_name ? '#07070A' : 'var(--text-muted)',
                  }}
                >
                  Continue
                </button>
              </div>
            </div>
          )}

          {/* Step 3 — Departments + submit */}
          {step === 3 && (
            <div style={{ animation: 'fadeIn 0.3s ease forwards' }}>
              <h2 className="font-display font-bold text-2xl mb-2">Departments of Interest</h2>
              <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
                Select the departments you want to pilot first. You can always add more later.
              </p>

              <div className="flex flex-wrap gap-2 mb-6">
                {DEPARTMENTS.map(d => {
                  const on = departments.includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      onClick={() => toggleDept(d)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                      style={{
                        background: on ? 'rgba(249,115,22,0.15)' : 'var(--bg-elevated)',
                        color: on ? 'var(--brand-orange)' : 'var(--text-secondary)',
                        border: `1px solid ${on ? 'var(--border-orange)' : 'var(--border-edge)'}`,
                      }}
                    >
                      {d}
                    </button>
                  )
                })}
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1.5" style={{ color: 'var(--text-muted)' }}>
                  Anything else you want us to know?
                </label>
                <textarea
                  rows={3}
                  value={form.message}
                  onChange={e => set('message', e.target.value)}
                  placeholder="Any specific challenges, requirements, or questions..."
                  className={`${inputCls} resize-none`}
                  style={inputStyle}
                />
              </div>

              {error && (
                <p className="text-xs mt-3" style={{ color: '#EF4444' }}>{error}</p>
              )}

              <div className="flex gap-3 mt-8">
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="flex-1 py-3.5 rounded-xl font-semibold text-sm transition-all"
                  style={{
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--border-edge)',
                  }}
                >
                  Back
                </button>
                <button
                  type="submit"
                  disabled={loading}
                  className="flex-[2] py-3.5 rounded-xl font-bold text-sm transition-all"
                  style={{
                    background: 'var(--brand-orange)',
                    color: '#07070A',
                    opacity: loading ? 0.7 : 1,
                  }}
                >
                  {loading ? 'Submitting...' : 'Submit Application'}
                </button>
              </div>

              <p className="text-xs text-center mt-4" style={{ color: 'var(--text-muted)' }}>
                We review every application and respond within 24 hours.
                Free 7-day trial &mdash; no credit card required.
              </p>
            </div>
          )}
        </form>
      </div>
    </main>
  )
}
