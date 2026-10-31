import { describe, expect, it } from "vitest"
import { isPharmacyCapability, resolveCapability } from "@/lib/capabilities"
import {
  ACCESS_PROFILES,
  accessRoleFromStored,
  describeAccess,
  profileKey,
  profileLabel,
} from "./access-profiles"
import { NAV_GROUPS } from "./portal-nav"

const areasFor = (role: string, permissions: string[]) =>
  describeAccess(role, permissions).areas

const sessionFor = (id: string) => {
  const profile = ACCESS_PROFILES.find((candidate) => candidate.id === id)
  if (!profile) throw new Error(`unknown profile ${id}`)
  return { role: profile.role, permissions: profile.permissions as string[] }
}

describe("access summary", () => {
  it("gives a cashier the counter and nothing from the ledger or admin", () => {
    const areas = areasFor(...(Object.values(sessionFor("CASHIER")) as [string, string[]]))
    expect(areas).toContain("POS")
    expect(areas).toContain("Customers")
    expect(areas).not.toContain("Transactions")
    expect(areas).not.toContain("Credit Ledger")
    expect(areas).not.toContain("Reports")
    expect(areas).not.toContain("Users")
    expect(areas).not.toContain("Settings")
    expect(areas).not.toContain("Orders")
    expect(areas).not.toContain("Tally Cut-over")
  })

  it("gives a sales & stock clerk inventory and purchasing but not the ledger", () => {
    const areas = areasFor(...(Object.values(sessionFor("SALES_STOCK")) as [string, string[]]))
    expect(areas).toContain("Inventory")
    expect(areas).toContain("Purchases")
    expect(areas).toContain("Suppliers")
    expect(areas).toContain("POS")
    expect(areas).not.toContain("Transactions")
    expect(areas).not.toContain("Credit Ledger")
    expect(areas).not.toContain("Users")
    // Admin-only pages stay closed to staff regardless of permissions.
    expect(areas).not.toContain("Tally Cut-over")
    expect(areas).not.toContain("Activity Log")
  })

  it("gives an inventory officer stock and purchasing", () => {
    const areas = areasFor(...(Object.values(sessionFor("INVENTORY")) as [string, string[]]))
    expect(areas).toContain("Inventory")
    expect(areas).toContain("Purchase Orders")
    expect(areas).not.toContain("Transactions")
    // pharmacy_staff normalises to the cashier role defaults in the auth table,
    // so POS opens for every staff account even without MANAGE_POS ticked.
    expect(areas).toContain("POS")
  })

  it("lets administrators and the CEO open every nav entry", () => {
    const everything = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.name))
    expect(areasFor(...(Object.values(sessionFor("ADMIN")) as [string, string[]]))).toEqual(everything)
    expect(areasFor("CEO", [])).toEqual(everything)
  })

  it("describes stored pharmacy_role values, not form labels", () => {
    expect(accessRoleFromStored("pharmacy_admin")).toBe("ADMIN")
    expect(accessRoleFromStored("pharmacy_ceo")).toBe("CEO")
    expect(accessRoleFromStored("pharmacy_staff")).toBe("STAFF")
    expect(accessRoleFromStored("")).toBe("STAFF")
  })

  it("matches a stored account back to its preset", () => {
    expect(profileKey("pharmacy_staff", ["MANAGE_POS", "VIEW_INVENTORY"])).toBe("CASHIER")
    expect(
      profileKey("pharmacy_staff", ["VIEW_INVENTORY", "purchasing.manage", "MANAGE_INVENTORY", "MANAGE_POS"]),
    ).toBe("SALES_STOCK")
    expect(profileKey("pharmacy_admin", [])).toBe("ADMIN")
    expect(profileKey("pharmacy_staff", ["MANAGE_POS"])).toBe("CUSTOM")
    expect(profileLabel("pharmacy_staff", ["MANAGE_POS"])).toBe("Custom access")
  })
})

describe("nav permissions", () => {
  it("every gated entry names a capability the auth table knows", () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (!item.permission) continue
        expect(
          isPharmacyCapability(item.permission) || resolveCapability(item.permission) !== null,
          `${item.name} uses unknown permission ${item.permission}`,
        ).toBe(true)
      }
    }
  })
})
