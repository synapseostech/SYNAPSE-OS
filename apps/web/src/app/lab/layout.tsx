"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { AlertTriangle, Beaker, BookOpen, ClipboardList, FileText, FlaskConical, Gauge, Link2, Microscope, ShieldCheck, Inbox, UserPlus } from "lucide-react"
import { SkipLink } from "@synapse/ui"
import { ThemeToggle } from "@/components/ThemeToggle"
import { SynapseLogo } from "@/components/SynapseLogo"
import { signOutHospitalClinical } from "@/lib/clinical-offline/sign-out-hospital"

const links = [
  { href: "/lab", label: "Dashboard", icon: Gauge },
  { href: "/lab/orders", label: "Worklist", icon: ClipboardList },
  { href: "/lab/walk-in", label: "Walk-in", icon: UserPlus },
  { href: "/lab/critical", label: "Critical values", icon: AlertTriangle },
  { href: "/lab/reports", label: "Reports", icon: FileText },
  { href: "/lab/specimens", label: "Specimens", icon: FlaskConical },
  { href: "/lab/results", label: "Results", icon: Beaker },
  { href: "/lab/verify", label: "Verification", icon: ShieldCheck },
  { href: "/lab/instruments", label: "Instruments", icon: Microscope },
  { href: "/lab/staging", label: "Staging", icon: Inbox },
  { href: "/lab/mappings", label: "Mappings", icon: Link2 },
  { href: "/lab/catalog", label: "Catalogue", icon: BookOpen },
]

type LabIdentity = {
  profile?: { role?: string | null } | null
  tenant?: { name?: string | null; facility_type?: string | null } | null
}

export default function LabLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [identity, setIdentity] = useState<LabIdentity | null>(null)

  useEffect(() => {
    fetch("/api/account/profile", { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<LabIdentity> : null)
      .then(setIdentity)
      .catch(() => setIdentity(null))
  }, [])

  async function signOut() {
    await signOutHospitalClinical()
    router.push("/login")
    router.refresh()
  }

  const standalone = identity?.tenant?.facility_type === "laboratory"
  const facilityName = identity?.tenant?.name ?? "Synapse Laboratory"

  return (
    <div className="lab-shell min-h-screen bg-base text-primary-color">
      <SkipLink href="#lab-main" />
      <header className="sticky top-0 z-30 border-b border-subtle bg-[var(--nav-glass)] backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl items-center justify-between gap-4 px-4 py-3 lg:px-8">
          <Link href="/lab/orders" className="flex min-w-0 items-center gap-3">
            <SynapseLogo size="sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{facilityName}</p>
              <p className="text-xs text-muted-color">
                {standalone ? "Standalone laboratory" : "Hospital laboratory"}
                {identity?.profile?.role ? ` · ${identity.profile.role.replaceAll("_", " ")}` : ""}
              </p>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <button type="button" onClick={signOut} className="rounded-lg border border-edge px-3 py-2 text-xs text-secondary-color hover:text-primary-color">
              Sign out
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-screen-2xl gap-1 overflow-x-auto px-4 pb-3 lg:px-8" aria-label="Laboratory workspace">
          {links.map(({ href, label, icon: Icon }) => {
            const active = pathname === href
            return (
              <Link key={href} href={href} className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm ${active ? "bg-orange-500/15 text-orange" : "text-secondary-color hover:bg-surface hover:text-primary-color"}`}>
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            )
          })}
          <span
            className="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-color"
            aria-disabled="true"
            title="Quality control is not configured in this release"
          >
            <Gauge className="h-4 w-4" aria-hidden />
            Quality control
            <span className="sr-only">not configured</span>
          </span>
        </nav>
      </header>
      <main id="lab-main" tabIndex={-1} className="outline-none">
        {children}
      </main>
    </div>
  )
}
