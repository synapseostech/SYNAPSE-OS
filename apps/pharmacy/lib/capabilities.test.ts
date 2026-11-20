import { describe, expect, it } from "vitest"
import {
  roleHasCapability,
  capabilitiesForRole,
  sessionHasCapability,
  resolveCapability,
} from "./capabilities"

describe("pharmacy capabilities", () => {
  it("lets cashiers sell but not adjust inventory", () => {
    expect(roleHasCapability("pharmacy_cashier", "pos.sell")).toBe(true)
    expect(roleHasCapability("pharmacy_cashier", "inventory.adjust")).toBe(false)
  })

  it("lets pharmacists verify prescriptions", () => {
    expect(roleHasCapability("pharmacist", "rx.verify")).toBe(true)
    expect(roleHasCapability("pharmacist", "settings.manage")).toBe(false)
  })

  it("lets pharmacists record purchases and receive stock, but not cashiers", () => {
    expect(roleHasCapability("pharmacist", "purchasing.manage")).toBe(true)
    expect(roleHasCapability("inventory_officer", "purchasing.manage")).toBe(true)
    expect(roleHasCapability("pharmacist", "inventory.adjust")).toBe(true)
    expect(roleHasCapability("pharmacy_cashier", "purchasing.manage")).toBe(false)
    expect(roleHasCapability("pharmacy_cashier", "inventory.adjust")).toBe(false)
    expect(roleHasCapability("pharmacy_cashier", "inventory.write")).toBe(false)
  })

  it("lets every selling role run its own till, without supervisor rights", () => {
    for (const role of ["pharmacy_cashier", "pharmacy_staff", "cashier", "pharmacist", "pharmacy_store_manager"]) {
      expect(roleHasCapability(role, "pos.sell")).toBe(true)
      expect(roleHasCapability(role, "shift.open_close")).toBe(true)
    }
    expect(roleHasCapability("pharmacist", "shift.approve_variance")).toBe(false)
    expect(roleHasCapability("pharmacist", "pos.refund")).toBe(false)
    expect(roleHasCapability("pharmacy_cashier", "pos.refund")).toBe(false)
    expect(roleHasCapability("inventory_officer", "pos.sell")).toBe(false)
    expect(roleHasCapability("inventory_officer", "shift.open_close")).toBe(false)
  })

  it("grants owners all capabilities", () => {
    expect(roleHasCapability("pharmacy_admin", "settings.manage")).toBe(true)
    expect(capabilitiesForRole("pharmacy_admin").length).toBeGreaterThan(10)
  })

  it("maps legacy MANAGE_POS to pos.sell", () => {
    expect(resolveCapability("MANAGE_POS")).toBe("pos.sell")
    expect(
      sessionHasCapability(
        { pharmacyRole: "pharmacy_cashier", permissions: ["MANAGE_POS"], isAdmin: false },
        "pos.sell",
      ),
    ).toBe(true)
  })

  it("honors explicit capability grants on a weak role", () => {
    expect(
      sessionHasCapability(
        {
          pharmacyRole: "pharmacy_cashier",
          permissions: ["inventory.adjust"],
          isAdmin: false,
        },
        "inventory.adjust",
      ),
    ).toBe(true)
  })

  it("aliases cashier → pharmacy_cashier", () => {
    expect(roleHasCapability("cashier", "pos.sell")).toBe(true)
  })
})
