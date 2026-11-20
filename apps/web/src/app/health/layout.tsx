'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import {
  Activity, Bot, Calendar, Droplets, FlaskConical, LayoutDashboard,
  Moon, Pill, Smartphone, Utensils,
} from 'lucide-react'
import { SynapseLogo } from '../../components/SynapseLogo'
import { ModeSwitcher } from '../../components/ModeSwitcher'
import { ThemeToggle } from '../../components/ThemeToggle'

const NAV = [
  { href: '/health/dashboard', label: 'Home', icon: LayoutDashboard },
  { href: '/health/visits', label: 'Visits', icon: Calendar },
  { href: '/health/medications', label: 'Meds', icon: Pill },
  { href: '/health/labs', label: 'Labs', icon: FlaskConical },
  { href: '/health/devices', label: 'Devices', icon: Smartphone },
  { href: '/health/cycle', label: 'Cycle', icon: Moon },
  { href: '/health/diet', label: 'Diet', icon: Utensils },
  { href: '/health/habits', label: 'Habits', icon: Activity },
  { href: '/health/coach', label: 'Companion', icon: Bot },
]

export default function HealthLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <div
      className="min-h-screen flex flex-col"
      style={{ background: 'var(--bg-base)', color: 'var(--text-primary)' }}
    >
      {/* Top header */}
      <header
        className="sticky top-0 z-30 flex items-center justify-between px-4 py-3 border-b"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        <SynapseLogo size="sm" />
        <div className="flex items-center gap-2">
          <ThemeToggle size="sm" />
          <Droplets className="h-4 w-4" style={{ color: 'var(--brand-orange)' }} />
          <span className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Health</span>
          <ModeSwitcher />
        </div>
      </header>

      {/* Horizontal scrollable nav — desktop sidebar on lg */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar on large screens */}
        <aside
          className="hidden lg:flex flex-col w-52 border-r shrink-0 py-4 px-2"
          style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
        >
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + '/')
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
        </aside>

        {/* Main content */}
        <main className="flex-1 overflow-y-auto pb-24 lg:pb-6 px-4 py-4 lg:px-6">
          {children}
        </main>
      </div>

      {/* Bottom tab bar — mobile only */}
      <nav
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 flex overflow-x-auto border-t"
        style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}
      >
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <Link
              key={href}
              href={href}
              className="flex flex-1 min-w-[4rem] flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium shrink-0 transition-all"
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
