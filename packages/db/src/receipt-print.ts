/**
 * Receipt-print policy and print-attempt recording for a completed POS sale.
 *
 * "Require receipt print" (`pharmacy_settings.mandatory_receipt_print`, NOT NULL
 * DEFAULT true) cannot mean "refuse to complete the sale until a printer
 * succeeds":
 *
 *  - the sale is committed by `complete_pharmacy_sale` before the browser or
 *    phone can reach a printer, so gating completion would turn a printer fault
 *    into lost revenue and would let a retry duplicate the sale;
 *  - neither a browser nor a phone can report whether paper actually came out.
 *    `window.print()` returns after the dialog closes, and React Native's
 *    `Print.printAsync` resolves when the OS print sheet is dismissed.
 *
 * So the setting means: after the sale is committed, the cashier must make an
 * explicit print decision. There are exactly two exits — print now, or record
 * that the printer was unavailable. There is no silent "skip". Either way the
 * sale, its items and its payment stay as recorded, and the receipt can be
 * reprinted from the sale record without creating a new financial transaction.
 *
 * The setting is read with `!== false` because the database default is true;
 * an absent value (settings not loaded yet) must enforce, not silently allow a
 * skip.
 *
 * This module is shared by the web till (`apps/pharmacy`) and the mobile API
 * (`apps/web`) so both surfaces record the same audit rows and the same sale
 * columns. It deliberately takes the database client as an argument: the two
 * apps construct their service-role clients differently, and keeping the module
 * free of a client import means it can also be unit-tested with a fake.
 */

export interface ReceiptPrintSettings {
  mandatoryReceiptPrint?: boolean | null
  autoPrintReceipt?: boolean | null
}

export interface ReceiptPrintPolicy {
  /** The cashier may not dismiss the post-sale prompt without recording an outcome. */
  requiresAttempt: boolean
  /** Open the print dialog without prompting first. */
  autoPrint: boolean
  /** The "Skip Printing" action is offered. */
  allowSkip: boolean
}

export function resolveReceiptPrintPolicy(
  settings: ReceiptPrintSettings | null | undefined,
): ReceiptPrintPolicy {
  const requiresAttempt = settings?.mandatoryReceiptPrint !== false
  return {
    requiresAttempt,
    // Auto-print has no failure exit, so it must not replace the mandatory
    // prompt: a cashier needs somewhere to say "the printer is broken".
    autoPrint: !requiresAttempt && settings?.autoPrintReceipt === true,
    allowSkip: !requiresAttempt,
  }
}

/**
 * What a client can actually attest to.
 *
 *  - `requested` — the print dialog was opened (and, in browsers that block,
 *    closed). The system has no evidence that paper came out, so it does not
 *    claim the receipt printed.
 *  - `failed`   — the cashier reported a detectable failure: no printer, paper
 *    jam, dialog blocked. That is a human report, recorded as one.
 *
 * There is deliberately no `printed` value: `window.print()` returning,
 * `afterprint` firing, or `Print.printAsync` resolving tell you the dialog
 * closed, not that a device printed.
 */
export type ReceiptPrintOutcome = "requested" | "failed"

/** What the cashier is told when the receipt did not print. */
export const PRINTER_UNAVAILABLE_MESSAGE =
  "The sale is saved and no money needs to be taken again. Reprint this receipt from the sale in Transactions when a printer is available."

export function parseReceiptPrintOutcome(value: unknown): ReceiptPrintOutcome | null {
  return value === "requested" || value === "failed" ? value : null
}

/** Trim and cap the free-text reason so a caller cannot write an unbounded audit row. */
export function normalizePrintFailureReason(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : ""
  return text ? text.slice(0, 200) : "printer unavailable"
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A non-uuid reaches Postgres as a cast error and would surface as a 500. */
export function isReceiptPrintSaleId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value)
}

export const RECEIPT_PRINT_AUDIT_ACTIONS = {
  requested: "POS_RECEIPT_PRINT_REQUESTED",
  failed: "POS_RECEIPT_PRINT_FAILED",
} as const

export interface ReceiptPrintRecorded {
  ok: true
  saleId: string
  receiptNumber: string | null
  outcome: ReceiptPrintOutcome
  attemptedAt: string
  /** Always false: no client can prove paper came out. */
  physicalPrintConfirmed: false
  printFailed: boolean
  auditRecorded: true
}

export interface ReceiptPrintRecordError {
  ok: false
  status: 404 | 500 | 503
  code: "SALE_NOT_FOUND" | "PRINT_STATUS_WRITE_FAILED" | "PRINT_AUDIT_FAILED"
  error: string
  /** True when the sale row was updated but its audit row was not. */
  attemptRecorded?: boolean
  outcome?: ReceiptPrintOutcome
}

export type ReceiptPrintRecordResult = ReceiptPrintRecorded | ReceiptPrintRecordError

/** The slice of the Supabase client this module uses, so a fake can stand in. */
export interface ReceiptPrintDb {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
}

export interface ReceiptPrintRecordInput {
  tenantId: string
  profileId: string
  saleId: string
  outcome: ReceiptPrintOutcome
  reason?: unknown
  now?: Date
}

/**
 * Record the outcome of the receipt print step for a completed POS sale.
 *
 * This is deliberately not a financial write: it never touches totals,
 * payments, stock or the sale's status, so a reprint or a failed print cannot
 * duplicate or reverse a sale. It never writes `printed_at`, which would imply
 * a confirmed print.
 */
export async function recordReceiptPrintOutcome(
  db: ReceiptPrintDb,
  input: ReceiptPrintRecordInput,
): Promise<ReceiptPrintRecordResult> {
  const { tenantId, profileId, saleId, outcome } = input
  const reason = outcome === "failed" ? normalizePrintFailureReason(input.reason) : null
  const now = (input.now ?? new Date()).toISOString()

  const { data: sale, error: updateError } = await db
    .from("pharmacy_pos_sales")
    .update({
      print_failed: outcome === "failed",
      updated_at: now,
    })
    .eq("id", saleId)
    .eq("tenant_id", tenantId)
    .select("id, receipt_number")
    .maybeSingle()

  if (updateError) {
    console.error("Record receipt print status error:", updateError)
    return {
      ok: false,
      status: 500,
      code: "PRINT_STATUS_WRITE_FAILED",
      error: "Failed to record print status",
    }
  }
  if (!sale) {
    return { ok: false, status: 404, code: "SALE_NOT_FOUND", error: "Sale not found" }
  }

  const { error: auditError } = await db.from("pharmacy_audit_logs").insert({
    tenant_id: tenantId,
    profile_id: profileId,
    action: RECEIPT_PRINT_AUDIT_ACTIONS[outcome],
    entity: "POS_SALE",
    entity_id: saleId,
    details: `receipt=${sale.receipt_number ?? ""} outcome=${outcome}${
      reason ? ` reason=${reason}` : ""
    }`,
  })

  // The print outcome is already recorded; a missing audit row must be visible
  // to the operator but must not make the till think the sale failed.
  if (auditError) {
    console.error("Record receipt print audit error:", auditError)
    return {
      ok: false,
      status: 503,
      code: "PRINT_AUDIT_FAILED",
      error: "Print attempt recorded, but its audit entry could not be saved",
      attemptRecorded: true,
      outcome,
    }
  }

  return {
    ok: true,
    saleId,
    receiptNumber: sale.receipt_number ?? null,
    outcome,
    attemptedAt: now,
    physicalPrintConfirmed: false,
    printFailed: outcome === "failed",
    auditRecorded: true,
  }
}
