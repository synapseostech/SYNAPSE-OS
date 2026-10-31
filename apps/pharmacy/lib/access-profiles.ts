import { accessSummary, type AccessGroup } from "@/lib/portal-nav"

/**
 * Legacy permission keys stored on pharmacy_user_settings.permissions, plus the
 * purchasing.manage capability. No legacy key maps to purchasing.manage, so it
 * has to be assignable on its own or the supplier and purchase-order routes
 * cannot be granted to a staff account.
 */
export type Permission =
  | "MANAGE_USERS"
  | "MANAGE_INVENTORY"
  | "VIEW_INVENTORY"
  | "MANAGE_POS"
  | "VIEW_TRANSACTIONS"
  | "MANAGE_TRANSACTIONS"
  | "MANAGE_SETTINGS"
  | "VIEW_REPORTS"
  | "CLAIM_ORDERS"
  | "purchasing.manage"

/** The three values the users API accepts for a pharmacy role. */
export type AccessRole = "ADMIN" | "CEO" | "STAFF"

export type AccessProfile = {
  id: string
  label: string
  description: string
  role: AccessRole
  permissions: Permission[]
}

export const ACCESS_PROFILES: AccessProfile[] = [
  {
    id: "ADMIN",
    label: "Pharmacy administrator",
    description: "Every pharmacy area, including settings, staff and the financial ledger.",
    role: "ADMIN",
    permissions: [],
  },
  {
    id: "SALES_STOCK",
    label: "Sales & stock clerk",
    description:
      "POS, inventory and purchasing only — no transactions, credit ledger, accounting, reports or refunds.",
    role: "STAFF",
    permissions: ["MANAGE_POS", "MANAGE_INVENTORY", "VIEW_INVENTORY", "purchasing.manage"],
  },
  {
    id: "CASHIER",
    label: "Cashier",
    description: "Sell at the POS and look up stock. No inventory edits or purchasing.",
    role: "STAFF",
    permissions: ["MANAGE_POS", "VIEW_INVENTORY"],
  },
  {
    id: "INVENTORY",
    label: "Inventory officer",
    description:
      "Stock, batches, suppliers and purchasing. The POS still opens: every staff account carries the cashier defaults.",
    role: "STAFF",
    permissions: ["MANAGE_INVENTORY", "VIEW_INVENTORY", "purchasing.manage"],
  },
]

/** Labels written for the person assigning access, not the database column. */
export const PERMISSION_LABELS: Record<Permission, string> = {
  MANAGE_POS: "Sell at the POS",
  VIEW_INVENTORY: "View stock levels",
  MANAGE_INVENTORY: "Edit stock, batches and prices",
  "purchasing.manage": "Manage suppliers and purchase orders",
  VIEW_TRANSACTIONS: "View transactions",
  MANAGE_TRANSACTIONS: "Issue refunds",
  VIEW_REPORTS: "View reports",
  MANAGE_SETTINGS: "Change pharmacy settings",
  MANAGE_USERS: "Manage staff accounts",
  CLAIM_ORDERS: "Claim incoming orders",
}

/**
 * Every permission an administrator can tick, grouped by the part of the shop
 * it belongs to. CLAIM_ORDERS is stored on older accounts but maps to pos.sell,
 * so it is not offered as a separate switch.
 */
export const PERMISSION_GROUPS: { label: string; permissions: Permission[] }[] = [
  {
    label: "Sales counter",
    permissions: ["MANAGE_POS", "VIEW_TRANSACTIONS", "MANAGE_TRANSACTIONS"],
  },
  {
    label: "Stock & purchasing",
    permissions: ["VIEW_INVENTORY", "MANAGE_INVENTORY", "purchasing.manage"],
  },
  {
    label: "Reporting & administration",
    permissions: ["VIEW_REPORTS", "MANAGE_SETTINGS", "MANAGE_USERS"],
  },
]

/** Roles arrive from the API as pharmacy_role values and from the form as AccessRole. */
export function accessRoleFromStored(role: string): AccessRole {
  const normalized = role.trim().toLowerCase()
  if (normalized === "pharmacy_admin" || normalized === "admin") return "ADMIN"
  if (normalized === "pharmacy_ceo" || normalized === "ceo") return "CEO"
  return "STAFF"
}

export function storedRoleForAccessRole(role: AccessRole): string {
  if (role === "ADMIN") return "pharmacy_admin"
  if (role === "CEO") return "pharmacy_ceo"
  return "pharmacy_staff"
}

export function accessRoleLabel(role: string): string {
  const normalized = accessRoleFromStored(role)
  if (normalized === "ADMIN") return "Administrator"
  if (normalized === "CEO") return "CEO (view only)"
  return "Staff"
}

/** The preset this role/permission pair matches, or "CUSTOM". */
export function profileKey(role: string, permissions: readonly string[]): string {
  const normalizedRole = accessRoleFromStored(role)
  const sorted = [...permissions].sort().join(",")
  return (
    ACCESS_PROFILES.find(
      (profile) =>
        profile.role === normalizedRole &&
        [...profile.permissions].sort().join(",") === sorted,
    )?.id ?? "CUSTOM"
  )
}

export function profileLabel(role: string, permissions: readonly string[]): string {
  const normalizedRole = accessRoleFromStored(role)
  if (normalizedRole === "CEO") return "CEO (view only)"
  const key = profileKey(normalizedRole, permissions)
  return ACCESS_PROFILES.find((profile) => profile.id === key)?.label ?? "Custom access"
}

export type AccessDescription = {
  profileLabel: string
  groups: AccessGroup[]
  areas: string[]
}

/**
 * The pages an account can actually open, resolved through the same gate the
 * sidebar uses. A profile's label alone does not tell an administrator what a
 * cashier sees, so the users list shows this instead of the raw role.
 */
export function describeAccess(role: string, permissions: readonly string[]): AccessDescription {
  const accessRole = accessRoleFromStored(role)
  const groups = accessSummary({
    isAdmin: accessRole === "ADMIN",
    pharmacyRole: storedRoleForAccessRole(accessRole),
    permissions: [...permissions],
  })
  return {
    profileLabel: profileLabel(accessRole, permissions),
    groups,
    areas: groups.flatMap((group) => group.items),
  }
}
