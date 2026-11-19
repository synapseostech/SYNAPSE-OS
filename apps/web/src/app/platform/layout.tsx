"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Bell,
  Beaker,
  Brain,
  Building2,
  ClipboardCheck,
  ClipboardList,
  CreditCard,
  DatabaseZap,
  Flag,
  Gauge,
  GitBranch,
  HeartPulse,
  Kanban,
  Layers,
  LifeBuoy,
  Menu,
  MonitorSmartphone,
  Network,
  Pill,
  Radio,
  Receipt,
  Search,
  Settings,
  ShieldCheck,
  Siren,
  Spline,
  Stethoscope,
  TestTube2,
  TrendingUp,
  UserRound,
  Users,
  Workflow,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { SkipLink } from "@synapse/ui";
import { SynapseLogo } from "../../components/SynapseLogo";
import { ThemeToggle } from "../../components/ThemeToggle";
import { PlatformBreadcrumb } from "./_components/breadcrumb";
import { navRequiresCapability } from "@/lib/platform/rbac";

type CommandResult = {
  title: string;
  subtitle: string;
  href: string;
  type: string;
};

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  exact?: boolean;
};

type NavSection = {
  caption: string;
  items: NavItem[];
};

const SIDEBAR_SECTIONS: NavSection[] = [
  {
    caption: "Overview",
    items: [
      { href: "/platform", label: "Command Center", icon: Activity, exact: true },
      { href: "/platform/test-center", label: "Test Center", icon: TestTube2 },
      { href: "/platform/registry", label: "Product Registry", icon: Layers },
      { href: "/platform/monitoring", label: "Service Health", icon: Gauge },
    ],
  },
  {
    caption: "Control Center",
    items: [
      { href: "/platform/simulation", label: "Simulation Lab", icon: Beaker },
      { href: "/platform/events", label: "Event Explorer", icon: Spline },
      { href: "/platform/lab", label: "Lab Monitor", icon: TestTube2 },
      { href: "/platform/intelligence", label: "Intelligence", icon: Brain },
      { href: "/platform/icd11", label: "ICD-11", icon: Stethoscope },
      { href: "/platform/modules", label: "Module Matrix", icon: Workflow },
      { href: "/platform/integrations", label: "Integrations", icon: Network },
      { href: "/platform/incidents", label: "Incidents", icon: Siren },
    ],
  },
  {
    caption: "Customers",
    items: [
      { href: "/platform/tenants", label: "All tenants", icon: Layers },
      { href: "/platform/facilities", label: "Facilities", icon: Building2 },
      { href: "/platform/hospitals", label: "Hospitals", icon: Stethoscope },
      { href: "/platform/users", label: "Users & Professionals", icon: Users },
      { href: "/platform/applications", label: "Applications", icon: Kanban },
      { href: "/platform/approvals", label: "Approvals", icon: ClipboardCheck },
    ],
  },
  {
    caption: "Commercial",
    items: [
      { href: "/platform/commercial/leads", label: "Leads", icon: TrendingUp },
      { href: "/platform/commercial/meetings", label: "Meetings", icon: ClipboardList },
      { href: "/platform/commercial/pricing", label: "Pricing", icon: CreditCard },
      { href: "/platform/commercial/subscriptions", label: "Live subscriptions", icon: Receipt },
      { href: "/platform/sales", label: "Legacy pipeline", icon: Kanban },
      { href: "/platform/billing", label: "Revenue & Billing", icon: CreditCard },
      { href: "/platform/subscriptions", label: "Manual grants", icon: Receipt },
    ],
  },
  {
    caption: "Growth",
    items: [
      { href: "/platform/pharmacy-network", label: "Pharmacies", icon: Pill },
    ],
  },
  {
    caption: "Operations",
    items: [
      { href: "/platform/support", label: "Support", icon: LifeBuoy },
      { href: "/platform/broadcasts", label: "Broadcasts", icon: HeartPulse },
      { href: "/platform/receipts", label: "Receipts & Invoices", icon: Receipt },
    ],
  },
  {
    caption: "Intelligence",
    items: [
      { href: "/platform/analytics", label: "Ecosystem Analytics", icon: BarChart3 },
      { href: "/platform/public-health", label: "SynapseEPI", icon: Radio },
    ],
  },
  {
    caption: "Governance",
    items: [
      { href: "/platform/performance", label: "Stakeholder Performance", icon: TrendingUp },
      { href: "/platform/access", label: "Platform staff", icon: ShieldCheck },
      { href: "/platform/audit-log", label: "Audit Log", icon: ClipboardList },
    ],
  },
  {
    caption: "System",
    items: [
      { href: "/platform/security", label: "Sessions & Security", icon: ShieldCheck },
      { href: "/platform/flags", label: "Feature Flags", icon: Flag },
      { href: "/platform/dhis2", label: "DHIS2 Exports", icon: DatabaseZap },
      { href: "/platform/database", label: "Database", icon: DatabaseZap },
      { href: "/platform/deployments", label: "Deployments", icon: GitBranch },
      { href: "/platform/mobile", label: "Mobile Builds", icon: MonitorSmartphone },
      { href: "/platform/health", label: "System health", icon: Gauge },
      { href: "/platform/settings", label: "Settings", icon: Settings },
    ],
  },
];

const ALL_NAV_ITEMS = SIDEBAR_SECTIONS.flatMap((section) => section.items);

const STATIC_COMMANDS: CommandResult[] = ALL_NAV_ITEMS.map((item) => ({
  title: item.label,
  subtitle: "Platform section",
  href: item.href,
  type: "Navigation",
}));

function isNavActive(pathname: string, item: NavItem) {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remoteResults, setRemoteResults] = useState<CommandResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const paletteTriggerRef = useRef<HTMLButtonElement | null>(null);
  const paletteInputRef = useRef<HTMLInputElement | null>(null);
  const paletteListId = useId();

  useEffect(() => {
    function onKeydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => {
          if (open) return false;
          paletteTriggerRef.current = document.activeElement as HTMLButtonElement | null;
          return true;
        });
      }
      if (event.key === "Escape" && paletteOpen) {
        event.preventDefault();
        setPaletteOpen(false);
        paletteTriggerRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [paletteOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, remoteResults]);

  useEffect(() => {
    if (paletteOpen) {
      window.requestAnimationFrame(() => paletteInputRef.current?.focus());
    }
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen || query.trim().length < 2) {
      setRemoteResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(`/api/platform/search?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = (await res.json()) as { results?: CommandResult[] };
        setRemoteResults(data.results ?? []);
      } catch {
        setRemoteResults([]);
      }
    }, 180);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [paletteOpen, query]);

  // The caller's capabilities, so links their role cannot open are not shown.
  // Until they load (or if the call fails) every link shows; the pages
  // themselves enforce access on the server either way.
  const [capabilities, setCapabilities] = useState<string[] | null>(null);
  const [roleName, setRoleName] = useState<string | null>(null);
  const isAuthPage =
    pathname === "/platform/login" || pathname === "/platform/mfa" || pathname === "/platform/mfa-verify" || pathname.startsWith("/platform/invite/");
  useEffect(() => {
    if (isAuthPage) return;
    let cancelled = false;
    fetch("/api/platform/me", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { capabilities?: string[]; roleLabel?: string } | null) => {
        if (cancelled || !data?.capabilities) return;
        setCapabilities(data.capabilities);
        setRoleName(data.roleLabel ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isAuthPage]);
  const canOpen = (href: string) => !capabilities || capabilities.includes(navRequiresCapability(href));
  const visibleSections = useMemo(
    () =>
      SIDEBAR_SECTIONS.map((section) => ({ ...section, items: section.items.filter((item) => canOpen(item.href)) })).filter(
        (section) => section.items.length > 0,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [capabilities],
  );

  const commandResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const allowed = STATIC_COMMANDS.filter((item) => canOpen(item.href));
    const local = normalized
      ? allowed.filter((item) => `${item.title} ${item.subtitle}`.toLowerCase().includes(normalized))
      : allowed;
    const seen = new Set<string>();
    return [...remoteResults, ...local].filter((item) => {
      if (seen.has(item.href)) return false;
      seen.add(item.href);
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, remoteResults, capabilities]);

  async function handleSignOut() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    router.push("/platform/login");
    router.refresh();
  }

  if (pathname === "/platform/login" || pathname === "/platform/mfa" || pathname === "/platform/mfa-verify") {
    return <>{children}</>;
  }

  const activeItem = ALL_NAV_ITEMS.find((item) => isNavActive(pathname, item));

  return (
    <div className="platform-shell flex h-screen overflow-hidden bg-base text-primary-color">
      <SkipLink href="#platform-main" />
      {sidebarOpen ? (
        <button
          type="button"
          aria-label="Close navigation"
          className="fixed inset-0 z-40 bg-black/70 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      {/* Sidebar — fixed height, scrolls independently */}
      <aside
        id="platform-sidebar-nav"
        className={`platform-sidebar fixed inset-y-0 left-0 z-50 flex h-screen w-64 shrink-0 flex-col border-r border-subtle bg-[#0a0a0f] transition-transform print:hidden lg:static lg:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
        aria-label="Platform navigation"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-subtle px-4 py-4">
          <Link href="/platform" className="flex min-w-0 items-center gap-2">
            <SynapseLogo size="sm" />
            <span className="rounded-full border border-[#E8B84B]/30 bg-[#E8B84B]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-[#E8B84B]">
              Admin
            </span>
          </Link>
          <button
            type="button"
            aria-label="Close navigation"
            className="rounded-lg p-2 text-secondary-color lg:hidden"
            onClick={() => setSidebarOpen(false)}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4" aria-label="Primary">
          {visibleSections.map((section) => (
            <div key={section.caption} className="mb-5 last:mb-0">
              <p className="mb-2 px-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-color" id={`nav-${section.caption.replace(/\s+/g, "-").toLowerCase()}`}>
                {section.caption}
              </p>
              <div className="space-y-0.5" role="list" aria-labelledby={`nav-${section.caption.replace(/\s+/g, "-").toLowerCase()}`}>
                {section.items.map((item) => {
                  const Icon = item.icon;
                  const active = isNavActive(pathname, item);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="listitem"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setSidebarOpen(false)}
                      className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316] ${
                        active
                          ? "bg-[#F97316]/10 font-medium text-[#F97316]"
                          : "text-secondary-color hover:bg-surface hover:text-primary-color"
                      }`}
                    >
                      {active ? (
                        <span
                          className="absolute bottom-1 left-0 top-1 w-0.5 rounded-full bg-[#F97316]"
                          aria-hidden
                        />
                      ) : null}
                      <Icon className={`h-4 w-4 shrink-0 ${active ? "text-[#F97316]" : "text-[#E8B84B]/80"}`} aria-hidden />
                      <span className="truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="shrink-0 border-t border-subtle p-3">
          <div className="flex items-center gap-3 rounded-xl border border-subtle bg-surface p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[#E8B84B]/25 bg-[#E8B84B]/10 text-[#E8B84B]">
              <UserRound className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-primary-color">Platform Admin</p>
              <p className="text-xs text-muted-color">platform_admin</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main column — header fixed, content scrolls independently */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-subtle bg-[var(--nav-glass)] px-4 backdrop-blur print:hidden lg:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="Open navigation"
              aria-expanded={sidebarOpen}
              aria-controls="platform-sidebar-nav"
              className="rounded-lg p-2 text-secondary-color focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316] lg:hidden"
              onClick={() => setSidebarOpen(true)}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-sm font-semibold text-primary-color sm:text-base">
                {activeItem?.label ?? "Platform"}
              </h1>
              <PlatformBreadcrumb />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              ref={paletteTriggerRef}
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={paletteOpen}
              aria-keyshortcuts="Control+K Meta+K"
              className="hidden min-w-[240px] items-center justify-between rounded-xl border border-subtle bg-surface px-3 py-2 text-left text-sm text-muted-color transition hover:border-[#F97316]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316] md:flex"
            >
              <span className="flex items-center gap-2">
                <Search className="h-4 w-4" aria-hidden />
                Search facilities, users, tickets
              </span>
              <kbd className="rounded border border-subtle px-1.5 py-0.5 text-[10px] text-muted-color">⌘K</kbd>
            </button>
            <Link
              href="/platform#attention"
              aria-label="Needs attention"
              className="relative rounded-xl border border-subtle bg-surface p-2 text-secondary-color transition hover:border-[#F97316]/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316]"
            >
              <Bell className="h-4 w-4" aria-hidden />
            </Link>
            {roleName ? (
              <span className="hidden rounded-xl border border-subtle px-2.5 py-1.5 text-[11px] font-medium text-secondary-color md:inline" title="Your platform role">
                {roleName}
              </span>
            ) : null}
            <ThemeToggle />
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-xl border border-subtle px-3 py-2 text-xs font-medium text-secondary-color transition hover:border-edge hover:text-primary-color focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316]"
            >
              Sign out
            </button>
          </div>
        </header>

        <main id="platform-main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-base p-4 outline-none lg:p-6">
          {children}
        </main>
      </div>

      {paletteOpen ? (
        <div
          className="fixed inset-0 z-[70] flex items-start justify-center bg-black/70 px-4 pt-24"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setPaletteOpen(false);
              paletteTriggerRef.current?.focus();
            }
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="w-full max-w-2xl overflow-hidden rounded-2xl border border-subtle bg-surface shadow-2xl"
          >
            <div className="flex items-center gap-3 border-b border-subtle px-4 py-3">
              <Search className="h-5 w-5 text-[#E8B84B]" aria-hidden />
              <input
                ref={paletteInputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setActiveIndex((i) => Math.min(i + 1, Math.max(commandResults.length - 1, 0)));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((i) => Math.max(i - 1, 0));
                  } else if (event.key === "Home") {
                    event.preventDefault();
                    setActiveIndex(0);
                  } else if (event.key === "End") {
                    event.preventDefault();
                    setActiveIndex(Math.max(commandResults.length - 1, 0));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    const selected = commandResults[activeIndex];
                    if (selected) {
                      setPaletteOpen(false);
                      setQuery("");
                      router.push(selected.href);
                      paletteTriggerRef.current?.focus();
                    }
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setPaletteOpen(false);
                    paletteTriggerRef.current?.focus();
                  }
                }}
                placeholder="Search facilities, users, support tickets, audit events..."
                aria-controls={paletteListId}
                aria-activedescendant={
                  commandResults[activeIndex] ? `${paletteListId}-option-${activeIndex}` : undefined
                }
                aria-autocomplete="list"
                role="combobox"
                aria-expanded="true"
                className="flex-1 bg-transparent text-sm text-primary-color outline-none placeholder:text-muted-color"
              />
              <button
                type="button"
                aria-label="Close search"
                className="rounded-lg p-1 text-muted-color hover:text-primary-color focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316]"
                onClick={() => {
                  setPaletteOpen(false);
                  paletteTriggerRef.current?.focus();
                }}
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div id={paletteListId} role="listbox" className="max-h-[420px] overflow-y-auto p-2">
              {commandResults.length === 0 ? (
                <p className="px-3 py-8 text-center text-sm text-muted-color">No results found.</p>
              ) : null}
              {commandResults.map((result, index) => (
                <Link
                  key={`${result.type}:${result.href}:${result.title}`}
                  id={`${paletteListId}-option-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  href={result.href}
                  onClick={() => {
                    setPaletteOpen(false);
                    setQuery("");
                  }}
                  className={`block rounded-xl px-3 py-3 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#F97316] ${
                    index === activeIndex ? "bg-elevated" : "hover:bg-elevated"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-medium text-primary-color">{result.title}</p>
                      <p className="mt-0.5 text-xs text-muted-color">{result.subtitle}</p>
                    </div>
                    <span className="rounded-full border border-[#E8B84B]/20 bg-[#E8B84B]/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#E8B84B]">
                      {result.type}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
