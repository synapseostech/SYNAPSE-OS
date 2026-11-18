/**
 * Pure helpers behind the Tally import screens. They mirror the pharmacy web
 * workspace (apps/pharmacy/lib/tally/file-names.ts, upload-retry.ts,
 * replay-gate.ts and components/tally/tally-playback.tsx) so a phone stages,
 * reviews and walks a cut-over by the same rules the server holds.
 */

/** A date range an export's own file name states. */
export type TallyPeriod = { from: string; to: string }

/** The server's floor and ceiling on a written replay reason (replay-gate.ts). */
export const REPLAY_REASON_MIN = 8
export const REPLAY_REASON_MAX = 500

/** Upper bound the server enforces per file (TALLY_SOURCE_LIMIT). */
export const TALLY_SOURCE_LIMIT_BYTES = 50 * 1024 * 1024

const CONTENT_TYPES: Record<string, string> = {
  xml: 'application/xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // Storage refuses the legacy Excel type, so the portal sends it as bytes.
  xls: 'application/octet-stream',
  csv: 'text/csv',
  zip: 'application/zip',
}

export function extensionOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? ''
}

/** The content type to upload a file with, or null when Tally import refuses it. */
export function tallyContentType(name: string): string | null {
  return CONTENT_TYPES[extensionOf(name)] ?? null
}

export function isIsoDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * The range an export names in its own file name, as the Synapse export
 * script writes it (`3-daybook-20250101-20251231.xml`), or Tally's own month
 * export (`2025-10-full.xml`, the whole calendar month).
 */
export function periodFromFileName(name: string): TallyPeriod | undefined {
  const match = /(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})\.xml$/i.exec(name)
  if (match) {
    const from = `${match[1]}-${match[2]}-${match[3]}`
    const to = `${match[4]}-${match[5]}-${match[6]}`
    if (!isIsoDay(from) || !isIsoDay(to) || to < from) return undefined
    return { from, to }
  }
  const month = /(?:^|\D)(\d{4})-(\d{2})(?:-(?:full|month))?\.xml$/i.exec(name)
  if (!month) return undefined
  const year = Number(month[1])
  const monthNumber = Number(month[2])
  const from = `${month[1]}-${month[2]}-01`
  if (monthNumber < 1 || monthNumber > 12 || !isIsoDay(from)) return undefined
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return { from, to: `${month[1]}-${month[2]}-${String(lastDay).padStart(2, '0')}` }
}

/** The part of the cut-over a file holds, when its name says so; else the server decides. */
export function kindFromFileName(name: string): 'masters' | 'vouchers' | undefined {
  const lower = name.toLowerCase()
  if (lower.includes('masters')) return 'masters'
  if (lower.includes('daybook') || lower.includes('day-book')) return 'vouchers'
  return undefined
}

/** A chosen file the session already holds: the same name and the same size. */
export function alreadyStaged(
  file: { name: string; size?: number },
  staged: ReadonlyArray<{ fileName: string; bytes: number }>,
): boolean {
  if (file.size === undefined) return false
  return staged.some((entry) => entry.fileName === file.name && entry.bytes === file.size)
}

/**
 * A package names the company and counts its own vouchers, so it goes first;
 * the loose files beside it then join the cut-over it names.
 */
export function orderForStaging<T extends { name: string }>(files: readonly T[]): T[] {
  const isPackage = (entry: T) => extensionOf(entry.name) === 'zip'
  return [...files].sort((a, b) => Number(isPackage(b)) - Number(isPackage(a)))
}

/** One file goes straight to preview; anything more is staged and read together. */
export function needsStaging(chosen: number, alreadyStagedCount: number): boolean {
  return chosen > 1 || alreadyStagedCount > 0
}

export function replayReasonAnswered(reason: string | undefined): boolean {
  const trimmed = (reason ?? '').trim()
  return trimmed.length >= REPLAY_REASON_MIN && trimmed.length <= REPLAY_REASON_MAX
}

/** What Apply submits for a replay: the confirmed order and every usable reason. */
export function replayAcknowledgement(
  sequenceConfirmed: boolean,
  reasons: Record<string, string>,
): { sequenceConfirmed: boolean; items: Array<{ key: string; reason: string }> } {
  return {
    sequenceConfirmed,
    items: Object.entries(reasons)
      .map(([key, reason]) => ({ key, reason: reason.trim() }))
      .filter((item) => replayReasonAnswered(item.reason)),
  }
}

/** Blockers still without a usable written reason. */
export function unansweredBlockers(
  blockers: ReadonlyArray<{ key: string }>,
  reasons: Record<string, string>,
): number {
  return blockers.filter((blocker) => !replayReasonAnswered(reasons[blocker.key])).length
}

/** Network failures are retried; a server's answer, even a refusal, never is. */
export function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    /network error|timed out|network request failed/i.test(error.message) &&
    !('status' in error)
  )
}

export const NETWORK_RETRY_DELAYS_MS = [1_000, 3_000, 8_000]

export async function withNetworkRetry<T>(
  run: () => Promise<T>,
  delays: readonly number[] = NETWORK_RETRY_DELAYS_MS,
  wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (error) {
      if (!isNetworkFailure(error) || attempt >= delays.length) throw error
      await wait(delays[attempt] as number)
    }
  }
}

// ── Playback ────────────────────────────────────────────────────────────────

export type TallyPlaybackDay = {
  date: string
  events: number
  movements: number
  firstChunk: number
}

export type TallyPlaybackIndex = {
  mode: 'opening' | 'closing' | 'replay'
  firstDate: string
  lastDate: string
  eventCount: number
  movementCount: number
  chunkCount: number
  chunkSize: number
  days: TallyPlaybackDay[]
}

export type TallyPlaybackStockLine = {
  item: string
  quantity: number
  direction: 'in' | 'out' | 'count'
}

export type TallyPlaybackEvent = {
  id: string
  date: string
  type: 'opening' | 'voucher' | 'movement'
  kind: string
  number?: string
  description: string
  debit: number
  credit: number
  lineCount: number
  stock: TallyPlaybackStockLine[]
  movements: number
}

/** A day's events are contiguous: from its first chunk to the chunk the next day starts in. */
export function chunksForDay(index: TallyPlaybackIndex, position: number): number[] {
  const entry = index.days[position]
  if (!entry) return []
  const next = index.days[position + 1]
  const last = next ? next.firstChunk : index.chunkCount - 1
  const chunks: number[] = []
  for (let chunk = entry.firstChunk; chunk <= last; chunk += 1) chunks.push(chunk)
  return chunks
}

export function eventsForDay(
  index: TallyPlaybackIndex,
  position: number,
  cache: ReadonlyMap<number, TallyPlaybackEvent[]>,
): TallyPlaybackEvent[] {
  const day = index.days[position]
  if (!day) return []
  const found: TallyPlaybackEvent[] = []
  for (const chunk of chunksForDay(index, position)) {
    for (const event of cache.get(chunk) ?? []) {
      if (event.date === day.date) found.push(event)
    }
  }
  return found
}

/** How far through the history a day sits, counting entries up to and including it. */
export function progressThrough(index: TallyPlaybackIndex, position: number): {
  entries: number
  ratio: number
} {
  let entries = 0
  for (let i = 0; i <= position && i < index.days.length; i += 1) {
    entries += index.days[i]?.events ?? 0
  }
  return { entries, ratio: index.eventCount > 0 ? Math.min(1, entries / index.eventCount) : 0 }
}

export function stockLineLabel(line: TallyPlaybackStockLine): string {
  const verb = line.direction === 'out' ? 'out' : line.direction === 'in' ? 'in' : 'counted'
  return `${line.item} × ${line.quantity} ${verb}`
}

// ── Apply readiness ─────────────────────────────────────────────────────────

/**
 * Whether the screen may offer Apply, given the server's preflight. The
 * preflight is read before the operator answers anything, and the server takes
 * the sequence confirmation and the written reasons only from what Apply
 * submits, so `replay-sequence` and `replay-parity` are judged from this
 * screen's state. Every other failing blocking check still holds Apply.
 * Mirrors apps/pharmacy/lib/tally/apply-readiness.ts.
 */
export function preflightAllowsApply(
  preflight:
    | { canApply: boolean; checks: Array<{ id: string; status: string; blocksApply: boolean }> }
    | null
    | undefined,
  replay: { sequenceConfirmed: boolean; everyDifferenceAnswered: boolean; nothingUnknown: boolean } | null,
): boolean {
  if (!preflight || preflight.canApply) return true
  const failing = preflight.checks.filter((check) => check.blocksApply && check.status !== 'pass')
  if (failing.length === 0) return true
  return failing.every((check) => {
    if (!replay) return false
    if (check.id === 'replay-sequence') return replay.sequenceConfirmed
    if (check.id === 'replay-parity') return replay.everyDifferenceAnswered && replay.nothingUnknown
    return false
  })
}
