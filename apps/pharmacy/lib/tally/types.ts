/**
 * Shapes shared by the Tally import routes and library.
 * `from` stays loosely typed because Supabase's query builder is thenable and
 * generic in ways a structural stub cannot express without fighting the types.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

export type TallyApplyDb = {
  from: (table: string) => any
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

/** Vouchers posted per apply request. Bounded so no single call runs long. */
export const TALLY_APPLY_CHUNK = 250

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
  format: "xml" | "xlsx" | "csv"
  counts: {
    ledgers: number
    groups: number
    stockItems: number
    vouchers: number
    postedVouchers: number
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
  exceptions: Array<{
    code: string
    message: string
    detail?: string
    severity: "blocking" | "warning"
  }>
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
