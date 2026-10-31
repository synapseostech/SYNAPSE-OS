import type { LucideIcon } from "lucide-react"
import {
  LayoutDashboard, Users, Package, ShoppingCart, DollarSign,
  UserCheck, ClipboardList, MessageSquare, Activity, Truck, FileText,
  BarChart3, RotateCcw, Wifi, CalendarClock, WalletCards, BrainCircuit,
  CreditCard, Building2, ShoppingBag, BookOpen, FileSpreadsheet,
  Settings,
} from "lucide-react"
import { sessionHasCapability, type CapabilitySession } from "@/lib/capabilities"

/**
 * The portal's navigation is also the definition of what an account can open.
 * The sidebar, the command palette and the per-user access summary in
 * Settings → Users all read this table, so a page can never be described as
 * accessible when the sidebar hides it (or the other way round).
 */
export type PortalNavItem = {
  name: string
  href: string
  icon: LucideIcon
  permission?: string
  adminOnly?: boolean
}

export type PortalNavGroup = {
  label: string
  items: PortalNavItem[]
}

export const NAV_GROUPS: PortalNavGroup[] = [
  {
    label: "Main",
    items: [
      { name: "Dashboard", href: "/portal/dashboard", icon: LayoutDashboard },
    ],
  },
  {
    label: "Inventory",
    items: [
      { name: "Inventory",        href: "/portal/inventory",        icon: Package,         permission: "MANAGE_INVENTORY" },
      { name: "Import Assistant", href: "/portal/import-assistant", icon: BrainCircuit,    permission: "MANAGE_INVENTORY" },
      { name: "Tally Cut-over",   href: "/portal/tally-import",     icon: FileSpreadsheet, permission: "MANAGE_INVENTORY", adminOnly: true },
    ],
  },
  {
    label: "Purchases",
    items: [
      { name: "Purchases",       href: "/portal/purchases",       icon: ShoppingBag, permission: "MANAGE_INVENTORY" },
      { name: "Purchase Orders", href: "/portal/purchase-orders", icon: FileText,    permission: "MANAGE_INVENTORY" },
      { name: "Suppliers",       href: "/portal/suppliers",       icon: Truck,       permission: "MANAGE_INVENTORY" },
    ],
  },
  {
    label: "Sales",
    items: [
      { name: "POS",       href: "/portal/pos",       icon: ShoppingCart,  permission: "MANAGE_POS" },
      { name: "Till",      href: "/portal/till",      icon: WalletCards,   permission: "MANAGE_POS" },
      // Every handler on /api/admin/orders is admin-only, so a cashier could
      // open this page and 403 on load.
      { name: "Orders",    href: "/portal/orders",    icon: ClipboardList, adminOnly: true },
      { name: "Clinical Rx", href: "/portal/clinical-prescriptions", icon: ClipboardList, permission: "MANAGE_POS" },
      { name: "Customers", href: "/portal/customers", icon: UserCheck,     permission: "MANAGE_POS" },
      { name: "Refills",   href: "/portal/refills",   icon: CalendarClock, permission: "MANAGE_POS" },
    ],
  },
  {
    label: "Finance",
    items: [
      { name: "Billing",         href: "/portal/billing",       icon: CreditCard,  adminOnly: true },
      { name: "Transactions",    href: "/portal/transactions",  icon: DollarSign,  permission: "VIEW_TRANSACTIONS" },
      // The ledger API checks customers.credit, not reports.operational.
      { name: "Credit Ledger",   href: "/portal/credit-ledger", icon: WalletCards, permission: "customers.credit" },
      { name: "Accounting",      href: "/portal/accounting",    icon: BookOpen,    permission: "reports.financial" },
      { name: "Refunds",         href: "/portal/refunds",       icon: RotateCcw,   permission: "MANAGE_TRANSACTIONS" },
      { name: "Reports",         href: "/portal/reports",       icon: BarChart3,   permission: "VIEW_REPORTS" },
    ],
  },
  {
    label: "Admin",
    items: [
      { name: "Users",        href: "/portal/users",        icon: Users,         permission: "MANAGE_USERS" },
      { name: "Branches",     href: "/portal/branches",     icon: Building2,     permission: "MANAGE_SETTINGS" },
      { name: "Network",      href: "/portal/network",      icon: Wifi,          permission: "MANAGE_SETTINGS" },
      { name: "Inquiries",    href: "/portal/inquiries",    icon: MessageSquare, adminOnly: true },
      { name: "Activity Log", href: "/portal/activity-log", icon: Activity,      adminOnly: true },
      { name: "Settings",     href: "/portal/settings",     icon: Settings,      permission: "MANAGE_SETTINGS" },
    ],
  },
]

export const BOTTOM_TABS = [
  { name: "Dashboard", href: "/portal/dashboard", icon: LayoutDashboard },
  { name: "Inventory", href: "/portal/inventory", icon: Package },
  { name: "POS",       href: "/portal/pos",       icon: ShoppingCart },
  { name: "Orders",    href: "/portal/orders",    icon: ClipboardList },
]

/**
 * The single visibility rule for a nav entry: admins and CEOs see everything
 * flagged adminOnly, everyone else needs the capability behind the entry.
 */
export function canOpenNavItem(
  session: CapabilitySession | null | undefined,
  item: Pick<PortalNavItem, "permission" | "adminOnly">,
): boolean {
  if (!session) return false
  if (item.adminOnly) {
    return Boolean(
      session.isAdmin ||
        session.pharmacyRole === "pharmacy_admin" ||
        session.pharmacyRole === "pharmacy_ceo",
    )
  }
  if (!item.permission) return true
  return sessionHasCapability(session, item.permission)
}

export type AccessGroup = { label: string; items: string[] }

/** What this session may open, grouped the way the sidebar groups it. */
export function accessSummary(session: CapabilitySession | null | undefined): AccessGroup[] {
  if (!session) return []
  return NAV_GROUPS.map((group) => ({
    label: group.label,
    items: group.items
      .filter((item) => canOpenNavItem(session, item))
      .map((item) => item.name),
  })).filter((group) => group.items.length > 0)
}
