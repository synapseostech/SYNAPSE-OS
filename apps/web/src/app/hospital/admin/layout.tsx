'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  BedDouble,
  Building2,
  FileText,
  Hospital,
  LayoutDashboard,
  Package,
  Settings,
  ToggleLeft,
  Users,
  Wallet,
} from 'lucide-react'
import { SynapseLogo } from '../../../components/SynapseLogo'
import { ThemeToggle } from '../../../components/ThemeToggle'
import { SkipLink } from '@synapse/ui'

const NAV = [
  { href: '/hospital/admin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/hospital/admin/settings', label: 'Settings', icon: Settings },
  { href: '/hospital/admin/departments', label: 'Departments', icon: Building2 },
  { href: '/hospital/admin/wards', label: 'Wards', icon: Hospital },
  { href: '/hospital/admin/beds', label: 'Beds', icon: BedDouble },
  { href: '/hospital/admin/staff', label: 'Staff', icon: Users },
  { href: '/hospital/admin/modules', label: 'Modules', icon: ToggleLeft },
  { href: '/hospital/admin/services', label: 'Services', icon: Package },
  { href: '/hospital/admin/finance', label: 'Finance', icon: Wallet },
  { href: '/hospital/admin/audit', label: 'Audit Log', icon: FileText },
]

export default function HospitalAdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}>
      <SkipLink />
      <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[260px_1fr]">
        <aside
          className="border-r px-3 py-5 hidden lg:flex flex-col"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
        >
          <div className="px-2 mb-6">
            <SynapseLogo size="sm" />
            <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>Hospital Admin Console</p>
          </div>
          <nav className="flex-1 space-y-0.5">
            {NAV.map(({ href, label, icon: Icon, exact }) => {
              const active = exact ? pathname === href : pathname.startsWith(href)
              return (
                <Link
                  key={href}
                  href={href}
                  className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-all"
                  style={{
                    background: active ? 'rgba(249,115,22,0.1)' : 'transparent',
                    color: active ? 'var(--brand-orange)' : 'var(--text-secondary)',
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {label}
                </Link>
              )
            })}
          </nav>
          <div className="pt-4 border-t space-y-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <div className="px-2">
              <ThemeToggle />
            </div>
            <button
              type="button"
              onClick={handleSignOut}
              className="w-full rounded-xl px-3 py-2 text-sm text-left transition-all"
              style={{ color: 'var(--text-muted)' }}
            >
              Sign out
            </button>
          </div>
        </aside>

        <section className="flex flex-col min-h-screen">
          <header
            className="flex items-center justify-between px-4 py-3 border-b lg:hidden sticky top-0 z-30"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
          >
            <SynapseLogo size="xs" />
            <div className="flex items-center gap-2">
              <ThemeToggle size="sm" />
              <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Hospital Admin</span>
            </div>
          </header>
          <main id="main" tabIndex={-1} className="flex-1 p-4 pb-24 outline-none lg:pb-6 lg:p-6">{children}</main>
        </section>
      </div>

      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 flex overflow-x-auto border-t"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        {NAV.slice(0, 5).map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname.startsWith(href)
          return (
            <Link
              key={href}
              href={href}
              className="flex min-w-[4rem] flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium shrink-0"
              style={{ color: active ? 'var(--brand-orange)' : 'var(--text-muted)' }}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          )
        })}
      </nav>
    </div>
  )
}
