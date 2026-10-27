/**
 * Portal-wide accelerators modelled on TallyPrime's voucher keys.
 * Pure data plus a resolver, so the hook, the help overlay and the command
 * palette all read the same table and cannot drift apart.
 *
 * F11 and F12 are left to the browser; F1 is claimed for help because the
 * browser's own help page is not useful to a cashier.
 */

export type PortalShortcutId =
  | "help"
  | "palette"
  | "dashboard"
  | "inventory"
  | "contra"
  | "payment"
  | "receipt"
  | "journal"
  | "sales"
  | "purchase"
  | "reports"

export type PortalShortcutGroup = "Navigate" | "Vouchers" | "Help"

export type ShortcutKeystroke = {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export type PortalShortcut = {
  id: PortalShortcutId
  label: string
  hint: string
  /** Display form of each binding, e.g. ["F5"] or ["Ctrl+K"]. */
  keys: string[]
  group: PortalShortcutGroup
  href?: string
  overlay?: "help" | "palette"
  capability?: string
  adminOnly?: boolean
  /**
   * Function keys type nothing, so they stay live while an input has focus —
   * F5 in a voucher description should open a payment voucher, not reload the
   * page. Character bindings are skipped in inputs so they never eat typing.
   */
  allowInEditable?: boolean
  matches: (event: ShortcutKeystroke) => boolean
}

function plain(event: ShortcutKeystroke, key: string): boolean {
  return (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    event.key === key
  )
}

function letter(event: ShortcutKeystroke): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key
}

function withCommand(event: ShortcutKeystroke, key: string): boolean {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && letter(event) === key
}

function withAlt(event: ShortcutKeystroke, key: string): boolean {
  return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && letter(event) === key
}

export const PORTAL_SHORTCUTS: PortalShortcut[] = [
  {
    id: "palette",
    label: "Command palette",
    hint: "Search every page you can open",
    keys: ["Ctrl+K"],
    group: "Help",
    overlay: "palette",
    matches: (event) => withCommand(event, "k"),
  },
  {
    id: "help",
    label: "Keyboard shortcuts",
    hint: "Show this list",
    keys: ["F1", "Alt+H"],
    group: "Help",
    overlay: "help",
    allowInEditable: true,
    matches: (event) => plain(event, "F1") || withAlt(event, "h"),
  },
  {
    id: "dashboard",
    label: "Dashboard",
    hint: "Open the pharmacy dashboard",
    keys: ["F2"],
    group: "Navigate",
    href: "/portal/dashboard",
    allowInEditable: true,
    matches: (event) => plain(event, "F2"),
  },
  {
    id: "inventory",
    label: "Inventory",
    hint: "Open stock and batches",
    keys: ["F3"],
    group: "Navigate",
    href: "/portal/inventory",
    capability: "MANAGE_INVENTORY",
    allowInEditable: true,
    matches: (event) => plain(event, "F3"),
  },
  {
    id: "contra",
    label: "Contra voucher",
    hint: "Move money between cash and bank accounts",
    keys: ["F4"],
    group: "Vouchers",
    href: "/portal/accounting?voucher=contra",
    capability: "reports.financial",
    allowInEditable: true,
    matches: (event) => plain(event, "F4"),
  },
  {
    id: "payment",
    label: "Payment voucher",
    hint: "Pay a supplier or expense",
    keys: ["F5"],
    group: "Vouchers",
    href: "/portal/accounting?voucher=payment",
    capability: "reports.financial",
    allowInEditable: true,
    matches: (event) => plain(event, "F5"),
  },
  {
    id: "receipt",
    label: "Receipt voucher",
    hint: "Record money received",
    keys: ["F6"],
    group: "Vouchers",
    href: "/portal/accounting?voucher=receipt",
    capability: "reports.financial",
    allowInEditable: true,
    matches: (event) => plain(event, "F6"),
  },
  {
    id: "journal",
    label: "Journal voucher",
    hint: "Post an adjustment or opening entry",
    keys: ["F7"],
    group: "Vouchers",
    href: "/portal/accounting?voucher=journal",
    capability: "reports.financial",
    allowInEditable: true,
    matches: (event) => plain(event, "F7"),
  },
  {
    id: "sales",
    label: "Sales / POS",
    hint: "Go to the point of sale",
    keys: ["F8"],
    group: "Navigate",
    href: "/portal/pos",
    capability: "MANAGE_POS",
    allowInEditable: true,
    matches: (event) => plain(event, "F8"),
  },
  {
    id: "purchase",
    label: "Purchases",
    hint: "Record and review supplier purchases",
    keys: ["F9"],
    group: "Navigate",
    href: "/portal/purchases",
    capability: "MANAGE_INVENTORY",
    allowInEditable: true,
    matches: (event) => plain(event, "F9"),
  },
  {
    id: "reports",
    label: "Reports",
    hint: "Open the reporting hub",
    keys: ["F10"],
    group: "Navigate",
    href: "/portal/reports",
    capability: "VIEW_REPORTS",
    allowInEditable: true,
    matches: (event) => plain(event, "F10"),
  },
]

export const SHORTCUT_GROUPS: PortalShortcutGroup[] = ["Navigate", "Vouchers", "Help"]

export function getShortcut(id: PortalShortcutId): PortalShortcut | undefined {
  return PORTAL_SHORTCUTS.find((shortcut) => shortcut.id === id)
}

/** First matching binding, or null when the keystroke is not an accelerator. */
export function resolvePortalShortcut(event: ShortcutKeystroke): PortalShortcut | null {
  return PORTAL_SHORTCUTS.find((shortcut) => shortcut.matches(event)) ?? null
}

export function availableShortcuts(
  canUse: (shortcut: PortalShortcut) => boolean,
): PortalShortcut[] {
  return PORTAL_SHORTCUTS.filter(canUse)
}

/** The POS owns the keyboard; portal accelerators must not steal F-keys there. */
export function isPosRoute(pathname: string | null | undefined): boolean {
  if (!pathname) return false
  return pathname === "/portal/pos" || pathname.startsWith("/portal/pos/")
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false
  const element = target as HTMLElement
  if (typeof element.tagName !== "string") return false
  if (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT") {
    return true
  }
  return element.isContentEditable === true
}
