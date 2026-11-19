export const dynamic = "force-dynamic"

import Link from "next/link"
import { Building2, Filter, Plus } from "lucide-react"
import { requirePlatformPage } from "../../../lib/platform/auth"
import { formatDate, safeRows } from "../_lib/platform-data"

type TenantRow = {
  id?: string
  name?: string | null
  slug?: string | null
  facility_type?: string | null
  status?: string | null
  lifecycle_status?: string | null
  is_active?: boolean | null
  plan?: string | null
  default_subdomain?: string | null
  custom_domain?: string | null
  created_at?: string | null
}

type RunRow = {
  tenant_id?: string | null
  status?: string | null
  failure_code?: string | null
  created_at?: string | null
}

const FILTERS = [
  { key: "all", label: "All" },
  { key: "hospital", label: "Hospitals" },
  { key: "clinic", label: "Clinics" },
  { key: "laboratory", label: "Laboratories" },
  { key: "pharmacy", label: "Pharmacies" },
] as const

function statusClass(status: string | null | undefined, isActive?: boolean | null) {
  if (status === "active" && isActive !== false) return "border-green-500/25 bg-green-500/10 text-green-300"
  if (status === "provisioning") return "border-amber-500/25 bg-amber-500/10 text-amber-300"
  if (status === "failed") return "border-red-500/25 bg-red-500/10 text-red-300"
  return "border-slate-700 bg-slate-800 text-slate-300"
}

export default async function PlatformFacilitiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ type?: string; q?: string }>
}) {
  await requirePlatformPage("/platform/facilities")
  const params = (await searchParams) ?? {}
  const typeFilter = (params.type ?? "all").toLowerCase()
  const q = (params.q ?? "").trim().toLowerCase()

  const [tenants, runs] = await Promise.all([
    safeRows<TenantRow>(
      "tenants",
      "id, name, slug, facility_type, status, lifecycle_status, is_active, plan, default_subdomain, custom_domain, created_at",
      { orderBy: "created_at", limit: 400 },
    ),
    safeRows<RunRow>("facility_provisioning_runs", "tenant_id, status, failure_code, created_at", {
      orderBy: "created_at",
      limit: 500,
    }),
  ])

  const latestRunByTenant = new Map<string, RunRow>()
  for (const run of runs) {
    if (!run.tenant_id) continue
    if (!latestRunByTenant.has(run.tenant_id)) latestRunByTenant.set(run.tenant_id, run)
  }

  const filtered = tenants.filter((t) => {
    const ft = (t.facility_type ?? "").toLowerCase()
    const typeOk =
      typeFilter === "all"
        ? true
        : typeFilter === "clinic"
          ? ft === "clinic" || ft === "health_centre"
          : typeFilter === "hospital"
            ? ft === "hospital" || !ft
            : ft === typeFilter
    if (!typeOk) return false
    if (!q) return true
    const hay = `${t.name ?? ""} ${t.slug ?? ""} ${t.id ?? ""} ${t.plan ?? ""}`.toLowerCase()
    return hay.includes(q)
  })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Platform</p>
          <h1 className="mt-1 text-2xl font-bold text-white">Facilities</h1>
          <p className="mt-1 text-sm text-slate-400">
            Hospitals, clinics, pharmacies, and laboratories as first-class tenants.
          </p>
        </div>
        <Link
          href="/platform/facilities/new"
          className="inline-flex items-center gap-2 rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A]"
        >
          <Plus className="h-4 w-4" />
          Create Facility
        </Link>
      </div>

      <form method="get" role="search" aria-label="Search facilities" className="flex flex-wrap gap-2">
        {typeFilter !== "all" ? <input type="hidden" name="type" value={typeFilter} /> : null}
        <label className="sr-only" htmlFor="facility-q">Search facilities</label>
        <input
          id="facility-q"
          name="q"
          defaultValue={params.q ?? ""}
          placeholder="Name, slug, or facility ID"
          className="min-w-[16rem] flex-1 rounded-lg border border-slate-700 bg-[#07070A] px-3 py-2 text-sm text-slate-100"
        />
        <button type="submit" className="rounded-lg border border-[#E8B84B]/40 bg-[#E8B84B]/10 px-4 py-2 text-sm text-[#E8B84B]">
          Search
        </button>
      </form>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/platform/facilities" : `/platform/facilities?type=${f.key}`}
            className={`inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium ${
              typeFilter === f.key
                ? "border-[#E8B84B]/50 bg-[#E8B84B]/10 text-[#E8B84B]"
                : "border-slate-700 text-slate-400 hover:border-slate-500"
            }`}
          >
            <Filter className="h-3 w-3" />
            {f.label}
          </Link>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-800">
        <table className="min-w-full text-left text-sm">
          <caption className="sr-only">Facilities</caption>
          <thead className="bg-slate-900/80 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Facility</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Subscription</th>
              <th className="px-4 py-3">Domain</th>
              <th className="px-4 py-3">Onboarding</th>
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-slate-500">
                  <Building2 className="mx-auto mb-2 h-6 w-6 opacity-40" />
                  No facilities match this filter.
                </td>
              </tr>
            ) : (
              filtered.map((t) => {
                const run = t.id ? latestRunByTenant.get(t.id) : undefined
                const domain =
                  t.custom_domain ||
                  (t.facility_type === "pharmacy"
                    ? `pharm.synapseos.tech?tenant=${(t.slug ?? "").replace(/^pharm-/, "")}`
                    : t.default_subdomain || t.slug
                      ? `${t.default_subdomain || t.slug}.synapseos.tech`
                      : "—")
                return (
                  <tr key={t.id} className="border-t border-slate-800/80 hover:bg-slate-900/40">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-100">{t.name ?? "—"}</div>
                      <div className="font-mono text-xs text-slate-500">{t.slug}</div>
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-300">
                      {(t.facility_type ?? "facility").replace(/_/g, " ")}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(t.status, t.is_active)}`}>
                        {t.lifecycle_status && t.lifecycle_status !== "ACTIVE"
                          ? t.lifecycle_status
                          : t.status ?? "unknown"}
                        {t.is_active === false && t.lifecycle_status !== "SUSPENDED" ? " · inactive" : ""}
                      </span>
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-300">{t.plan ?? "—"}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{domain}</td>
                    <td className="px-4 py-3 text-xs text-slate-300">
                      {run?.status ?? "—"}
                      {run?.failure_code ? ` · ${run.failure_code}` : ""}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-400">
                      {t.is_active && t.status === "active" ? "OK" : t.status === "failed" ? "FAILED" : "PENDING"}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{formatDate(t.created_at)}</td>
                    <td className="px-4 py-3">
                      <Link href={`/platform/facilities/${t.id}`} className="text-xs font-semibold text-[#E8B84B] hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
