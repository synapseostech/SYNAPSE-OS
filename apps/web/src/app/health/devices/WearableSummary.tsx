'use client'

import { useEffect, useState } from 'react'
import { Footprints, HeartPulse, Moon, Trash2 } from 'lucide-react'

type Daily = { metric: string; day: string; value: number; provider: string; unit: string }
type Connection = { provider: string; scopes: string[]; lastSyncedAt: string | null }

const METRICS = [
  { metric: 'steps', label: 'Steps', unit: '', icon: Footprints },
  { metric: 'heart_rate', label: 'Avg heart rate', unit: 'bpm', icon: HeartPulse },
  { metric: 'sleep_minutes', label: 'Sleep', unit: 'h', icon: Moon },
] as const

const PROVIDER_LABEL: Record<string, string> = {
  health_connect: 'Health Connect',
  healthkit: 'Apple Health',
}

function lastDays(n: number): string[] {
  const out: string[] = []
  for (let i = n - 1; i >= 0; i--) {
    out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10))
  }
  return out
}

function show(metric: string, value: number): string {
  if (metric === 'sleep_minutes') return (value / 60).toFixed(1)
  return Math.round(value).toLocaleString()
}

/** The signed-in person's own wearable summaries, read through /api/health/wearables. */
export function WearableSummary() {
  const [daily, setDaily] = useState<Daily[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  const load = async () => {
    const res = await fetch('/api/health/wearables?days=14', { cache: 'no-store' }).catch(() => null)
    if (!res?.ok) {
      setState('error')
      return
    }
    const body = (await res.json()) as { daily: Daily[]; connections: Connection[] }
    setDaily(body.daily ?? [])
    setConnections(body.connections ?? [])
    setState('ready')
  }

  useEffect(() => {
    void load()
  }, [])

  const remove = async (provider: string) => {
    if (!window.confirm(`Disconnect ${PROVIDER_LABEL[provider] ?? provider} and delete its readings from Synapse?`)) return
    await fetch(`/api/health/wearables?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' })
    await load()
  }

  if (state !== 'ready' || connections.length === 0) return null

  const days = lastDays(7)
  return (
    <section
      className="rounded-2xl p-5 space-y-4"
      style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-edge)' }}
      aria-label="Wearable trends"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Wearables, last 7 days</h2>
        {connections.map((c) => (
          <span key={c.provider} className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
            {PROVIDER_LABEL[c.provider] ?? c.provider}
            {c.lastSyncedAt ? ` · synced ${new Date(c.lastSyncedAt).toLocaleDateString()}` : ''}
            <button type="button" onClick={() => void remove(c.provider)} aria-label={`Disconnect ${PROVIDER_LABEL[c.provider] ?? c.provider}`} className="ml-1">
              <Trash2 className="h-3 w-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {METRICS.map(({ metric, label, unit, icon: Icon }) => {
          const series = days.map((day) => daily.find((d) => d.metric === metric && d.day === day)?.value ?? 0)
          const peak = Math.max(1, ...series)
          const withData = series.filter((v) => v > 0)
          const avg = withData.length ? withData.reduce((a, b) => a + b, 0) / withData.length : 0
          return (
            <div key={metric} className="rounded-xl p-3" style={{ background: 'var(--bg-elevated)' }}>
              <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                <Icon className="h-3.5 w-3.5" /> {label}
              </div>
              <p className="mt-1 text-lg font-bold" style={{ color: 'var(--text-primary)' }}>
                {withData.length ? show(metric, avg) : '—'}
                <span className="ml-1 text-xs font-normal" style={{ color: 'var(--text-muted)' }}>{withData.length ? `${unit} avg` : ''}</span>
              </p>
              <div className="mt-2 flex h-10 items-end gap-1" aria-hidden>
                {series.map((v, i) => (
                  <div key={days[i]} className="flex-1 rounded-sm" style={{ height: `${Math.max(4, (v / peak) * 100)}%`, background: v ? 'var(--brand-orange)' : 'var(--border-edge)' }} />
                ))}
              </div>
            </div>
          )
        })}
      </div>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
        Only you can see these readings. Your employer or facility cannot, even if you work there.
      </p>
    </section>
  )
}
