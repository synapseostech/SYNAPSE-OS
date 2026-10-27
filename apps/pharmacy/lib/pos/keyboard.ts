"use client"

import { useEffect, useRef } from "react"
import { isEditableTarget } from "../shortcuts/registry"

export type PosShortcutHandlers = {
  onPatientSearch?: () => void
  onProductSearch?: () => void
  onPrescription?: () => void
  onPayment?: () => void
  /** Focus amount-paid / tender field (Tally F5 Payment). */
  onAmountPaid?: () => void
  /** Accept / complete sale (Tally Ctrl+A / Ctrl+Enter / F8 Sales). */
  onCompleteSale?: () => void
  /** Focus or open customer/client details (Tally Alt+C). */
  onCustomer?: () => void
  /** Remove last cart line (Tally Ctrl+D). */
  onDeleteLine?: () => void
  /** Clear / abandon cart (Tally Alt+D delete voucher). */
  onClearCart?: () => void
  /** Preview / print receipt (Tally Alt+P / F6 Receipt). */
  onPrintReceipt?: () => void
  /** Switch payment method to CREDIT (Tally Ctrl+F8 Credit Note analogue). */
  onCreditMode?: () => void
  /** Save as order / purchase hold (Tally F9 Purchase analogue). */
  onSaveOrder?: () => void
  onHoldSale?: () => void
  onResumeSale?: () => void
  onClose?: () => void
}

export type PosShortcutAction =
  | "close"
  | "accept"
  | "customer"
  | "patient"
  | "products"
  | "prescription"
  | "amountPaid"
  | "paymentMethod"
  | "completeSale"
  | "holdSale"
  | "resumeSale"
  | "deleteLine"
  | "clearCart"
  | "printReceipt"
  | "creditMode"
  | "saveOrder"

/**
 * Pure key → action map so Tally parity can be unit-tested.
 * Returns null when the keystroke is not a POS accelerator.
 */
export function resolvePosShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): PosShortcutAction | null {
  const key = event.key
  const ctrl = event.ctrlKey || event.metaKey
  const alt = event.altKey
  const shift = event.shiftKey
  const lower = key.length === 1 ? key.toLowerCase() : key

  if (key === "Escape") return "close"

  // Ctrl+A / Ctrl+Enter → Accept (Tally)
  if (ctrl && !alt && (key === "Enter" || lower === "a")) return "accept"

  // Alt+C → create / customer (Tally)
  if (alt && !ctrl && lower === "c") return "customer"

  // Ctrl+D → delete line (Tally)
  if (ctrl && !alt && lower === "d") return "deleteLine"

  // Alt+D → delete voucher / clear cart (Tally)
  if (alt && !ctrl && lower === "d") return "clearCart"

  // Alt+P → print (Tally)
  if (alt && !ctrl && lower === "p") return "printReceipt"

  // Ctrl+P → print
  if (ctrl && !alt && lower === "p") return "printReceipt"

  // Ctrl+F8 → credit note analogue → credit payment mode
  if (ctrl && !alt && key === "F8") return "creditMode"

  if (key === "F2") return "patient"
  if (key === "F3") return "products"
  if (key === "F4") return "prescription"
  if (key === "F5") return "amountPaid"
  if (key === "F6") return "printReceipt" // Tally Receipt voucher → print/preview receipt
  if (key === "F7" && !ctrl && !alt) return "paymentMethod"
  if (key === "F8" && !ctrl) {
    return shift ? "holdSale" : "completeSale"
  }
  if (key === "F9" && !ctrl) return "saveOrder"
  if (key === "F10") return "resumeSale"

  return null
}

export const POS_SHORTCUT_CHEATSHEET: Array<{ keys: string; label: string }> = [
  { keys: "F3", label: "Item" },
  { keys: "F5", label: "Payment amt" },
  { keys: "F6", label: "Receipt" },
  { keys: "F7", label: "Pay method" },
  { keys: "F8", label: "Sales" },
  { keys: "Ctrl+A", label: "Accept" },
  { keys: "Alt+C", label: "Customer" },
  { keys: "Ctrl+D", label: "Del line" },
  { keys: "Alt+D", label: "Clear" },
  { keys: "F9", label: "Order" },
  { keys: "Ctrl+F8", label: "Credit" },
  { keys: "Shift+F8", label: "Hold" },
  { keys: "F10", label: "Resume" },
  { keys: "Alt+P", label: "Print" },
  { keys: "Esc", label: "Close" },
]

const HANDLER_BY_ACTION: Record<PosShortcutAction, keyof PosShortcutHandlers> = {
  close: "onClose",
  accept: "onCompleteSale",
  completeSale: "onCompleteSale",
  customer: "onCustomer",
  patient: "onPatientSearch",
  products: "onProductSearch",
  prescription: "onPrescription",
  amountPaid: "onAmountPaid",
  paymentMethod: "onPayment",
  holdSale: "onHoldSale",
  resumeSale: "onResumeSale",
  deleteLine: "onDeleteLine",
  clearCart: "onClearCart",
  printReceipt: "onPrintReceipt",
  creditMode: "onCreditMode",
  saveOrder: "onSaveOrder",
}

/** Actions that hand focus to another field; only these need the blur first. */
const FOCUS_MOVING_ACTIONS: ReadonlySet<PosShortcutAction> = new Set([
  "patient",
  "products",
  "amountPaid",
  "paymentMethod",
])

/**
 * A field that has focus owns every binding that would otherwise type a
 * character, so Ctrl+A stays select-all and Ctrl+D stays delete-word. Function
 * keys type nothing and keep working, as they do in Tally.
 */
export function fieldOwnsKeystroke(event: { key: string }): boolean {
  if (event.key === "Escape") return false
  return !/^F\d{1,2}$/.test(event.key)
}

/**
 * A function key that moves focus must first take it away from whatever input
 * held it, otherwise the barcode scanner types into the old field.
 */
function blurActiveInput() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  if (
    active.tagName === "INPUT" ||
    active.tagName === "TEXTAREA" ||
    active.tagName === "SELECT" ||
    active.isContentEditable
  ) {
    active.blur()
  }
}

/**
 * POS accelerators modelled on Tally.ERP 9 / TallyPrime voucher keys.
 * Never the only way to complete a sale — mouse/touch still works.
 */
export function usePosKeyboardShortcuts(handlers: PosShortcutHandlers) {
  // The handlers object is rebuilt on every render; keep the listener stable.
  const latest = useRef(handlers)
  useEffect(() => {
    latest.current = handlers
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      const action = resolvePosShortcut(event)
      if (!action) return
      const handler = latest.current[HANDLER_BY_ACTION[action]]
      if (!handler) return
      if (isEditableTarget(event.target) && fieldOwnsKeystroke(event)) return

      if (FOCUS_MOVING_ACTIONS.has(action)) blurActiveInput()
      event.preventDefault()
      handler()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
