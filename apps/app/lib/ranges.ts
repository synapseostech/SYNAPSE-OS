export type RangeKey = 'month' | 'quarter' | 'year'

export const RANGE_OPTIONS = [
  { value: 'month', label: 'This month' },
  { value: 'quarter', label: 'This quarter' },
  { value: 'year', label: 'This year' },
] as const satisfies ReadonlyArray<{ value: RangeKey; label: string }>

export function isoLocal(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

export function rangeQuery(key: RangeKey): { from: string; to: string } {
  const today = new Date()
  const start = new Date(today.getFullYear(), 0, 1)
  if (key === 'month') {
    start.setMonth(today.getMonth(), 1)
  } else if (key === 'quarter') {
    start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1)
  }
  return { from: isoLocal(start), to: isoLocal(today) }
}
