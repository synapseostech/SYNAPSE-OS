import { describe, expect, it } from "vitest"
import {
  PORTAL_SHORTCUTS,
  availableShortcuts,
  getShortcut,
  isEditableTarget,
  isPosRoute,
  resolvePortalShortcut,
  type PortalShortcut,
} from "./registry"

function press(
  key: string,
  mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }> = {},
) {
  return {
    key,
    ctrlKey: Boolean(mods.ctrlKey),
    metaKey: Boolean(mods.metaKey),
    altKey: Boolean(mods.altKey),
    shiftKey: Boolean(mods.shiftKey),
  }
}

function idFor(key: string, mods?: Parameters<typeof press>[1]) {
  return resolvePortalShortcut(press(key, mods))?.id ?? null
}

describe("resolvePortalShortcut", () => {
  it("maps the plain function keys to their Tally destinations", () => {
    expect(idFor("F2")).toBe("dashboard")
    expect(idFor("F3")).toBe("inventory")
    expect(idFor("F4")).toBe("contra")
    expect(idFor("F5")).toBe("payment")
    expect(idFor("F6")).toBe("receipt")
    expect(idFor("F7")).toBe("journal")
    expect(idFor("F8")).toBe("sales")
    expect(idFor("F9")).toBe("purchase")
    expect(idFor("F10")).toBe("reports")
  })

  it("opens help from F1 or Alt+H and the palette from Ctrl/Cmd+K", () => {
    expect(idFor("F1")).toBe("help")
    expect(idFor("h", { altKey: true })).toBe("help")
    expect(idFor("k", { ctrlKey: true })).toBe("palette")
    expect(idFor("K", { metaKey: true })).toBe("palette")
  })

  it("leaves modified function keys and F11/F12 alone", () => {
    expect(idFor("F8", { ctrlKey: true })).toBeNull()
    expect(idFor("F8", { shiftKey: true })).toBeNull()
    expect(idFor("F5", { altKey: true })).toBeNull()
    expect(idFor("F11")).toBeNull()
    expect(idFor("F12")).toBeNull()
    expect(idFor("x")).toBeNull()
  })

  it("routes the voucher keys at the accounting form", () => {
    expect(getShortcut("contra")?.href).toBe("/portal/accounting?voucher=contra")
    expect(getShortcut("payment")?.href).toBe("/portal/accounting?voucher=payment")
    expect(getShortcut("receipt")?.href).toBe("/portal/accounting?voucher=receipt")
    expect(getShortcut("journal")?.href).toBe("/portal/accounting?voucher=journal")
  })

  it("keeps function keys live inside inputs but not character shortcuts", () => {
    expect(getShortcut("payment")?.allowInEditable).toBe(true)
    expect(getShortcut("help")?.allowInEditable).toBe(true)
    expect(Boolean(getShortcut("palette")?.allowInEditable)).toBe(false)
    expect(PORTAL_SHORTCUTS.filter((shortcut) => shortcut.allowInEditable)).toHaveLength(
      PORTAL_SHORTCUTS.length - 1,
    )
  })
})

describe("availableShortcuts", () => {
  it("drops shortcuts the session cannot use", () => {
    const allowed = new Set(["reports.financial"])
    const shortcutIds = availableShortcuts((shortcut: PortalShortcut) =>
      shortcut.capability ? allowed.has(shortcut.capability) : true,
    ).map((shortcut) => shortcut.id)

    expect(shortcutIds).toContain("payment")
    expect(shortcutIds).toContain("dashboard")
    expect(shortcutIds).not.toContain("inventory")
    expect(shortcutIds).not.toContain("sales")
  })
})

describe("isEditableTarget", () => {
  it("treats form controls and contenteditable as editable", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true)
    expect(isEditableTarget({ tagName: "SELECT" } as unknown as EventTarget)).toBe(true)
    expect(
      isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    ).toBe(true)
  })

  it("ignores document elements and missing targets", () => {
    expect(isEditableTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe("isPosRoute", () => {
  it("covers the POS screen and its sub paths only", () => {
    expect(isPosRoute("/portal/pos")).toBe(true)
    expect(isPosRoute("/portal/pos/receipt")).toBe(true)
    expect(isPosRoute("/portal/possession")).toBe(false)
    expect(isPosRoute("/portal/dashboard")).toBe(false)
    expect(isPosRoute(null)).toBe(false)
  })
})
