'use client'

import type { TrendSeries } from '@synapse/db/patient-continuity'
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react'

const W = 132
const H = 36

/** Small trend line with the normal range shaded. Values outside it are drawn as warning dots. */
export function Sparkline({ series }: { series: TrendSeries }) {
  const pts = series.points
  const values = pts.map((p) => p.value)
  const lo = Math.min(...values, series.normal?.[0] ?? Infinity)
  const hi = Math.max(...values, series.normal?.[1] ?? -Infinity)
  const pad = (hi - lo) * 0.12 || 1
  const min = lo - pad
  const max = hi + pad
  const x = (i: number) => (pts.length === 1 ? W / 2 : 4 + (i * (W - 8)) / (pts.length - 1))
  const y = (v: number) => H - 3 - ((v - min) / (max - min)) * (H - 6)
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const out = (v: number) => (series.normal ? v < series.normal[0] || v > series.normal[1] : false)
  const Arrow = series.direction === 'rising' ? ArrowUpRight : series.direction === 'falling' ? ArrowDownRight : ArrowRight
  const latestOut = series.latest != null && out(series.latest)

  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-muted-color">{series.label}</div>
        <div className="flex items-baseline gap-1">
          <span className={`font-mono text-lg font-semibold ${latestOut ? 'text-orange' : 'text-primary-color'}`}>
            {series.latest ?? '–'}
          </span>
          <span className="text-xs text-muted-color">{series.unit}</span>
          {series.direction !== 'single' && <Arrow className="h-3.5 w-3.5 text-secondary-color" aria-label={series.direction} />}
        </div>
      </div>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${series.label} trend, ${pts.length} readings`}>
        {series.normal && (
          <rect
            x={0}
            width={W}
            y={y(series.normal[1])}
            height={Math.max(1, y(series.normal[0]) - y(series.normal[1]))}
            fill="var(--acuity-green)"
            opacity={0.1}
          />
        )}
        <path d={path} fill="none" stroke="var(--brand-teal)" strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => (
          <circle key={p.at + i} cx={x(i)} cy={y(p.value)} r={out(p.value) ? 2.8 : 2} fill={out(p.value) ? 'var(--acuity-orange)' : 'var(--brand-teal)'}>
            <title>{`${new Date(p.at).toLocaleDateString()}: ${p.value} ${series.unit}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}
