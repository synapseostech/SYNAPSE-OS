import { describe, expect, it } from "vitest"
import { fieldOwnsKeystroke, resolvePosShortcut } from "./keyboard"

function key(
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

describe("resolvePosShortcut (Tally parity)", () => {
  it("maps Ctrl+A and Ctrl+Enter to accept", () => {
    expect(resolvePosShortcut(key("a", { ctrlKey: true }))).toBe("accept")
    expect(resolvePosShortcut(key("Enter", { ctrlKey: true }))).toBe("accept")
  })

  it("maps F8 to sales complete and Shift+F8 to hold", () => {
    expect(resolvePosShortcut(key("F8"))).toBe("completeSale")
    expect(resolvePosShortcut(key("F8", { shiftKey: true }))).toBe("holdSale")
  })

  it("maps F5/F6/F7 voucher keys", () => {
    expect(resolvePosShortcut(key("F5"))).toBe("amountPaid")
    expect(resolvePosShortcut(key("F6"))).toBe("printReceipt")
    expect(resolvePosShortcut(key("F7"))).toBe("paymentMethod")
  })

  it("maps Alt+C customer, Ctrl+D line delete, Alt+D clear", () => {
    expect(resolvePosShortcut(key("c", { altKey: true }))).toBe("customer")
    expect(resolvePosShortcut(key("d", { ctrlKey: true }))).toBe("deleteLine")
    expect(resolvePosShortcut(key("d", { altKey: true }))).toBe("clearCart")
  })

  it("maps Ctrl+F8 to credit mode and F9 to save order", () => {
    expect(resolvePosShortcut(key("F8", { ctrlKey: true }))).toBe("creditMode")
    expect(resolvePosShortcut(key("F9"))).toBe("saveOrder")
  })

  it("ignores unrelated keys", () => {
    expect(resolvePosShortcut(key("x"))).toBeNull()
  })
})

describe("fieldOwnsKeystroke", () => {
  it("leaves character and command bindings to a focused field", () => {
    expect(fieldOwnsKeystroke({ key: "a" })).toBe(true)
    expect(fieldOwnsKeystroke({ key: "Enter" })).toBe(true)
    expect(fieldOwnsKeystroke({ key: "Backspace" })).toBe(true)
  })

  it("keeps function keys and Escape live while typing", () => {
    expect(fieldOwnsKeystroke({ key: "F5" })).toBe(false)
    expect(fieldOwnsKeystroke({ key: "F8" })).toBe(false)
    expect(fieldOwnsKeystroke({ key: "F10" })).toBe(false)
    expect(fieldOwnsKeystroke({ key: "Escape" })).toBe(false)
  })
})
