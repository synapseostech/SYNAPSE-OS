'use client'
export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { Activity, Smartphone, Wifi, WifiOff } from 'lucide-react'
import { createClient } from '../../../lib/supabase/client'
import { WearableSummary } from './WearableSummary'

interface Reading {
  id: string
  reading_type: string
  value: number | null
  unit: string | null
  read_at: string
  is_critical: boolean | null
}

const READING_ICONS: Record<string, string> = {
  heart_rate: '❤️', spo2: '🫁', temperature: '🌡️',
  weight: '⚖️', blood_glucose: '🩸', blood_pressure: '💓',
}

export default function HealthDevicesPage() {
  const [readings, setReadings] = useState<Reading[]>([])
  const [loading, setLoading] = useState(true)
  const [activeType, setActiveType] = useState('all')

  useEffect(() => {
    async function load() {
      const supabase = createClient()
      const meRes = await fetch('/api/auth/me')
      const { user } = meRes.ok ? await meRes.json() : { user: null }
      if (!user) { setLoading(false); return }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase as any)
        .from('device_readings')
        .select('id, reading_type, value, unit, read_at, is_critical')
        .eq('patient_id', user.id)
        .order('read_at', { ascending: false })
        .limit(200) as { data: Reading[] | null }

      setReadings(data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  const types = ['all', ...Array.from(new Set(readings.map(r => r.reading_type)))]
  const shown = activeType === 'all' ? readings : readings.filter(r => r.reading_type === activeType)

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Connected Devices</h1>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-secondary)' }}>Readings from wearables and medical devices</p>
        </div>
        <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
          <WifiOff className="h-3.5 w-3.5" />
          <span>Connect in Synapse App</span>
        </div>
      </div>

      {/* Connect device prompt */}
      <div
        className="rounded-2xl p-5 flex items-center gap-4"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)' }}
      >
        <div
          className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
          style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)' }}
        >
          <Smartphone className="h-6 w-6" />
        </div>
        <div>
          <p className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>Connect a Device</p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
            Open My Health in the Synapse app and connect Health Connect. It brings in Samsung,
            Fitbit, Xiaomi and most other Android watches and bands.
          </p>
        </div>
        <span
          className="ml-auto flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold shrink-0"
          style={{ background: 'rgba(249,115,22,0.1)', color: 'var(--brand-orange)', border: '1px solid var(--border-orange)' }}
        >
          <Wifi className="h-3.5 w-3.5" /> In the app
        </span>
      </div>

      <WearableSummary />

      {readings.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {types.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setActiveType(t)}
              className="rounded-full px-3 py-1.5 text-xs font-semibold capitalize whitespace-nowrap transition-all shrink-0"
              style={{
                background: activeType === t ? 'var(--brand-orange)' : 'var(--bg-elevated)',
                color: activeType === t ? '#07070A' : 'var(--text-secondary)',
                border: `1px solid ${activeType === t ? 'var(--brand-orange)' : 'var(--border-edge)'}`,
              }}
            >
              {READING_ICONS[t] ?? ''} {t.replace('_', ' ')}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center" style={{ color: 'var(--text-muted)' }}>Loading readings…</div>
      ) : shown.length === 0 ? (
        <div className="py-12 text-center">
          <Activity className="h-10 w-10 mx-auto mb-3" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No device readings yet. Connect a device to start tracking.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {shown.map(r => (
            <div
              key={r.id}
              className="flex items-center gap-4 rounded-xl px-4 py-3"
              style={{
                background: r.is_critical ? 'rgba(239,68,68,0.05)' : 'var(--bg-surface)',
                border: `1px solid ${r.is_critical ? 'rgba(239,68,68,0.3)' : 'var(--border-edge)'}`,
              }}
            >
              <span className="text-xl shrink-0">{READING_ICONS[r.reading_type] ?? '📊'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium capitalize" style={{ color: 'var(--text-primary)' }}>
                  {r.reading_type.replace(/_/g, ' ')}
                </p>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {new Date(r.read_at).toLocaleString('en-UG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
              <div className="text-right shrink-0">
                <p className="font-bold text-lg" style={{ color: r.is_critical ? '#EF4444' : 'var(--text-primary)' }}>
                  {r.value}
                  <span className="text-xs font-normal ml-1" style={{ color: 'var(--text-muted)' }}>{r.unit}</span>
                </p>
                {r.is_critical && <p className="text-xs" style={{ color: '#EF4444' }}>⚠ Critical</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
