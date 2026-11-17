/**
 * Shapes shared by the Tally import routes and library.
 * `from` stays loosely typed because Supabase's query builder is thenable and
 * generic in ways a structural stub cannot express without fighting the types.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  TallyReplayFinding,
  TallyReplayLineCost,
  TallyReplayReconciliationRow,
  TallyReplayState,
} from "@synapse/db/tally-replay"

/** A reconciliation row as the session summary keeps it: no voucher list. */
export type TallyReplayReconciliationSummaryRow = Omit<TallyReplayReconciliationRow, "sourceIds">

/** What PostgREST returns for a refused write; `code` is the SQLSTATE. */
export type TallyDbError = {
  message: string
  code?: string
  details?: string
  hint?: string
}

export type TallyApplyDb = {
  from: (table: string) => any
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: TallyDbError | null }>
}

/** Vouchers posted per apply request. Bounded so no single call runs long. */
export const TALLY_APPLY_CHUNK = 250

/**
 * What a session imports. `replay` rebuilds the ledger and the stock
 * movement by movement up to a cutoff; the other two take a snapshot.
 */
export type TallyImportMode = "opening" | "closing" | "replay"

/** One day of the replay: what happened in the sequence on that date. */
export type TallyReplayDayCount = {
  date: string
  events: number
  movements: number
  /** Events on the day, keyed by Tally document kind. */
  kinds: Record<string, number>
}

/**
 * What the replay reached, beside the figures Tally exported.
 *
 * Stored as `plan-replay-target.json` and read back by Apply, so the closing
 * check compares against the same numbers the operator reviewed.
 */
export type TallyReplayTarget = {
  /** The preview this target was built for; an acknowledgement binds to it. */
  preparedAt: string
  conversionDate: string
  cutoffDate: string
  ordering: "date-then-export-order"
  eventCount: number
  movementCount: number
  perDay: TallyReplayDayCount[]
  reconciliation: TallyReplayReconciliationRow[]
  totals: { match: number; difference: number; notAvailable: number }
  blocking: number
  warnings: number
  findings: TallyReplayFinding[]
  simulated: TallyReplayState
  /**
   * Cost of the stock each sale line removed, from the replay's own batch
   * values. Absent on targets saved before costs were recorded; Apply then
   * leaves the line's cost unknown rather than guessing one.
   */
  costs?: Record<string, TallyReplayLineCost>
}

/**
 * One stock line as a playback event shows it. `count` is a physical stock
 * journal, whose figure is the quantity counted rather than an in or out.
 */
export type TallyPlaybackStockLine = {
  item: string
  quantity: number
  direction: "in" | "out" | "count"
}

/** One dated thing the cut-over carries, as the walkthrough shows it. */
export type TallyPlaybackEvent = {
  id: string
  date: string
  type: "opening" | "voucher" | "movement"
  kind: string
  number?: string
  description: string
  debit: number
  credit: number
  lineCount: number
  stock: TallyPlaybackStockLine[]
  /** Batch-level movements the plan proves for this event; 0 outside replay. */
  movements: number
}

export type TallyPlaybackDay = {
  date: string
  events: number
  movements: number
  /** The chunk this day's first event is in, so the screen can page to it. */
  firstChunk: number
}

/**
 * The cut-over as a dated walkthrough, stored beside the plan.
 *
 * Only the index lives in the summary; the events themselves are chunked like
 * the plan's vouchers so a 26,000-voucher history can be walked a day at a
 * time without loading it all.
 */
export type TallyPlaybackIndex = {
  mode: TallyImportMode
  firstDate: string
  lastDate: string
  eventCount: number
  movementCount: number
  chunkCount: number
  chunkSize: number
  days: TallyPlaybackDay[]
}

export type TallySessionStatus =
  | "pending"
  | "mapping"
  | "review"
  | "importing"
  | "complete"
  | "failed"

export type TallyPlanSummary = {
  company?: string
  companyKey: string
  currency: string
  conversionDate: string
  /** Absent on summaries prepared before the balances-only mode existed. */
  mode?: TallyImportMode
  /**
   * Whether the export states a batch expiry on every inbound line.
   * `not-supplied` means the operator accepted stock without expiry; absent
   * on summaries prepared before this choice existed.
   */
  batchExpiry?: "source" | "not-supplied"
  /**
   * Replay only: `allowed` when the operator stated the source Tally allowed
   * negative stock. Absent means each negative blocks Apply.
   */
  negativeStock?: "allowed"
  format: "xml" | "xlsx" | "xls" | "csv"
  counts: {
    ledgers: number
    groups: number
    stockItems: number
    vouchers: number
    postedVouchers: number
    /** Stock-only vouchers applied as dated stock adjustments. */
    adjustedVouchers?: number
    skippedVouchers: number
    sales: number
    purchases: number
    openingLines: number
  }
  opening: {
    date: string
    totalDebit: number
    totalCredit: number
    difference: number
  }
  /** Absent on summaries prepared before the stock valuation was recorded. */
  stock?: {
    openingValue: number | null
    closingValue: number | null
    itemsWithOpeningValue: number
    itemsWithClosingValue: number
    itemCount: number
  }
  /**
   * The figures a cut-over preflight reconciles before anything is written.
   * Absent on summaries prepared before the preflight existed; a preflight
   * treats a missing block as unprovable rather than as zero.
   */
  reconciliation?: {
    /** The inventory control account's opening lines, debit less credit. */
    inventoryOpening: number | null
    /** Customer ledgers' opening as the opening journal carries it. */
    customerOpening: number
    /** Supplier ledgers' opening as the opening journal carries it. */
    supplierOpening: number
    /** The same balances summed from the party records. */
    partyReceivable: number
    partyPayable: number
    /** Duplicate voucher identities the parser detected; later copies were skipped. */
    duplicateVouchers: number
  }
  /**
   * Replay only. What the chronological rebuild reaches, and how it compares
   * with Tally's own closing figures. Absent on opening and closing plans.
   */
  replay?: {
    cutoffDate: string
    ordering: "date-then-export-order"
    eventCount: number
    movementCount: number
    /** Movement chunks Apply walks through in the `stock-history` stage. */
    movementChunkCount: number
    perDay: TallyReplayDayCount[]
    /**
     * Every row the review shows, without the vouchers each one touched. The
     * session saves this summary at every Apply step, and those lists made a
     * full history's summary about 10 MB; they stay in the replay target.
     */
    reconciliation: TallyReplayReconciliationSummaryRow[]
    /** Rows whose difference is real, plus blocking simulation findings. */
    blocking: number
    warnings: number
  }
  /**
   * Opening cut-overs only. The physical stock and stock journal vouchers the
   * plan applies as dated adjustments after the opening stock. Absent when the
   * export carries none, and on replay, where the movements live under
   * `replay`.
   */
  stockAdjustments?: {
    /** Stock-only vouchers whose lines became movements. */
    voucherCount: number
    movementCount: number
    /** Movement chunks Apply walks through in the `stock-history` stage. */
    movementChunkCount: number
  }
  /**
   * The dated walkthrough. Absent on closing plans, which carry no history to
   * walk, and on summaries prepared before the walkthrough existed.
   */
  playback?: TallyPlaybackIndex
  exceptions: Array<{
    code: string
    message: string
    detail?: string
    severity: "blocking" | "warning"
  }>
  /**
   * True count per code. The listed exceptions stop at a cap, so this is the
   * only place a capped list can be told apart from a complete one.
   */
  exceptionCounts?: Record<string, number>
  chunkCount: number
  chunkSize: number
  warnings: string[]
  preparedAt: string
}

export type TallyPlanChunk = {
  index: number
  vouchers: unknown[]
  sales: unknown[]
  purchases: unknown[]
}

/**
 * Prefix of the note stamped on every reporting mirror. The ledger entry came
 * from the Tally voucher, so the portal must not edit these rows afterwards.
 */
export const TALLY_MIRROR_NOTE_PREFIX = "Imported from Tally"

export function isTallyMirrorNote(note: string | null | undefined): boolean {
  return typeof note === "string" && note.startsWith(TALLY_MIRROR_NOTE_PREFIX)
}
