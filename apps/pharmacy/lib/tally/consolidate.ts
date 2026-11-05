/**
 * Consolidation of the documents parsed from each extraction chunk.
 *
 * A migration is read as one masters chunk and many voucher ranges, so the same
 * master record may arrive in more than one payload and a retried range may
 * arrive twice. This module merges them into one document, dedupes on the
 * identifiers Tally itself assigns, and reports what it had to drop, what it
 * could not classify, and what it still cannot prove.
 *
 * Completeness is never inferred here. The counts below compare the merged
 * document against the sum of its parts, which catches a merge that lost or
 * duplicated records — it says nothing about whether Tally returned everything
 * for a range. Without an independent source count the result stays
 * `unverified`, and no amount of agreement between two halves of the same
 * payload changes that.
 *
 * Pure functions; parsing, storage and the ledger live elsewhere.
 */

import {
  classifyTallyVoucherType,
  tallyVoucherSourceType,
} from "@synapse/db/tally-map"
import type {
  TallyGroup,
  TallyLedger,
  TallyStockGroup,
  TallyStockItem,
  TallyGodown,
  TallyUnit,
  TallyVoucher,
  TallyXmlDocument,
  TallyXmlRowWarning,
} from "@synapse/db/tally-xml-rows"
import {
  parseTallyIsoDate,
  type TallyDateRange,
  type TallyReconciliation,
} from "./chunks"

export const TALLY_CONSOLIDATION_LIMIT = 500_000

export class TallyConsolidationError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = "TallyConsolidationError"
  }
}

export type TallyVoucherTypeSummary = {
  /** The type exactly as Tally stated it. */
  type: string
  count: number
  supported: boolean
  /** Why records of this type cannot be posted, when they cannot. */
  reason?: string
}

export type TallyConsolidationReport = {
  company: string
  parts: number
  masters: {
    groups: number
    ledgers: number
    stockGroups: number
    stockItems: number
    units: number
    godowns: number
    total: number
    duplicates: number
    conflicts: number
  }
  vouchers: {
    /** Records the parser produced across all parts, before deduplication. */
    read: number
    unique: number
    duplicates: number
    cancelled: number
    undated: number
    /** Vouchers with no identifier at all; kept, because they cannot be proven duplicates. */
    keyless: number
    types: TallyVoucherTypeSummary[]
    unsupported: TallyVoucherTypeSummary[]
  }
  dates: {
    first?: string
    last?: string
    /** Stretches of the promised period that no date in the consolidated set covers. */
    gaps: Array<{ from: string; to: string }>
  }
  /** Sum of each type's amounts, for a person to compare against Tally's own report. */
  totals: Array<{ type: string; amount: number }>
  reconciliation: TallyReconciliation
  /** Why the merge itself is in doubt, when it is. */
  problems: string[]
  warnings: TallyXmlRowWarning[]
  truncated?: TallyXmlDocument["truncated"]
}

export type TallyConsolidation = {
  document: TallyXmlDocument
  report: TallyConsolidationReport
}

export type TallyConsolidationInput = {
  /** The period the migration promises to cover. */
  period: TallyDateRange
  /**
   * The company the operator entered, used only when no part names one. A part
   * that names a different company is still a mismatch, not a preference.
   */
  company?: string
  /** Master records count reported by the source, when one exists. */
  expectedMasters?: number
  /** Voucher count reported by the source, when one exists. */
  expectedVouchers?: number
}

function keyOf(record: { guid?: string; name: string }): string {
  const guid = record.guid?.trim()
  if (guid) return `guid:${guid.toLowerCase()}`
  return `name:${record.name.trim().toLowerCase()}`
}

function mergeBy<T extends { guid?: string; name: string }>(
  parts: T[][],
): { records: T[]; duplicates: number; conflicts: number } {
  const byKey = new Map<string, T>()
  let duplicates = 0
  let conflicts = 0
  for (const records of parts) {
    for (const record of records) {
      const key = keyOf(record)
      const existing = byKey.get(key)
      if (!existing) {
        byKey.set(key, record)
        continue
      }
      duplicates += 1
      // The same identifier with different content is not a duplicate to keep
      // quietly: one of the two payloads differs from what the other held.
      if (JSON.stringify(existing) !== JSON.stringify(record)) conflicts += 1
    }
  }
  return { records: [...byKey.values()], duplicates, conflicts }
}

/**
 * The identifier a voucher is deduplicated on. Tally assigns GUIDs; older
 * builds only a remote id, and a hand-written XML export may have neither, so
 * type + number + date is the narrowest stable stand-in. A voucher with none of
 * these cannot be proven distinct and is kept, not dropped.
 */
export function tallyVoucherKey(voucher: TallyVoucher): string | undefined {
  const guid = voucher.guid?.trim()
  if (guid) return `guid:${guid.toLowerCase()}`
  const remote = voucher.remoteId?.trim()
  if (remote) return `remote:${remote.toLowerCase()}`
  const number = voucher.number?.trim()
  const date = voucher.date?.trim()
  if (number && date) return `number:${number.toLowerCase()}:${date}`
  return undefined
}

function voucherTotal(voucher: TallyVoucher): number {
  return voucher.ledgerLines.reduce((total, line) => total + Math.abs(line.amount), 0)
}

function unsupportedReason(type: string): string {
  return `Voucher type "${type}" does not map to a ledger posting this import supports, so it was not staged.`
}

export function summariseVoucherTypes(vouchers: TallyVoucher[]): TallyVoucherTypeSummary[] {
  const counts = new Map<string, number>()
  for (const voucher of vouchers) {
    const type = voucher.type?.trim() || "(no type)"
    counts.set(type, (counts.get(type) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([type, count]) => {
      const supported = tallyVoucherSourceType(classifyTallyVoucherType(type)) !== undefined
      return {
        type,
        count,
        supported,
        ...(supported ? {} : { reason: unsupportedReason(type) }),
      }
    })
    .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type))
}

/** Days between the first and last date that no voucher in the set falls on. */
function dateGaps(dates: string[], period: TallyDateRange): Array<{ from: string; to: string }> {
  const present = new Set<number>()
  for (const date of dates) {
    try {
      present.add(parseTallyIsoDate(date))
    } catch {
      // An unreadable date is reported by the normaliser, not as a gap.
    }
  }
  const start = parseTallyIsoDate(period.from)
  const end = parseTallyIsoDate(period.to)
  const gaps: Array<{ from: string; to: string }> = []
  let runStart: number | undefined
  let runEnd: number | undefined
  const DAY = 86_400_000
  for (let at = start; at <= end; at += DAY) {
    if (present.has(at)) {
      if (runStart !== undefined && runEnd !== undefined) {
        gaps.push({
          from: new Date(runStart).toISOString().slice(0, 10),
          to: new Date(runEnd).toISOString().slice(0, 10),
        })
        runStart = undefined
        runEnd = undefined
      }
      continue
    }
    if (runStart === undefined) runStart = at
    runEnd = at
  }
  if (runStart !== undefined && runEnd !== undefined) {
    gaps.push({
      from: new Date(runStart).toISOString().slice(0, 10),
      to: new Date(runEnd).toISOString().slice(0, 10),
    })
  }
  return gaps
}

function companyOf(parts: TallyXmlDocument[], stated?: string): string {
  const names = new Set(
    parts
      .map((part) => (part.company ?? "").trim().toLowerCase())
      .filter((name) => name.length > 0),
  )
  if (names.size > 1) throw new TallyConsolidationError("TALLY_CONSOLIDATION_COMPANY_MISMATCH")
  const named = parts.find((part) => (part.company ?? "").trim())?.company?.trim() ?? ""
  const entered = (stated ?? "").trim()
  if (named) {
    if (entered && entered.toLowerCase() !== named.toLowerCase()) {
      throw new TallyConsolidationError("TALLY_CONSOLIDATION_COMPANY_MISMATCH")
    }
    return named
  }
  if (entered) return entered
  throw new TallyConsolidationError("TALLY_CONSOLIDATION_COMPANY_MISSING")
}

export function consolidateTallyParts(
  parts: TallyXmlDocument[],
  input: TallyConsolidationInput,
): TallyConsolidation {
  if (parts.length === 0) throw new TallyConsolidationError("TALLY_CONSOLIDATION_EMPTY")
  const company = companyOf(parts, input.company)

  const groups = mergeBy<TallyGroup>(parts.map((part) => part.groups))
  const ledgers = mergeBy<TallyLedger>(parts.map((part) => part.ledgers))
  const stockGroups = mergeBy<TallyStockGroup>(parts.map((part) => part.stockGroups))
  const stockItems = mergeBy<TallyStockItem>(parts.map((part) => part.stockItems))
  const units = mergeBy<TallyUnit>(parts.map((part) => part.units))
  const godowns = mergeBy<TallyGodown>(parts.map((part) => part.godowns))

  const seenVouchers = new Set<string>()
  const vouchers: TallyVoucher[] = []
  let duplicateVouchers = 0
  let keyless = 0
  for (const part of parts) {
    for (const voucher of part.vouchers) {
      const key = tallyVoucherKey(voucher)
      if (!key) {
        keyless += 1
        vouchers.push(voucher)
        continue
      }
      if (seenVouchers.has(key)) {
        duplicateVouchers += 1
        continue
      }
      seenVouchers.add(key)
      vouchers.push(voucher)
    }
  }
  if (vouchers.length > TALLY_CONSOLIDATION_LIMIT) {
    throw new TallyConsolidationError("TALLY_CONSOLIDATION_TOO_LARGE")
  }

  const warnings: TallyXmlRowWarning[] = []
  for (const part of parts) {
    for (const warning of part.warnings) {
      if (!warnings.includes(warning)) warnings.push(warning)
    }
  }
  const truncated = parts.find((part) => part.truncated)?.truncated

  const types = summariseVoucherTypes(vouchers)
  const unsupported = types.filter((entry) => !entry.supported)

  const totals = new Map<string, number>()
  for (const voucher of vouchers) {
    const type = voucher.type?.trim() || "(no type)"
    totals.set(type, (totals.get(type) ?? 0) + voucherTotal(voucher))
  }

  const dates = vouchers.map((voucher) => voucher.date).filter((date): date is string => !!date)
  const sorted = [...dates].sort()
  const masterCount =
    groups.records.length +
    ledgers.records.length +
    stockGroups.records.length +
    stockItems.records.length +
    units.records.length +
    godowns.records.length
  const masterDuplicates =
    groups.duplicates +
    ledgers.duplicates +
    stockGroups.duplicates +
    stockItems.duplicates +
    units.duplicates +
    godowns.duplicates
  const masterConflicts =
    groups.conflicts +
    ledgers.conflicts +
    stockGroups.conflicts +
    stockItems.conflicts +
    units.conflicts +
    godowns.conflicts

  const problems: string[] = []
  if (masterConflicts > 0) {
    problems.push(
      `TALLY_CONSOLIDATION_CONFLICT: ${masterConflicts} master record${masterConflicts === 1 ? "" : "s"} arrived more than once with different content; the first copy was kept.`,
    )
  }
  if (truncated) {
    problems.push(
      `TALLY_CONSOLIDATION_TRUNCATED: the parser stopped at ${truncated.recordsProcessed} records, so the export was not read in full.`,
    )
  }
  const statedMasters = input.expectedMasters
  const statedVouchers = input.expectedVouchers
  if (statedMasters !== undefined && statedMasters !== masterCount) {
    problems.push(
      `TALLY_CONSOLIDATION_MASTER_MISMATCH: the source reported ${statedMasters} master records but ${masterCount} were read.`,
    )
  }
  if (statedVouchers !== undefined && statedVouchers !== vouchers.length) {
    problems.push(
      `TALLY_CONSOLIDATION_VOUCHER_MISMATCH: the source reported ${statedVouchers} vouchers but ${vouchers.length} were read.`,
    )
  }

  // An independent count agreeing is the only thing that earns `verified`.
  // With none, a clean merge is still only `unverified`.
  let reconciliation: TallyReconciliation = "unverified"
  if (input.expectedMasters !== undefined || input.expectedVouchers !== undefined) {
    reconciliation =
      input.expectedMasters !== undefined && input.expectedMasters !== masterCount
        ? "mismatch"
        : input.expectedVouchers !== undefined && input.expectedVouchers !== vouchers.length
          ? "mismatch"
          : "verified"
  }

  const document: TallyXmlDocument = {
    company,
    ...(parts.find((part) => part.companyGuid)?.companyGuid
      ? { companyGuid: parts.find((part) => part.companyGuid)?.companyGuid }
      : {}),
    ...(parts.find((part) => part.currency)?.currency
      ? { currency: parts.find((part) => part.currency)?.currency }
      : {}),
    financialPeriod: { from: input.period.from, to: input.period.to },
    groups: groups.records,
    ledgers: ledgers.records,
    stockGroups: stockGroups.records,
    stockItems: stockItems.records,
    units: units.records,
    godowns: godowns.records,
    vouchers,
    warnings,
    ...(truncated ? { truncated } : {}),
  }

  return {
    document,
    report: {
      company,
      parts: parts.length,
      masters: {
        groups: groups.records.length,
        ledgers: ledgers.records.length,
        stockGroups: stockGroups.records.length,
        stockItems: stockItems.records.length,
        units: units.records.length,
        godowns: godowns.records.length,
        total: masterCount,
        duplicates: masterDuplicates,
        conflicts: masterConflicts,
      },
      vouchers: {
        read: parts.reduce((total, part) => total + part.vouchers.length, 0),
        unique: vouchers.length,
        duplicates: duplicateVouchers,
        cancelled: vouchers.filter((voucher) => voucher.isCancelled).length,
        undated: vouchers.filter((voucher) => !voucher.date).length,
        keyless,
        types,
        unsupported,
      },
      dates: {
        ...(sorted[0] ? { first: sorted[0] } : {}),
        ...(sorted[sorted.length - 1] ? { last: sorted[sorted.length - 1] } : {}),
        gaps: dateGaps(dates, input.period),
      },
      totals: [...totals.entries()]
        .map(([type, amount]) => ({ type, amount }))
        .sort((left, right) => right.amount - left.amount || left.type.localeCompare(right.type)),
      reconciliation,
      problems,
      warnings,
      ...(truncated ? { truncated } : {}),
    },
  }
}
