/**
 * Clinical diagnosis → DHIS2 aggregate fact rollup (privacy-safe).
 * Reads verified stem codes only — never patient/encounter identifiers in output.
 */

import { isIcd11Code as isKnownIcd11Stem } from "../terminology/icd11-index"
import type { AggregateCaseFact } from "./privacy-export"

export type DiagnosisRollupRow = {
  stem_code: string
  /** Ignored for export — used only upstream for filtering */
  encounter_id?: string
}

/** Monthly HMIS period from an ISO timestamp (UTC). */
export function monthPeriodFromIso(iso: string): string {
  const d = new Date(iso)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, "0")
  return `${y}${m}`
}

export function monthPeriodBounds(period: string): { start: string; end: string } {
  const y = Number(period.slice(0, 4))
  const m = Number(period.slice(4, 6)) - 1
  const start = new Date(Date.UTC(y, m, 1))
  const end = new Date(Date.UTC(y, m + 1, 1))
  return { start: start.toISOString(), end: end.toISOString() }
}

/** Default local org key when DHIS2 mapping not yet seeded. */
export function defaultLocalOrgKey(tenantId: string, hospitalId?: string | null): string {
  return hospitalId ?? tenantId
}

/**
 * Count verified ICD-11 stems for a facility period.
 * Unknown stems are dropped — terminology service is the only coder.
 */
export function rollupDiagnosesToFacts(
  rows: DiagnosisRollupRow[],
  params: { localOrgKey: string; period: string },
): AggregateCaseFact[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const stem = String(row.stem_code ?? "").trim()
    if (!stem || !isKnownIcd11Stem(stem)) continue
    counts.set(stem, (counts.get(stem) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([icd11StemCode, count]) => ({
      localOrgKey: params.localOrgKey,
      period: params.period,
      icd11StemCode,
      count,
    }))
}
