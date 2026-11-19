export const dynamic = "force-dynamic"

import Link from "next/link"
import type { ReactNode } from "react"
import { requirePlatformPage } from "../../../../lib/platform/auth"
import { formatDate, platformAdminClient, safeRows } from "../../_lib/platform-data"
import { withMfaStatus } from "../../../../lib/auth/mfa-status"
import { FacilityResumeButton } from "./resume-button"
import { InviteStaffForm } from "./invite-staff-form"
import { FacilitySubscriptionPanel } from "./subscription-panel"
import { FacilityLifecyclePanel } from "./lifecycle-panel"

type TenantRow = {
  id?: string
  name?: string | null
  slug?: string | null
  facility_type?: string | null
  status?: string | null
  is_active?: boolean | null
  plan?: string | null
  email?: string | null
  phone?: string | null
  district?: string | null
  default_subdomain?: string | null
  custom_domain?: string | null
  modules_enabled?: string[] | null
  created_at?: string | null
  laboratory_profile?: Record<string, unknown> | null
}

type RunRow = {
  id?: string
  status?: string | null
  failure_code?: string | null
  current_step?: string | null
  correlation_id?: string | null
  mode?: string | null
  created_at?: string | null
  metadata?: Record<string, unknown> | null
}

type StepRow = {
  step?: string | null
  status?: string | null
  error_code?: string | null
  safe_error_message?: string | null
}

export default async function FacilityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams?: Promise<{ runId?: string; tab?: string }>
}) {
  await requirePlatformPage("/platform/facilities/[id]")
  const { id } = await params
  const sp = (await searchParams) ?? {}

  const [tenants, runs] = await Promise.all([
    safeRows<TenantRow>(
      "tenants",
      "id, name, slug, facility_type, status, is_active, plan, email, phone, district, default_subdomain, custom_domain, modules_enabled, created_at",
      { filters: [["id", id]], limit: 1 },
    ),
    safeRows<RunRow>(
      "facility_provisioning_runs",
      "id, status, failure_code, current_step, correlation_id, mode, created_at, metadata, tenant_id",
      { filters: [["tenant_id", id]], orderBy: "created_at", limit: 10 },
    ),
  ])

  const facility = tenants[0]
  if (!facility) {
    return <div className="text-sm text-slate-400">Facility not found.</div>
  }

  const run = (sp.runId ? runs.find((r) => r.id === sp.runId) : runs[0]) ?? runs[0]
  const activeTab = sp.tab ?? "overview"
  const steps = run?.id
    ? await safeRows<StepRow>(
        "facility_provisioning_steps",
        "step, status, error_code, safe_error_message",
        { filters: [["run_id", run.id]], limit: 50 },
      )
    : []

  const domain =
    facility.custom_domain ||
    (facility.facility_type === "pharmacy"
      ? `pharm.synapseos.tech/login?tenant=${(facility.slug ?? "").replace(/^pharm-/, "")}`
      : `${facility.default_subdomain || facility.slug}.synapseos.tech`)

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Facility</p>
          <h1 className="mt-1 text-2xl font-bold text-white">{facility.name}</h1>
          <p className="mt-1 text-sm capitalize text-slate-400">
            {facility.facility_type?.replace(/_/g, " ")} · {facility.status}
            {facility.is_active === false ? " · inactive" : ""}
          </p>
        </div>
        <Link href="/platform/facilities" className="text-sm text-[#E8B84B] hover:underline">
          ← Facilities
        </Link>
      </div>

      <nav aria-label="Facility sections" className="flex flex-wrap gap-2 border-b border-slate-800 pb-3 text-sm">
        {["overview", "people", "departments", "services", "instruments", "billing", "subscription", "activity", "security", "settings"].map((tab) => (
          <Link key={tab} href={`/platform/facilities/${id}?tab=${tab}`} className={`rounded-lg px-3 py-2 capitalize ${activeTab === tab ? "bg-[#E8B84B]/15 text-[#E8B84B]" : "text-slate-400 hover:text-slate-200"}`}>
            {tab}
          </Link>
        ))}
      </nav>

      {activeTab === "people" ? <FacilityPeople tenantId={id} /> : null}
      {activeTab === "departments" ? <FacilityDepartments tenantId={id} /> : null}
      {activeTab === "subscription" || activeTab === "billing" ? (
        <FacilitySubscriptionPanel tenantId={id} />
      ) : null}

      {activeTab === "overview" ? <div className="grid gap-4 sm:grid-cols-2">
        <InfoCard title="Identity">
          <Row label="Facility ID" value={facility.id} mono />
          <Row label="Slug" value={facility.slug} mono />
          <Row label="Email" value={facility.email} />
          <Row label="District" value={facility.district} />
          <Row label="Created" value={formatDate(facility.created_at)} />
        </InfoCard>
        <InfoCard title="Domain & subscription">
          <Row label="Domain" value={domain} mono />
          <Row label="Plan" value={facility.plan} />
          <Row label="Active" value={String(facility.is_active)} />
        </InfoCard>
      </div> : null}

      {activeTab === "overview" ? <InfoCard title="Modules">
        <p className="font-mono text-xs text-slate-300">
          {(facility.modules_enabled ?? []).join(", ") || "—"}
        </p>
      </InfoCard> : null}

      {activeTab === "overview" ? <InfoCard title="Provisioning run">
        {run ? (
          <div className="space-y-3">
            <Row label="Run ID" value={run.id} mono />
            <Row label="Status" value={run.status} />
            <Row label="Failure code" value={run.failure_code} />
            <Row label="Correlation" value={run.correlation_id} mono />
            <Row label="Mode" value={run.mode} />
            {(run.status === "FAILED" || run.status === "RUNNING") && run.id ? (
              <FacilityResumeButton runId={run.id} />
            ) : null}
            <div className="space-y-1 border-t border-slate-800 pt-3">
              {steps.map((s) => (
                <div key={s.step} className="flex justify-between text-xs">
                  <span className="font-mono text-slate-400">{s.step}</span>
                  <span
                    className={
                      s.status === "COMPLETE"
                        ? "text-green-400"
                        : s.status === "FAILED"
                          ? "text-red-400"
                          : "text-slate-500"
                    }
                  >
                    {s.status}
                    {s.error_code ? ` · ${s.error_code}` : ""}
                    {s.safe_error_message ? ` — ${s.safe_error_message}` : ""}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No provisioning run recorded.</p>
        )}
      </InfoCard> : null}

      {activeTab === "overview" && facility.facility_type === "pharmacy" ? (
        <InfoCard title="Pharmacy">
          <p className="text-sm text-slate-400">
            Workspace via <code className="text-[#E8B84B]">pharm.synapseos.tech/login?tenant=…</code>. POS and
            inventory remain on the Synapse Pharm product surface.
          </p>
        </InfoCard>
      ) : null}
      {activeTab === "overview" && facility.facility_type === "laboratory" ? (
        <InfoCard title="Laboratory">
          <p className="text-sm text-slate-400">
            Laboratory foundation modules only — analyzer transport is out of scope for this control-plane
            milestone.
          </p>
        </InfoCard>
      ) : null}
      {activeTab === "overview" && (facility.facility_type === "hospital" || !facility.facility_type) && (
        <InfoCard title="Hospital">
          <Link href={`/platform/hospitals/${facility.id}`} className="text-sm text-[#E8B84B] hover:underline">
            Open specialized hospital view
          </Link>
        </InfoCard>
      )}

      {activeTab === "overview" ? (
        <FacilityLifecyclePanel facilityId={id} facilityName={facility.name ?? facility.slug ?? id} />
      ) : null}

      {activeTab === "overview" ? <InfoCard title="Test Center">
        <Link href="/platform/test-center" className="text-sm text-[#E8B84B] hover:underline">
          Open Test Center suites
        </Link>
      </InfoCard> : null}

      {activeTab === "settings" || activeTab === "security" ? (
        <FacilityLifecyclePanel facilityId={id} facilityName={facility.name ?? facility.slug ?? id} />
      ) : null}
    </div>
  )
}

async function FacilityPeople({ tenantId }: { tenantId: string }) {
  const staffRows = await safeRows<{ id?: string; full_name?: string | null; email?: string | null; role?: string | null; department_id?: string | null; is_deleted?: boolean | null; two_factor_enabled?: boolean | null; last_sign_in_at?: string | null }>("profiles", "id, full_name, email, role, department_id, is_deleted, last_sign_in_at", { filters: [["tenant_id", tenantId], ["is_deleted", false]], limit: 200 })
  // MFA status comes from mfa_enrollments; profiles has no two_factor_enabled column.
  const staff = await withMfaStatus(platformAdminClient(), staffRows)
  const departments = await safeRows<{ id?: string; name?: string | null }>("departments", "id, name", { filters: [["tenant_id", tenantId]], limit: 100 })
  const departmentById = new Map(departments.map((department) => [department.id, department.name]))
  return <InfoCard title={`People (${staff.length})`}><div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Facility staff</caption><thead className="border-b border-slate-800 text-xs text-slate-500"><tr><th className="px-3 py-2">Name</th><th className="px-3 py-2">Email</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Section</th><th className="px-3 py-2">MFA</th><th className="px-3 py-2">Last login</th></tr></thead><tbody>{staff.map((person) => <tr key={person.id} className="border-b border-slate-800/70"><td className="px-3 py-3">{person.full_name ?? "—"}</td><td className="px-3 py-3">{person.email ?? "—"}</td><td className="px-3 py-3">{person.role ?? "—"}</td><td className="px-3 py-3">{departmentById.get(person.department_id ?? "") ?? "Unassigned"}</td><td className="px-3 py-3">{person.two_factor_enabled ? "Enabled" : "Not enabled"}</td><td className="px-3 py-3">{person.last_sign_in_at ? formatDate(person.last_sign_in_at) : "Never"}</td></tr>)}</tbody></table></div>{staff.length === 0 ? <p className="text-sm text-slate-500">No facility staff found.</p> : null}<InviteStaffForm tenantId={tenantId} departments={departments} /></InfoCard>
}

async function FacilityDepartments({ tenantId }: { tenantId: string }) {
  const departments = await safeRows<{ id?: string; name?: string | null; dept_type?: string | null; is_active?: boolean | null }>("departments", "id, name, dept_type, is_active", { filters: [["tenant_id", tenantId]], limit: 100 })
  return <InfoCard title={`Departments (${departments.length})`}><div className="grid gap-3 sm:grid-cols-2">{departments.map((department) => <div key={department.id} className="rounded-lg border border-slate-800 p-3"><p className="text-sm text-slate-200">{department.name}</p><p className="text-xs text-slate-500">{department.dept_type ?? "general"} · {department.is_active === false ? "Disabled" : "Active"}</p></div>)}</div></InfoCard>
}

function InfoCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">{title}</h2>
      {children}
    </section>
  )
}

function Row({ label, value, mono }: { label: string; value?: string | null; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className={`text-right text-slate-200 ${mono ? "font-mono text-xs" : ""}`}>{value ?? "—"}</span>
    </div>
  )
}
