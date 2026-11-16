/**
 * Read-only history of what Tally imports brought into Synapse.
 *
 * Each session row records what its plan intended and what its apply reported.
 * This module also counts what is actually in the ledger now, so the review
 * shows all three side by side rather than trusting the apply's own tally.
 *
 * A pharmacy can hold more than one applied session: a continuation adds a
 * later period, and a rollback leaves the reversed session in place with a
 * reversing journal for each entry it posted. Ledger counts are therefore
 * netted against those reversals, and compared with the sum of the sessions
 * still in force. Nothing here writes: imported rows stay read-only.
 */

import { TALLY_MIRROR_NOTE_PREFIX, type TallyApplyDb, type TallyImportMode } from "./types"
import type { TallyApplyCounts, TallyApplyFailure } from "./apply"

/** Journal source types an import posts, in Day Book order. */
export const TALLY_JOURNAL_SOURCE_TYPES = [
  "tally_opening",
  "tally_sale",
  "tally_purchase",
  "tally_receipt",
  "tally_payment",
  "tally_contra",
  "tally_journal",
  "tally_credit_note",
  "tally_debit_note",
] as const

/** What a rollback posts against each imported journal. */
export const TALLY_REVERSAL_SOURCE_TYPE = "tally_replay_reversal"

export type TallyJournalSourceType = (typeof TALLY_JOURNAL_SOURCE_TYPES)[number]
export type TallyHistorySourceType = TallyJournalSourceType | typeof TALLY_REVERSAL_SOURCE_TYPE

export const TALLY_SOURCE_LABELS: Record<TallyHistorySourceType, string> = {
  tally_opening: "Opening balances",
  tally_sale: "Sales",
  tally_purchase: "Purchases",
  tally_receipt: "Receipts",
  tally_payment: "Payments",
  tally_contra: "Contra",
  tally_journal: "Journals",
  tally_credit_note: "Credit notes",
  tally_debit_note: "Debit notes",
  tally_replay_reversal: "Rollback reversals",
}

export const TALLY_HISTORY_SOURCE_TYPES: readonly TallyHistorySourceType[] = [
  ...TALLY_JOURNAL_SOURCE_TYPES,
  TALLY_REVERSAL_SOURCE_TYPE,
]

export function isTallyHistorySourceType(value: unknown): value is TallyHistorySourceType {
  return typeof value === "string" && (TALLY_HISTORY_SOURCE_TYPES as readonly string[]).includes(value)
}

export const TALLY_HISTORY_PAGE_SIZE = 50
const FAILURE_LIMIT = 200
const SESSION_LIMIT = 20
/** Sessions that may have written to the ledger. Pending or reviewed ones never did. */
const APPLIED_STATUSES = ["complete", "importing", "failed"]

export type TallyHistoryCheck = {
  id: "opening" | "vouchers" | "sales" | "purchases"
  label: string
  /** What the reviewed plans of the sessions in force said would be written. */
  planned: number | null
  /** What those sessions' applies reported writing. */
  applied: number | null
  /** What is in the ledger now, net of rollback reversals. */
  found: number
  status: "match" | "short" | "over" | "unknown"
  note?: string
}

export type TallyHistorySession = {
  id: string
  status: string
  /** Set when a rollback undid this session; its entries are reversed, not deleted. */
  reversedAt: string | null
  continuationOf: string | null
  fileName: string | null
  createdAt: string | null
  completedAt: string | null
  company: string | null
  mode: TallyImportMode
  conversionDate: string | null
  currency: string | null
  period: { from: string; to: string } | null
  appliedCounts: Partial<TallyApplyCounts> | null
  failureCount: number
}

export type TallyHistoryFailure = TallyApplyFailure & { sessionId: string }

export type TallyHistorySummary = {
  sessions: TallyHistorySession[]
  ledger: Array<{ sourceType: TallyHistorySourceType; label: string; count: number }>
  /** Imported journals still in force: those posted less those reversed. */
  journalsInForce: number
  reversals: number
  checks: TallyHistoryCheck[]
  failures: TallyHistoryFailure[]
  failureCount: number
}

export type TallyHistoryEntry = {
  id: string
  entryNo: string
  date: string
  sourceType: string
  label: string
  sourceId: string
  description: string
  currency: string
  total: number
  /** An imported journal a rollback has reversed. */
  reversed: boolean
}

export type TallyHistoryLine = {
  id: string
  accountCode: string | null
  accountName: string | null
  description: string | null
  debit: number
  credit: number
}

export type TallyHistoryFilter = {
  sourceType?: TallyHistorySourceType
  from?: string
  to?: string
  page?: number
}

type PlanCounts = { postedVouchers?: number; sales?: number; purchases?: number; openingLines?: number }

/**
 * One session, read column by column out of `ai_mapping`. The mapping also
 * carries the playback index and staged-file evidence, which can run to
 * megabytes; the history never needs them.
 */
type SessionRow = {
  id: string
  status: string
  file_name: string | null
  created_at: string | null
  completed_at: string | null
  reversed_at: string | null
  continuation_of: string | null
  mapping_mode: string | null
  mapping_conversion_date: string | null
  summary_mode: string | null
  summary_company: string | null
  summary_currency: string | null
  summary_conversion_date: string | null
  plan_counts: PlanCounts | null
  period: { from: string; to: string } | null
  applied_counts: Partial<TallyApplyCounts> | null
  failures: TallyApplyFailure[] | null
}

const SESSION_COLUMNS = [
  "id",
  "status",
  "file_name",
  "created_at",
  "completed_at",
  "reversed_at:ai_mapping->>reversedAt",
  "continuation_of:ai_mapping->>continuationOf",
  "mapping_mode:ai_mapping->>mode",
  "mapping_conversion_date:ai_mapping->>conversionDate",
  "summary_mode:ai_mapping->summary->>mode",
  "summary_company:ai_mapping->summary->>company",
  "summary_currency:ai_mapping->summary->>currency",
  "summary_conversion_date:ai_mapping->summary->>conversionDate",
  "plan_counts:ai_mapping->summary->counts",
  "period:ai_mapping->manifest->period",
  "applied_counts:ai_mapping->progress->counts",
  "failures:ai_mapping->progress->failures",
].join(", ")

function readError(stage: string, error: { message?: string } | null | undefined): Error {
  return new Error(`TALLY_HISTORY_UNAVAILABLE: ${stage}: ${error?.message ?? "no response"}`)
}

function modeOf(row: SessionRow): TallyImportMode {
  const mode = row.summary_mode ?? row.mapping_mode
  return mode === "closing" || mode === "replay" ? mode : "opening"
}

function compare(planned: number | null, found: number): TallyHistoryCheck["status"] {
  if (planned === null) return "unknown"
  if (found === planned) return "match"
  return found < planned ? "short" : "over"
}

/** Sums one figure across sessions; null when any session cannot say. */
function total(values: Array<number | null | undefined>): number | null {
  let sum = 0
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null
    sum += value
  }
  return sum
}

async function countRows(
  db: TallyApplyDb,
  table: string,
  build: (query: any) => any,
): Promise<number> {
  const { count, error } = await build(db.from(table).select("id", { count: "exact", head: true }))
  if (error) throw readError(table, error)
  return Number(count ?? 0)
}

/** Every Tally session that may have written to the ledger, newest first. */
export async function listTallyHistorySessions(db: TallyApplyDb, tenantId: string): Promise<SessionRow[]> {
  const { data, error } = await db
    .from("pharmacy_import_sessions")
    .select(SESSION_COLUMNS)
    .eq("tenant_id", tenantId)
    .eq("source_system", "Tally")
    .in("status", APPLIED_STATUSES)
    .order("created_at", { ascending: false })
    .limit(SESSION_LIMIT)
  if (error) throw readError("sessions", error)
  // A failed or interrupted session that never reached the apply wrote nothing.
  return ((data ?? []) as SessionRow[]).filter((row) => row.status === "complete" || row.applied_counts)
}

function plannedFor(row: SessionRow): { opening: number; vouchers: number; sales: number; purchases: number } | null {
  const counts = row.plan_counts
  if (!counts || typeof counts.postedVouchers !== "number") return null
  // Balances-only mode posts the opening position and replays no vouchers.
  const history = modeOf(row) !== "closing"
  return {
    opening: (counts.openingLines ?? 0) > 0 ? 1 : 0,
    vouchers: history ? counts.postedVouchers : 0,
    sales: history ? counts.sales ?? 0 : 0,
    purchases: history ? counts.purchases ?? 0 : 0,
  }
}

export async function loadTallyHistorySummary(
  db: TallyApplyDb,
  tenantId: string,
  rows: SessionRow[],
): Promise<TallyHistorySummary> {
  const mirrorPattern = `${TALLY_MIRROR_NOTE_PREFIX}%`
  const [byType, openingReversals, sales, purchases] = await Promise.all([
    Promise.all(
      TALLY_HISTORY_SOURCE_TYPES.map(async (sourceType) => ({
        sourceType,
        label: TALLY_SOURCE_LABELS[sourceType],
        count: await countRows(db, "pharmacy_accounting_journal_entries", (query) =>
          query.eq("tenant_id", tenantId).eq("source_type", sourceType),
        ),
      })),
    ),
    // A reversal's source id is the reversed entry's `type:id`.
    countRows(db, "pharmacy_accounting_journal_entries", (query) =>
      query
        .eq("tenant_id", tenantId)
        .eq("source_type", TALLY_REVERSAL_SOURCE_TYPE)
        .like("source_id", "tally_opening:%"),
    ),
    countRows(db, "pharmacy_transactions", (query) =>
      query.eq("tenant_id", tenantId).like("notes", mirrorPattern),
    ),
    countRows(db, "pharmacy_purchases", (query) =>
      query.eq("tenant_id", tenantId).like("notes", mirrorPattern),
    ),
  ])

  const countOf = (type: TallyHistorySourceType) => byType.find((row) => row.sourceType === type)?.count ?? 0
  const reversals = countOf(TALLY_REVERSAL_SOURCE_TYPE)
  const posted = byType
    .filter((row) => row.sourceType !== TALLY_REVERSAL_SOURCE_TYPE)
    .reduce((sum, row) => sum + row.count, 0)
  const opening = countOf("tally_opening") - openingReversals
  const vouchers = posted - countOf("tally_opening") - (reversals - openingReversals)

  const live = rows.filter((row) => !row.reversed_at)
  const plans = live.map(plannedFor)
  const planned = (pick: (plan: NonNullable<ReturnType<typeof plannedFor>>) => number) =>
    total(plans.map((plan) => (plan ? pick(plan) : null)))
  const applied = (pick: (counts: Partial<TallyApplyCounts>) => number | undefined) =>
    total(live.map((row) => (row.applied_counts ? pick(row.applied_counts) ?? 0 : null)))

  // A rollback reverses journals but leaves the sales and purchase mirrors,
  // so their counts include rows from a session no longer in force.
  const rolledBack = rows.length > live.length
  const mirrorNote = rolledBack
    ? "Includes mirrors written by a rolled-back import, so this cannot be compared with the sessions in force."
    : undefined
  const mirrorCheck = (
    id: "sales" | "purchases",
    label: string,
    found: number,
  ): TallyHistoryCheck => {
    const plannedValue = planned((plan) => plan[id])
    return {
      id,
      label,
      planned: plannedValue,
      applied: applied((counts) => counts[id]),
      found,
      status: rolledBack ? "unknown" : compare(plannedValue, found),
      note: mirrorNote,
    }
  }

  const plannedOpening = planned((plan) => plan.opening)
  const plannedVouchers = planned((plan) => plan.vouchers)
  const checks: TallyHistoryCheck[] = [
    {
      id: "opening",
      label: "Opening balance journals",
      planned: plannedOpening,
      applied: applied((counts) => counts.openingJournal),
      found: opening,
      status: compare(plannedOpening, opening),
    },
    {
      id: "vouchers",
      label: "Day Book vouchers posted",
      planned: plannedVouchers,
      applied: applied((counts) => counts.journals),
      found: vouchers,
      status: compare(plannedVouchers, vouchers),
    },
    mirrorCheck("sales", "Sales mirrored to transactions", sales),
    mirrorCheck("purchases", "Purchases mirrored to purchases", purchases),
  ]

  const failures = rows.flatMap((row) =>
    (row.failures ?? []).map((failure) => ({ ...failure, sessionId: row.id })),
  )

  return {
    sessions: rows.map((row) => ({
      id: row.id,
      status: row.status,
      reversedAt: row.reversed_at,
      continuationOf: row.continuation_of,
      fileName: row.file_name,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      company: row.summary_company,
      mode: modeOf(row),
      conversionDate: row.summary_conversion_date ?? row.mapping_conversion_date,
      currency: row.summary_currency,
      period: row.period ?? null,
      appliedCounts: row.applied_counts,
      failureCount: row.failures?.length ?? 0,
    })),
    ledger: byType,
    journalsInForce: posted - reversals,
    reversals,
    checks,
    failures: failures.slice(0, FAILURE_LIMIT),
    failureCount: failures.length,
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** Parses the query string; anything malformed is dropped rather than trusted. */
export function parseTallyHistoryFilter(params: URLSearchParams): TallyHistoryFilter {
  const type = params.get("type")
  const from = params.get("from")
  const to = params.get("to")
  const page = Number.parseInt(params.get("page") ?? "1", 10)
  return {
    sourceType: isTallyHistorySourceType(type) ? type : undefined,
    from: from && ISO_DAY.test(from) ? from : undefined,
    to: to && ISO_DAY.test(to) ? to : undefined,
    page: Number.isFinite(page) && page >= 1 ? Math.min(page, 100_000) : 1,
  }
}

const ENTRY_COLUMNS = "id, entry_no, entry_date, source_type, source_id, description, currency, total_debit"

function toEntry(row: Record<string, unknown>, reversed: boolean): TallyHistoryEntry {
  const sourceType = String(row.source_type ?? "")
  return {
    id: String(row.id),
    entryNo: String(row.entry_no ?? ""),
    date: String(row.entry_date ?? ""),
    sourceType,
    label: isTallyHistorySourceType(sourceType) ? TALLY_SOURCE_LABELS[sourceType] : sourceType,
    sourceId: String(row.source_id ?? ""),
    description: String(row.description ?? ""),
    currency: String(row.currency ?? ""),
    total: Number(row.total_debit ?? 0),
    reversed,
  }
}

/** Which of these imported journals a rollback has reversed. */
async function reversedKeys(
  db: TallyApplyDb,
  tenantId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Set<string>> {
  const keys = rows
    .filter((row) => row.source_type !== TALLY_REVERSAL_SOURCE_TYPE)
    .map((row) => `${row.source_type}:${row.source_id}`)
  if (keys.length === 0) return new Set()
  const { data, error } = await db
    .from("pharmacy_accounting_journal_entries")
    .select("source_id")
    .eq("tenant_id", tenantId)
    .eq("source_type", TALLY_REVERSAL_SOURCE_TYPE)
    .in("source_id", keys)
  if (error) throw readError("reversals", error)
  return new Set(((data ?? []) as Array<{ source_id: string }>).map((row) => row.source_id))
}

/** The imported Day Book, oldest first, one page at a time. Reversals only when asked for. */
export async function listTallyHistoryEntries(
  db: TallyApplyDb,
  tenantId: string,
  filter: TallyHistoryFilter,
): Promise<{ entries: TallyHistoryEntry[]; total: number; page: number; pageSize: number }> {
  const page = filter.page ?? 1
  const start = (page - 1) * TALLY_HISTORY_PAGE_SIZE

  let query = db
    .from("pharmacy_accounting_journal_entries")
    .select(ENTRY_COLUMNS, { count: "exact" })
    .eq("tenant_id", tenantId)
  query = filter.sourceType
    ? query.eq("source_type", filter.sourceType)
    : query.in("source_type", [...TALLY_JOURNAL_SOURCE_TYPES])
  if (filter.from) query = query.gte("entry_date", filter.from)
  if (filter.to) query = query.lte("entry_date", filter.to)

  const { data, error, count } = await query
    .order("entry_date", { ascending: true })
    .order("entry_no", { ascending: true })
    .range(start, start + TALLY_HISTORY_PAGE_SIZE - 1)
  if (error) throw readError("entries", error)

  const rows = (data ?? []) as Array<Record<string, unknown>>
  const reversed = await reversedKeys(db, tenantId, rows)
  return {
    entries: rows.map((row) => toEntry(row, reversed.has(`${row.source_type}:${row.source_id}`))),
    total: Number(count ?? rows.length),
    page,
    pageSize: TALLY_HISTORY_PAGE_SIZE,
  }
}

/** One imported voucher with its debit and credit lines; null if it is not a Tally entry. */
export async function loadTallyHistoryEntry(
  db: TallyApplyDb,
  tenantId: string,
  entryId: string,
): Promise<{ entry: TallyHistoryEntry; lines: TallyHistoryLine[] } | null> {
  const { data: row, error } = await db
    .from("pharmacy_accounting_journal_entries")
    .select(ENTRY_COLUMNS)
    .eq("id", entryId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (error) throw readError("entry", error)
  if (!row || !isTallyHistorySourceType(row.source_type)) return null

  const { data: lineRows, error: lineError } = await db
    .from("pharmacy_accounting_journal_lines")
    .select("id, account_id, description, debit, credit")
    .eq("tenant_id", tenantId)
    .eq("journal_entry_id", entryId)
  if (lineError) throw readError("lines", lineError)
  const lines = (lineRows ?? []) as Array<Record<string, unknown>>

  const accountIds = [...new Set(lines.map((line) => String(line.account_id)))]
  const accounts = new Map<string, { code: string; name: string }>()
  if (accountIds.length > 0) {
    const { data: accountRows, error: accountError } = await db
      .from("pharmacy_accounting_accounts")
      .select("id, code, name")
      .eq("tenant_id", tenantId)
      .in("id", accountIds)
    if (accountError) throw readError("accounts", accountError)
    for (const account of (accountRows ?? []) as Array<Record<string, unknown>>) {
      accounts.set(String(account.id), { code: String(account.code), name: String(account.name) })
    }
  }

  const reversed = await reversedKeys(db, tenantId, [row])
  return {
    entry: toEntry(row, reversed.has(`${row.source_type}:${row.source_id}`)),
    lines: lines
      .map((line) => {
        const account = accounts.get(String(line.account_id))
        return {
          id: String(line.id),
          accountCode: account?.code ?? null,
          accountName: account?.name ?? null,
          description: (line.description as string | null) ?? null,
          debit: Number(line.debit ?? 0),
          credit: Number(line.credit ?? 0),
        }
      })
      // Debits first, as Tally prints a voucher.
      .sort((a, b) => b.debit - a.debit || b.credit - a.credit),
  }
}
