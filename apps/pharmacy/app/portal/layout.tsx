"use client"

import { useRouter, usePathname } from "next/navigation"
import Link from "next/link"
import Image from "next/image"
import {
  LayoutDashboard, Package, ShoppingCart, ClipboardList,
  Wifi, WalletCards, LogOut, Menu, X, WifiOff, UserCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { NotificationBell } from "@/components/ui/notification-bell"
import { IdleLogoutModal } from "@/components/idle-logout-modal"
import { useState, useEffect } from "react"
import { cn } from "@/lib/utils"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { usePortalShortcuts } from "@/hooks/use-portal-shortcuts"
import { BOTTOM_TABS, NAV_GROUPS, canOpenNavItem } from "@/lib/portal-nav"
import { availableShortcuts, PORTAL_SHORTCUTS, type PortalShortcut } from "@/lib/shortcuts/registry"
import { HelpOverlay } from "@/components/shortcuts/help-overlay"
import { CommandPalette, type PaletteItem } from "@/components/shortcuts/command-palette"
import { SkipLink, SynapseThemeToggle } from "@synapse/ui"
import PortalProviders from "./providers"

export const dynamic = "force-dynamic"

// Navigation lives in lib/portal-nav so the users page can describe access
// from the same table the sidebar filters.


export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <PortalProviders>
      <PortalShell>{children}</PortalShell>
    </PortalProviders>
  )
}

/**
 * Item count for the header cart. The POS page owns the cart and persists it to
 * localStorage on every change, so the header reads that key instead of
 * duplicating cart state. `pos-cart-changed` covers the same tab (storage events
 * only fire in other tabs).
 */
function usePosCartCount(enabled: boolean) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    const read = () => {
      try {
        const raw = window.localStorage.getItem('pos-cart')
        const items = raw ? (JSON.parse(raw) as Array<{ cartQuantity?: number }>) : []
        setCount(
          Array.isArray(items)
            ? items.reduce((total, item) => total + (Number(item.cartQuantity) || 0), 0)
            : 0,
        )
      } catch {
        setCount(0)
      }
    }
    read()
    window.addEventListener('pos-cart-changed', read)
    window.addEventListener('storage', read)
    return () => {
      window.removeEventListener('pos-cart-changed', read)
      window.removeEventListener('storage', read)
    }
  }, [enabled])
  return count
}

function PortalShell({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = usePharmacySession()
  const pathname = usePathname()
  const router = useRouter()
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isOnline, setIsOnline] = useState(true)
  const [overlay, setOverlay] = useState<"help" | "palette" | null>(null)
  useEffect(() => {
    setIsOnline(navigator.onLine)
    const onOnline = () => setIsOnline(true)
    const onOffline = () => setIsOnline(false)
    window.addEventListener("online", onOnline)
    window.addEventListener("offline", onOffline)
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline) }
  }, [])

  const session = user
    ? { isAdmin: user.isAdmin, pharmacyRole: user.pharmacyRole, permissions: user.permissions }
    : null

  const hasPermission = (permission?: string, adminOnly?: boolean) =>
    canOpenNavItem(session, { permission, adminOnly })

  const showPosCart = hasPermission('MANAGE_POS')
  const posCartCount = usePosCartCount(showPosCart)

  const canUseShortcut = (shortcut: PortalShortcut) =>
    hasPermission(shortcut.capability, shortcut.adminOnly)

  usePortalShortcuts({
    enabled: overlay === null,
    canUse: canUseShortcut,
    onOpenHelp: () => setOverlay("help"),
    onOpenPalette: () => setOverlay("palette"),
  })

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

  const paletteItems: PaletteItem[] = [
    ...NAV_GROUPS.flatMap((group) =>
      group.items
        .filter((item) => {
          const entry = item as { permission?: string; adminOnly?: boolean }
          return hasPermission(entry.permission, entry.adminOnly)
        })
        .map((item) => ({ name: item.name, href: item.href, group: group.label })),
    ),
    ...PORTAL_SHORTCUTS.filter(
      (shortcut): shortcut is PortalShortcut & { href: string } =>
        shortcut.group === "Vouchers" && Boolean(shortcut.href) && canUseShortcut(shortcut),
    ).map((shortcut) => ({
      name: shortcut.label,
      href: shortcut.href,
      group: "Vouchers",
      hint: shortcut.hint,
    })),
  ]

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
            {showPosCart && (
              <Link
                href="/portal/pos"
                aria-label={
                  posCartCount > 0
                    ? `Open POS, ${posCartCount} item${posCartCount === 1 ? "" : "s"} in cart`
                    : "Open POS"
                }
                title="Open POS"
                className="relative inline-flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-2 text-sm font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
              >
                <ShoppingCart className="h-4 w-4" />
                <span className="hidden xl:inline">POS</span>
                {posCartCount > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {posCartCount > 99 ? "99+" : posCartCount}
                  </span>
                )}
              </Link>
            )}
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

      <HelpOverlay
        open={overlay === "help"}
        onOpenChange={(next) => setOverlay(next ? "help" : null)}
        shortcuts={availableShortcuts(canUseShortcut)}
      />
      <CommandPalette
        open={overlay === "palette"}
        onOpenChange={(next) => setOverlay(next ? "palette" : null)}
        items={paletteItems}
      />
    </div>
  )
}
