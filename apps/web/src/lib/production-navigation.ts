/**
 * Production-presented navigation. Route integrity tests fail if these
 * destinations are missing, roadmap, deprecated, or Demo-only.
 */

export type ProductionNavItem = {
  name: string
  href: string
  roles?: string[] | null
}

export function facilityClinicalNav(slug: string): ProductionNavItem[] {
  return [
    { name: "Dashboard", href: `/os/${slug}/dashboard` },
    { name: "Patients", href: `/os/${slug}/patients` },
    { name: "OPD queue", href: `/os/${slug}/clinical/queue` },
    { name: "Nursing", href: `/os/${slug}/clinical/nursing` },
    { name: "Billing", href: `/os/${slug}/billing` },
    { name: "Admissions", href: `/os/${slug}/admissions` },
    { name: "Timeline", href: `/os/${slug}/clinical/orders` },
    { name: "My Work", href: `/os/${slug}/clinical/tasks` },
    { name: "Dispense", href: `/os/${slug}/clinical/dispense` },
    { name: "Lab worklist", href: "/lab/orders" },
    { name: "Analyzer staging", href: "/lab/staging" },
    { name: "Instruments", href: "/lab/instruments" },
    { name: "Analyzer mappings", href: "/lab/mappings" },
    { name: "Specimens", href: "/lab/specimens" },
    { name: "Results", href: "/lab/results" },
    { name: "Verification", href: "/lab/verify" },
    { name: "People", href: "/hospital/admin/staff" },
    { name: "Departments", href: "/hospital/admin/departments" },
    { name: "Facility admin", href: "/hospital/admin" },
    { name: "Referrals", href: "/referrals" },
    { name: "Mortuary", href: "/mortuary" },
    { name: "Import", href: `/os/${slug}/migrate` },
  ]
}

export function appSidebarNav(tenantSlug?: string): ProductionNavItem[] {
  const base = tenantSlug ? `/os/${tenantSlug}` : "/os"
  return [
    { name: "Dashboard", href: `${base}/dashboard` },
    { name: "Doctor", href: tenantSlug ? `${base}/clinical/queue` : "/doctor" },
    { name: "Nursing", href: tenantSlug ? `${base}/clinical/nursing` : "/nurse" },
    { name: "Patients", href: `${base}/patients` },
    { name: "Laboratory", href: "/lab/orders" },
    { name: "Pharmacy", href: "/pharmacy/queue" },
    { name: "Inventory", href: "/admin/supply" },
    { name: "Encounters", href: `${base}/encounters/new` },
    { name: "Staff", href: "/hospital/admin/staff" },
    { name: "Activity", href: "/hospital/admin/audit" },
    { name: "Settings", href: "/hospital/admin/settings" },
  ]
}

export function hospitalAdminNav(): ProductionNavItem[] {
  return [
    { name: "Dashboard", href: "/hospital/admin" },
    { name: "Settings", href: "/hospital/admin/settings" },
    { name: "Departments", href: "/hospital/admin/departments" },
    { name: "Wards", href: "/hospital/admin/wards" },
    { name: "Beds", href: "/hospital/admin/beds" },
    { name: "Staff", href: "/hospital/admin/staff" },
    { name: "Modules", href: "/hospital/admin/modules" },
    { name: "Services", href: "/hospital/admin/services" },
    { name: "Audit Log", href: "/hospital/admin/audit" },
  ]
}

export function legacyOpsAdminNav(): ProductionNavItem[] {
  return [
    { name: "Dashboard", href: "/admin" },
    { name: "Staff", href: "/hospital/admin/staff" },
    { name: "Departments", href: "/hospital/admin/departments" },
    { name: "Beds", href: "/hospital/admin/beds" },
    { name: "HR", href: "/admin/hr" },
    { name: "Insurance", href: "/admin/insurance" },
    { name: "Finance", href: "/admin/finance" },
    { name: "Supply", href: "/admin/supply" },
    { name: "Lab", href: "/lab/orders" },
    { name: "Audit", href: "/admin/audit" },
    { name: "Account", href: "/admin/account" },
    { name: "Settings", href: "/hospital/admin/settings" },
  ]
}

export function doctorWorkspaceTabs(slug?: string | null): ProductionNavItem[] {
  const queue = slug ? `/os/${slug}/clinical/queue` : "/doctor"
  return [
    { name: "Queue", href: queue },
    { name: "Patients", href: slug ? `/os/${slug}/patients` : "/os" },
    { name: "Orders & billing", href: slug ? `/os/${slug}/clinical/orders` : "/doctor" },
    { name: "Nursing board", href: slug ? `/os/${slug}/clinical/nursing` : "/nurse" },
    { name: "Referrals", href: "/referrals" },
    { name: "Pathways", href: slug ? `/os/${slug}/encounters/new` : "/doctor" },
    { name: "Mortuary", href: "/mortuary" },
  ]
}

export function nurseWorkspaceTabs(slug?: string | null): ProductionNavItem[] {
  return [
    { name: "Board", href: slug ? `/os/${slug}/clinical/nursing` : "/nurse" },
    { name: "Vitals", href: "/nurse/vitals" },
    { name: "Ward", href: "/nurse/ward" },
    { name: "Patients", href: slug ? `/os/${slug}/patients` : "/os" },
    { name: "Queue", href: slug ? `/os/${slug}/clinical/queue` : "/doctor" },
  ]
}

export const PRODUCTION_NAV_SCAN_FILES = [
  "apps/web/src/lib/production-navigation.ts",
  "apps/web/src/components/AppSidebar.tsx",
  "apps/web/src/app/os/[slug]/layout.tsx",
  "apps/web/src/app/hospital/admin/layout.tsx",
  "apps/web/src/app/admin/layout.tsx",
  "apps/web/src/app/admin/settings/page.tsx",
  "apps/web/src/app/encounter/[id]/page.tsx",
]
