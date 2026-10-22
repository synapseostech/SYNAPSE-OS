"use client"

import { useRouter, usePathname } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import {
  LayoutDashboard, Users, Package, ShoppingCart, DollarSign,
  Settings, LogOut, Menu, X, UserCheck, ClipboardList,
  MessageSquare, Activity, Truck, FileText, BarChart3,
  RotateCcw, Wifi, WifiOff, CalendarClock, WalletCards, BrainCircuit,
  CreditCard, UserCircle, Building2, ShoppingBag,
  BookOpen,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { NotificationBell } from "@/components/ui/notification-bell"
import { IdleLogoutModal } from "@/components/idle-logout-modal"
import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { sessionHasCapability } from "@/lib/capabilities"
import { SkipLink, SynapseThemeToggle } from "@synapse/ui"
import PortalProviders from "./providers"

export const dynamic = "force-dynamic"

const NAV_GROUPS = [
  {
    label: 'Main',
    items: [
      { name: 'Dashboard', href: '/portal/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { name: 'Inventory',        href: '/portal/inventory',        icon: Package,      permission: 'MANAGE_INVENTORY' },
      { name: 'Import Assistant', href: '/portal/import-assistant', icon: BrainCircuit, permission: 'MANAGE_INVENTORY' },
    ],
  },
  {
    label: 'Purchases',
    items: [
      { name: 'Purchases',        href: '/portal/purchases',        icon: ShoppingBag,  permission: 'MANAGE_INVENTORY' },
      { name: 'Purchase Orders',  href: '/portal/purchase-orders',  icon: FileText,     permission: 'MANAGE_INVENTORY' },
      { name: 'Suppliers',        href: '/portal/suppliers',        icon: Truck,        permission: 'MANAGE_INVENTORY' },
    ],
  },
  {
    label: 'Sales',
    items: [
      { name: 'POS',       href: '/portal/pos',       icon: ShoppingCart,  permission: 'MANAGE_POS' },
      { name: 'Till',      href: '/portal/till',      icon: WalletCards,   permission: 'MANAGE_POS' },
      { name: 'Orders',    href: '/portal/orders',    icon: ClipboardList, permission: 'MANAGE_POS' },
      { name: 'Clinical Rx', href: '/portal/clinical-prescriptions', icon: ClipboardList, permission: 'MANAGE_POS' },
      { name: 'Customers', href: '/portal/customers', icon: UserCheck,     permission: 'MANAGE_POS' },
      { name: 'Refills',   href: '/portal/refills',   icon: CalendarClock, permission: 'MANAGE_POS' },
    ],
  },
  {
    label: 'Finance',
    items: [
      { name: 'Billing',         href: '/portal/billing',       icon: CreditCard,    adminOnly: true },
      { name: 'Transactions',  href: '/portal/transactions',  icon: DollarSign,  permission: 'VIEW_TRANSACTIONS' },
      { name: 'Credit Ledger', href: '/portal/credit-ledger', icon: WalletCards, permission: 'VIEW_TRANSACTIONS' },
      { name: 'Accounting', href: '/portal/accounting', icon: BookOpen, permission: 'reports.financial' },
      { name: 'Refunds',       href: '/portal/refunds',       icon: RotateCcw,   permission: 'MANAGE_TRANSACTIONS' },
      { name: 'Reports',       href: '/portal/reports',       icon: BarChart3,   permission: 'VIEW_REPORTS' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { name: 'Users',        href: '/portal/users',        icon: Users,         permission: 'MANAGE_USERS' },
      { name: 'Branches',     href: '/portal/branches',     icon: Building2,     permission: 'MANAGE_SETTINGS' },
      { name: 'Network',      href: '/portal/network',      icon: Wifi,          permission: 'MANAGE_SETTINGS' },
      { name: 'Inquiries',    href: '/portal/inquiries',    icon: MessageSquare, adminOnly: true },
      { name: 'Activity Log', href: '/portal/activity-log', icon: Activity,      adminOnly: true },
      { name: 'Settings',     href: '/portal/settings',     icon: Settings,      permission: 'MANAGE_SETTINGS' },
    ],
  },
]

const BOTTOM_TABS = [
  { name: 'Dashboard', href: '/portal/dashboard',  icon: LayoutDashboard },
  { name: 'Inventory', href: '/portal/inventory',  icon: Package },
  { name: 'POS',       href: '/portal/pos',        icon: ShoppingCart },
  { name: 'Orders',    href: '/portal/orders',     icon: ClipboardList },
]

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <PortalProviders>
      <PortalShell>{children}</PortalShell>
    </PortalProviders>
  )
}

function PortalShell({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = usePharmacySession()
  const pathname = usePathname()
  const router = useRouter()
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  useEffect(() => {
    setIsOnline(navigator.onLine)
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline) }
  }, [])

  const hasPermission = (permission?: string, adminOnly?: boolean) => {
    if (!user) return false
    const isAdminRole =
      user.pharmacyRole === "pharmacy_admin" ||
      user.pharmacyRole === "pharmacy_ceo" ||
      user.isAdmin
    if (adminOnly) return isAdminRole
    if (!permission) return true
    return sessionHasCapability(
      {
        isAdmin: user.isAdmin,
        pharmacyRole: user.pharmacyRole,
        permissions: user.permissions,
      },
      permission,
    )
  }

  const handleSignOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    router.push("/login")
    router.refresh()
  }

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (!user) {
    router.replace("/login")
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-8 h-8 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  const displayName = user?.fullName ?? user?.email ?? "User"
  const roleLabel = user?.pharmacyRole?.replace("pharmacy_", "").toUpperCase() ?? "STAFF"

  const handleExitImpersonation = async () => {
    await fetch("/api/auth/impersonate/exit", { method: "POST" }).catch(() => {})
    window.close()
    // If close() doesn't work (tab wasn't opened by script), redirect to platform
    window.location.href = "https://synapseos.tech/platform/users"
  }

  return (
    <div className="min-h-screen bg-background">
      <SkipLink href="#main" />
      <IdleLogoutModal />

      {/* Impersonation banner */}
      {user?.isImpersonation && (
        <div className="fixed top-0 inset-x-0 z-[100] flex items-center justify-between gap-3 bg-amber-500 px-4 py-2 text-sm font-medium text-black">
          <span>
            Viewing as <strong>{displayName}</strong> · Platform admin impersonation session
          </span>
          <button
            type="button"
            onClick={handleExitImpersonation}
            className="shrink-0 rounded-md border border-black/20 bg-black/10 px-3 py-1 text-xs font-semibold hover:bg-black/20"
          >
            Exit impersonation
          </button>
        </div>
      )}

      {isSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed left-0 z-50 h-screen w-64 border-r border-border bg-card flex flex-col transition-transform duration-300 lg:translate-x-0",
        user?.isImpersonation ? "top-10" : "top-0",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Logo */}
        <div className="flex items-center justify-between h-16 px-4 border-b border-border">
          <Link href="/portal/dashboard" className="hover:opacity-80 transition-opacity flex items-center gap-2">
            <div className="relative w-8 h-8 shrink-0">
              <Image
                src="/logo.png"
                alt="SynapseOS"
                fill
                className="rounded-[22%] object-contain"
                priority
              />
            </div>
            <span className="text-sm font-semibold text-foreground leading-tight">
              SynapseOS
              <span className="block text-[10px] font-normal text-muted-foreground -mt-0.5">Pharmacy</span>
            </span>
          </Link>
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setIsSidebarOpen(false)} aria-label="Close navigation menu">
            <X className="h-5 w-5" />
          </Button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-3 py-4 space-y-4 overflow-y-auto">
          {NAV_GROUPS.map((group) => {
            const visibleItems = group.items.filter(item =>
              hasPermission(
                (item as { permission?: string; adminOnly?: boolean }).permission,
                (item as { permission?: string; adminOnly?: boolean }).adminOnly
              )
            )
            if (visibleItems.length === 0) return null
            return (
              <div key={group.label}>
                <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {visibleItems.map((item) => {
                    const Icon = item.icon
                    const isActive = pathname === item.href
                    return (
                      <Link
                        key={item.name}
                        href={item.href}
                        onClick={() => setIsSidebarOpen(false)}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
                          isActive
                            ? "bg-primary/10 text-primary border-l-2 border-primary"
                            : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span>{item.name}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>

        {/* User footer */}
        <div className="border-t border-border p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-9 h-9 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
              <span className="text-sm font-bold text-primary">
                {displayName.charAt(0).toUpperCase()}
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate text-foreground">{displayName}</p>
              <p className="text-xs text-muted-foreground">{roleLabel}</p>
            </div>
          </div>
          <Link
            href="/portal/profile"
            onClick={() => setIsSidebarOpen(false)}
            className="btn-ghost w-full text-sm text-muted-foreground hover:text-foreground mb-1"
          >
            <UserCircle className="h-4 w-4" />
            My Profile
          </Link>
          <button onClick={handleSignOut} className="btn-ghost w-full text-sm text-muted-foreground hover:text-destructive">
            <LogOut className="h-4 w-4" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main — fills remaining width, scrolls independently */}
      <div className={cn("lg:pl-64 flex flex-col h-screen", user?.isImpersonation && "pt-10")}>
        {/* Top bar — sticky within the flex column */}
        <header className="app-header shrink-0 z-30 flex items-center justify-between h-16 px-4 lg:px-6 bg-card/80 backdrop-blur-md border-b border-border">
          <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setIsSidebarOpen(true)} aria-label="Open navigation menu">
            <Menu className="h-5 w-5" />
          </Button>

          <h1 className="text-base font-semibold text-foreground hidden lg:block">
            {NAV_GROUPS.flatMap(g => g.items).find(item => item.href === pathname)?.name ?? "Dashboard"}
          </h1>

          <div className="flex items-center gap-3 ml-auto">
            <div className={cn(
              "hidden sm:flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border",
              isOnline
                ? "bg-green-500/10 text-green-400 border-green-500/20"
                : "bg-amber-500/10 text-amber-400 border-amber-500/20"
            )}
            aria-live="polite"
          >
              {isOnline ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              <span>{isOnline ? "Online" : "Offline"}</span>
            </div>
            <SynapseThemeToggle variant="segmented" size="sm" />
            <NotificationBell />
            <div className="hidden md:flex flex-col items-end">
              <span className="text-sm font-medium text-foreground">{displayName}</span>
              <span className="text-xs text-muted-foreground">{roleLabel}</span>
            </div>
          </div>
        </header>

        {/* Scrollable content area */}
        <main id="main" className="flex-1 overflow-y-auto p-4 pb-20 lg:p-6 xl:p-8 lg:pb-8">
          <div className="max-w-[1920px] mx-auto">
            {children}
          </div>
        </main>

        {/* Mobile bottom tab bar */}
        <nav className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-card/95 backdrop-blur-md border-t border-border">
          <div className="flex items-center justify-around px-1 py-1">
            {BOTTOM_TABS.map((tab) => {
              const Icon = tab.icon
              const isActive = pathname === tab.href
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    "flex flex-col items-center gap-0.5 px-3 py-2 transition-colors min-w-0",
                    isActive ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-5 w-5 shrink-0" />
                  <span className="text-[9px] font-medium">{tab.name}</span>
                </Link>
              )
            })}
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="flex flex-col items-center gap-0.5 px-3 py-2 text-muted-foreground"
            >
              <Menu className="h-5 w-5" />
              <span className="text-[9px] font-medium">More</span>
            </button>
          </div>
        </nav>
      </div>
    </div>
  )
}
