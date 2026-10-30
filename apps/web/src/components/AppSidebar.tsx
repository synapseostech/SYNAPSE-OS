'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import {
  LayoutDashboard, Stethoscope, UserRound, FlaskConical, Pill,
  Users, ClipboardList, Settings, Menu, X,
  HeartPulse, Activity, Package, ShoppingCart
} from 'lucide-react'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { ThemeToggle } from './ThemeToggle'
import { SkipLink } from '@synapse/ui'
import { appSidebarNav } from '../lib/production-navigation'

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

const NAV_GROUPS = (tenantSlug?: string, role?: string) => {
  const items = appSidebarNav(tenantSlug)
  const byName = new Map(items.map((item) => [item.name, item]))
  const withIcon = (name: string, icon: typeof LayoutDashboard) => {
    const item = byName.get(name)
    return {
      name: item?.name ?? name,
      href: item?.href ?? (tenantSlug ? `/os/${tenantSlug}/dashboard` : '/os'),
      icon,
    }
  }
  const roleItems = role === 'receptionist'
    ? ['Patients', 'Encounters']
    : role === 'nurse'
      ? ['Nursing', 'Patients']
      : role === 'lab_tech' || role === 'lab_scientist' || role === 'lab_admin' || role === 'lab_supervisor' || role === 'facility_admin'
        ? ['Laboratory']
        : role === 'pharmacist' || role === 'pharmacy_admin' || role === 'pharmacy_staff'
          ? ['Pharmacy', 'Inventory']
          : null

  const groups = [
  {
    label: 'Clinical',
    items: [
      withIcon('Dashboard', LayoutDashboard),
      withIcon('Doctor', Stethoscope),
      withIcon('Nursing', HeartPulse),
      withIcon('Patients', UserRound),
    ],
  },
  {
    label: 'Departments',
    items: [
      withIcon('Laboratory', FlaskConical),
      withIcon('Pharmacy', Pill),
      withIcon('Inventory', Package),
      withIcon('Encounters', ClipboardList),
    ],
  },
  {
    label: 'Admin',
    items: [
      withIcon('Staff', Users),
      withIcon('Activity', Activity),
      withIcon('Settings', Settings),
    ],
  },
  ]

  return groups.map((group) => ({
    ...group,
    items: roleItems ? group.items.filter((item) => item.name === 'Dashboard' || roleItems.includes(item.name)) : group.items,
  })).filter((group) => group.items.length > 0)
}

const BOTTOM_TABS = (tenantSlug?: string) => {
  const base = tenantSlug ? `/os/${tenantSlug}` : '/os'
  return [
  { name: 'Home', href: `${base}/dashboard`, icon: LayoutDashboard },
  { name: 'Doctor', href: `${base}/clinical/queue`, icon: Stethoscope },
  { name: 'Patients', href: `${base}/patients`, icon: UserRound },
  { name: 'Lab',      href: '/lab/orders',     icon: FlaskConical },
]
}

function slugFromPath(pathname: string): string | undefined {
  const segment = pathname.match(/^\/os\/([^/]+)/)?.[1]
  return segment ? decodeURIComponent(segment) : undefined
}

export function AppSidebar({ children, tenantSlug: slugProp, role }: { children: React.ReactNode; tenantSlug?: string; role?: string }) {
  const pathname = usePathname()
  // The /os layout sits above [slug] and never receives it, so derive it from the URL.
  const tenantSlug = slugProp ?? slugFromPath(pathname)
  const [open, setOpen] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const navGroups = NAV_GROUPS(tenantSlug, role)
  const bottomTabs = BOTTOM_TABS(tenantSlug)

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      openerRef.current?.focus()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open])

  const openDrawer = (event: React.MouseEvent<HTMLElement>) => {
    openerRef.current = event.currentTarget
    setOpen(true)
  }

  return (
    <div className="min-h-screen bg-background">
      <SkipLink />
      {open && (
        <button
          type="button"
          aria-label="Close sidebar"
          className="fixed inset-0 z-40 bg-black/60 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside className={cn(
        "fixed top-0 left-0 z-50 h-screen w-64 border-r border-border bg-card flex flex-col transition-transform duration-300 lg:translate-x-0",
        open ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex items-center justify-between h-16 px-4 border-b border-border shrink-0">
          <Link href={tenantSlug ? `/os/${tenantSlug}/dashboard` : '/os'} className="flex items-center gap-2.5 hover:opacity-80 transition-opacity">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#F97316] to-[#E8B84B] flex items-center justify-center shadow">
              <span className="text-white font-black text-sm">S</span>
            </div>
            <div className="flex flex-col leading-tight">
              <span className="font-bold text-sm text-foreground">SYNAPSE OS</span>
              <span className="text-[10px] text-muted-foreground uppercase tracking-wide">Clinical</span>
            </div>
          </Link>
          <button ref={closeRef} type="button" aria-label="Close navigation" className="lg:hidden text-muted-foreground hover:text-foreground p-1" onClick={() => setOpen(false)}>
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="flex-1 px-3 py-4 overflow-y-auto space-y-4">
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={() => setOpen(false)}
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
          ))}
        </nav>
      </aside>

      {/* Main area */}
      <div className="lg:pl-64 flex flex-col min-h-screen">
        <header className="sticky top-0 z-30 flex items-center h-14 px-4 lg:px-6 bg-card/80 backdrop-blur-md border-b border-border shrink-0">
          <button type="button" aria-label="Open navigation" className="lg:hidden text-muted-foreground hover:text-foreground p-1 mr-2" onClick={openDrawer}>
            <Menu className="h-5 w-5" />
          </button>
          <span className="text-sm font-semibold text-foreground truncate flex-1">
            {navGroups.flatMap(g => g.items).find(item => pathname === item.href || pathname.startsWith(item.href + '/'))?.name ?? 'Synapse OS'}
          </span>
          <div className="flex items-center gap-2">
            <Link
              href={tenantSlug ? `/os/${tenantSlug}/clinical/dispense` : "/pharmacy/dispense"}
              aria-label="POS Cart"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-muted/50 text-foreground hover:bg-muted text-xs font-medium transition-colors"
            >
              <ShoppingCart className="h-4 w-4 text-primary" />
              <span className="hidden sm:inline">POS Cart</span>
            </Link>
            <ThemeToggle />
          </div>
        </header>

        <main id="main" tabIndex={-1} className="flex-1 p-4 pb-20 outline-none lg:p-6 lg:pb-6">
          {children}
        </main>

        {/* Mobile bottom tabs */}
        <nav className="fixed bottom-0 left-0 right-0 z-40 lg:hidden bg-card/95 backdrop-blur-md border-t border-border">
          <div className="flex items-center justify-around px-1 py-1">
            {bottomTabs.map((tab) => {
              const Icon = tab.icon
              const isActive = pathname === tab.href || pathname.startsWith(tab.href + '/')
              return (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    "flex flex-col items-center gap-0.5 px-3 py-2 transition-colors",
                    isActive ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  <Icon className="h-5 w-5" />
                  <span className="text-[9px] font-medium">{tab.name}</span>
                </Link>
              )
            })}
            <button type="button" aria-label="Open more navigation" onClick={openDrawer} className="flex flex-col items-center gap-0.5 px-3 py-2 text-muted-foreground">
              <Menu className="h-5 w-5" />
              <span className="text-[9px] font-medium">More</span>
            </button>
          </div>
        </nav>
      </div>
    </div>
  )
}
