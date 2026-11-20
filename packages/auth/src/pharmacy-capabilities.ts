/**
 * Canonical Pharmacy capability grants.
 * Mobile BFF and Pharmacy portal must use this table — do not keep a second role matrix.
 */

export const PHARMACY_CAPABILITIES = [
  "pos.sell",
  "pos.discount_limited",
  "pos.discount_override",
  "pos.refund",
  "shift.open_close",
  "shift.view_own",
  "shift.approve_variance",
  "inventory.read",
  "inventory.write",
  "inventory.adjust",
  "purchasing.manage",
  "rx.verify",
  "rx.dispense",
  "customers.credit",
  "reports.operational",
  "reports.financial",
  "staff.manage",
  "settings.manage",
  "audit.read",
] as const

export type PharmacyCapability = (typeof PHARMACY_CAPABILITIES)[number]

export type PharmacyCapabilityRole =
  | "pharmacy_cashier"
  | "pharmacist"
  | "inventory_officer"
  | "pharmacy_store_manager"
  | "finance"
  | "pharmacy_admin"
  | "pharmacy_ceo"

export const LEGACY_PERMISSION_TO_CAPABILITY: Record<string, PharmacyCapability> = {
  MANAGE_POS: "pos.sell",
  VIEW_INVENTORY: "inventory.read",
  MANAGE_INVENTORY: "inventory.write",
  VIEW_TRANSACTIONS: "reports.operational",
  MANAGE_TRANSACTIONS: "pos.refund",
  VIEW_REPORTS: "reports.operational",
  MANAGE_SETTINGS: "settings.manage",
  MANAGE_USERS: "staff.manage",
  CLAIM_ORDERS: "pos.sell",
}

const ROLE_ALIASES: Record<string, PharmacyCapabilityRole> = {
  cashier: "pharmacy_cashier",
  pharmacy_staff: "pharmacy_cashier",
  pharmacy_owner: "pharmacy_admin",
  inventory: "inventory_officer",
  store_manager: "pharmacy_store_manager",
}

const ALL = [...PHARMACY_CAPABILITIES]

export const ROLE_CAPABILITIES: Record<PharmacyCapabilityRole, readonly PharmacyCapability[]> = {
  pharmacy_cashier: [
    "pos.sell",
    "pos.discount_limited",
    "shift.open_close",
    "shift.view_own",
    "inventory.read",
  ],
  pharmacist: [
    "pos.sell",
    "pos.discount_limited",
    // A pharmacist who sells counts their own cash, the same as a cashier.
    // Without these the portal refused them a till while still letting them sell,
    // so their cash sales attached to no session and never reconciled.
    "shift.open_close",
    "shift.view_own",
    "rx.verify",
    "rx.dispense",
    "inventory.read",
    "inventory.write",
    "inventory.adjust",
    "purchasing.manage",
    "reports.operational",
  ],
  inventory_officer: [
    "inventory.read",
    "inventory.write",
    "inventory.adjust",
    "purchasing.manage",
    "reports.operational",
  ],
  pharmacy_store_manager: [
    "pos.sell",
    "pos.discount_limited",
    "pos.discount_override",
    "pos.refund",
    "shift.open_close",
    "shift.approve_variance",
    "inventory.read",
    "inventory.write",
    "inventory.adjust",
    "purchasing.manage",
    "rx.verify",
    "rx.dispense",
    "customers.credit",
    "reports.operational",
    "reports.financial",
    "staff.manage",
    "audit.read",
  ],
  finance: [
    "pos.refund",
    "shift.approve_variance",
    "customers.credit",
    "reports.operational",
    "reports.financial",
    "audit.read",
  ],
  pharmacy_admin: ALL,
  pharmacy_ceo: ALL,
}

export function normalizePharmacyRole(role: string | null | undefined): string {
  const raw = (role ?? "").trim()
  if (!raw) return ""
  return ROLE_ALIASES[raw] ?? raw
}

export function isPharmacyCapability(value: string): value is PharmacyCapability {
  return (PHARMACY_CAPABILITIES as readonly string[]).includes(value)
}

export function resolveCapability(permission: string): PharmacyCapability | null {
  if (isPharmacyCapability(permission)) return permission
  return LEGACY_PERMISSION_TO_CAPABILITY[permission] ?? null
}

export function capabilitiesForRole(role: string): readonly PharmacyCapability[] {
  const normalized = normalizePharmacyRole(role)
  if (normalized in ROLE_CAPABILITIES) {
    return ROLE_CAPABILITIES[normalized as PharmacyCapabilityRole]
  }
  return []
}

export function roleHasCapability(role: string, capability: PharmacyCapability): boolean {
  const normalized = normalizePharmacyRole(role)
  if (normalized === "pharmacy_admin" || normalized === "pharmacy_ceo") return true
  return capabilitiesForRole(normalized).includes(capability)
}

export type CapabilitySession = {
  isAdmin?: boolean
  pharmacyRole?: string | null
  role?: string | null
  permissions?: string[] | null
}

export function sessionHasCapability(session: CapabilitySession, permission: string): boolean {
  if (session.isAdmin) return true

  const role = normalizePharmacyRole(session.pharmacyRole || session.role)
  if (role === "pharmacy_admin" || role === "pharmacy_ceo") return true

  const capability = resolveCapability(permission)
  if (!capability) {
    return (session.permissions ?? []).includes(permission)
  }

  if (roleHasCapability(role, capability)) return true

  const grants = session.permissions ?? []
  if (grants.includes(capability)) return true
  for (const [legacy, mapped] of Object.entries(LEGACY_PERMISSION_TO_CAPABILITY)) {
    if (mapped === capability && grants.includes(legacy)) return true
  }
  return false
}

export function sessionHasAnyCapability(session: CapabilitySession, permissions: string[]): boolean {
  return permissions.some((p) => sessionHasCapability(session, p))
}
