/**
 * Whether the mobile receipt screen may be left without a print decision.
 *
 * "Require receipt print" means one of exactly two exits after a completed
 * sale: open the print sheet, or record that no printer is available. The
 * screen showed that instruction but still let the header back button and the
 * Android back key walk away from it — the same silent skip the web till had
 * until Escape stopped dismissing its prompt.
 *
 * A voided or refunded sale has no receipt to hand over, so it is never
 * blocked; neither is a sale read outside a mandatory pharmacy.
 *
 * No imports: this file must load under both Metro and `node --test`.
 */

export type ReceiptPrintOutcome = "requested" | "failed"

/** `decide` means the screen must offer print / printer-unavailable before leaving. */
export type ReceiptExit = "leave" | "decide"

export function resolveReceiptExit(input: {
  mandatory: boolean
  status: string | null | undefined
  outcome: ReceiptPrintOutcome | null
}): ReceiptExit {
  if (!input.mandatory) return "leave"
  // Only a completed sale carries a receipt the customer is owed.
  if (input.status !== "completed") return "leave"
  if (input.outcome) return "leave"
  return "decide"
}
