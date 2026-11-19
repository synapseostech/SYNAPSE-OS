export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound } from "next/navigation";
import { createServiceClient } from "../../../../lib/supabase/server";
import { requirePlatformPage } from "../../../../lib/platform/auth";
import { formatDateTime, safeRows } from "../../_lib/platform-data";

type TenantRow = {
  id: string;
  name?: string | null;
  slug?: string | null;
  facility_type?: string | null;
  type?: string | null;
  status?: string | null;
  plan?: string | null;
  district?: string | null;
  email?: string | null;
  phone?: string | null;
  created_at?: string | null;
  subscription_tier?: string | null;
};

type ModuleRow = {
  key: string;
  active: boolean;
  source: "hospital_modules" | "feature_flags";
};

export default async function PlatformHospitalDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ runId?: string }>;
}) {
  await requirePlatformPage("/platform/hospitals/[id]");
  const { id } = await params;
  const { runId } = await searchParams;
  const supabaseAdmin = createServiceClient();

  // Facilities list is tenant-authoritative — read tenants first (fixes list→detail mismatch).
  const { data: tenant } = await (supabaseAdmin as any)
    .from("tenants")
    .select(
      "id, name, slug, facility_type, type, status, plan, district, email, phone, created_at, subscription_tier"
    )
    .eq("id", id)
    .maybeSingle();

  if (!tenant) {
    notFound();
  }

  const facility = tenant as TenantRow;

  const [
    { data: hospitalModules },
    featureFlags,
    { data: hospitalLegacy },
    { data: provisionRun },
    { data: departments },
    { data: invite },
    { data: locations },
  ] = await Promise.all([
    (supabaseAdmin as any)
      .from("hospital_modules")
      .select("module_key, is_active")
      .or(`hospital_id.eq.${id},tenant_id.eq.${id}`)
      .order("module_key", { ascending: true }),
    safeRows<{ feature_key?: string | null; is_enabled?: boolean | null }>(
      "feature_flags",
      "feature_key, is_enabled",
      { filters: [["tenant_id", id]], limit: 200 }
    ),
    (supabaseAdmin as any)
      .from("hospitals")
      .select("id, name, subdomain, type, settings")
      .eq("id", id)
      .maybeSingle(),
    (supabaseAdmin as any)
      .from("facility_provisioning_runs")
      .select("id, status, mode, current_step, completed_at, failure_code, metadata")
      .eq("tenant_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    (supabaseAdmin as any)
      .from("departments")
      .select("id, name, dept_type, is_active")
      .eq("tenant_id", id)
      .limit(80),
    (supabaseAdmin as any)
      .from("facility_invitations")
      .select("id, status, email, expires_at, sent_at, accepted_at")
      .eq("tenant_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    (supabaseAdmin as any)
      .from("facility_locations")
      .select("id, name, location_type")
      .eq("tenant_id", id)
      .limit(100),
  ]);

  let provisionSteps: Array<{ step: string; status: string; safe_error_message?: string | null }> = [];
  const activeRunId = runId || provisionRun?.id;
  if (activeRunId) {
    const { data: steps } = await (supabaseAdmin as any)
      .from("facility_provisioning_steps")
      .select("step, status, safe_error_message")
      .eq("run_id", activeRunId)
      .order("created_at", { ascending: true });
    provisionSteps = steps ?? [];
  }

  const modules: ModuleRow[] = [];
  const seen = new Set<string>();

  for (const mod of hospitalModules ?? []) {
    const key = String(mod.module_key ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    modules.push({ key, active: Boolean(mod.is_active), source: "hospital_modules" });
  }

  for (const flag of featureFlags) {
    const key = String(flag.feature_key ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    modules.push({ key, active: Boolean(flag.is_enabled), source: "feature_flags" });
  }

  const settings = (hospitalLegacy?.settings ?? {}) as Record<string, unknown>;
  const isSynthetic = Boolean(settings.is_synthetic || provisionRun?.mode === "SYNTHETIC_ACCEPTANCE");
  const displayName = facility.name ?? hospitalLegacy?.name ?? "Facility";
  const slug = facility.slug ?? hospitalLegacy?.subdomain ?? null;
  const facilityType = facility.facility_type ?? facility.type ?? hospitalLegacy?.type ?? "facility";
  const status = facility.status ?? "unknown";
  const plan = facility.plan ?? facility.subscription_tier ?? "—";
  const contact = facility.email ?? "—";
  const incomplete =
    provisionRun && !["COMPLETE", "READY_WITH_WARNINGS"].includes(String(provisionRun.status));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Facility</p>
          <h1 className="mt-1 text-2xl font-bold">{displayName}</h1>
          <p className="text-sm text-slate-400">
            {slug ? `${slug}.synapseos.tech` : "No slug"} · {String(facilityType).replace(/_/g, " ")}
            {isSynthetic ? " · SYNTHETIC / TEST ONLY" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {incomplete ? (
            <Link
              href={`/platform/hospitals/new?name=${encodeURIComponent(displayName)}`}
              className="rounded-lg bg-[#F97316] px-3 py-1.5 text-sm font-semibold text-[#07070A]"
            >
              Continue onboarding
            </Link>
          ) : null}
          <Link
            href="/platform/test-center"
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500"
          >
            Test Center
          </Link>
          <Link
            href="/platform/hospitals"
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:border-slate-500"
          >
            ← Facilities
          </Link>
        </div>
      </div>

      {provisionRun ? (
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Provisioning</h2>
          <p className="mt-1 text-sm text-slate-400">
            Status <span className="text-slate-200">{provisionRun.status}</span>
            {provisionRun.mode ? ` · ${provisionRun.mode}` : ""}
            {provisionRun.current_step ? ` · step ${provisionRun.current_step}` : ""}
          </p>
          {provisionSteps.length > 0 ? (
            <div className="mt-3 grid gap-1 sm:grid-cols-2">
              {provisionSteps.map((s) => (
                <div
                  key={s.step}
                  className="flex justify-between rounded border border-slate-800 px-2 py-1 text-xs"
                >
                  <span className="font-mono text-slate-400">{s.step}</span>
                  <span
                    className={
                      s.status === "COMPLETE"
                        ? "text-emerald-300"
                        : s.status === "FAILED"
                          ? "text-red-300"
                          : "text-slate-400"
                    }
                  >
                    {s.status}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="grid gap-3 md:grid-cols-4">
        <article className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs text-slate-500">Plan</p>
          <p className="mt-1 text-lg text-slate-100">{plan}</p>
        </article>
        <article className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs text-slate-500">Status</p>
          <p className="mt-1 text-lg text-slate-100">{status}</p>
        </article>
        <article className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs text-slate-500">Invitation</p>
          <p className="mt-1 text-lg text-slate-100">{invite?.status ?? "—"}</p>
        </article>
        <article className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs text-slate-500">Departments / Locations</p>
          <p className="mt-1 text-lg text-slate-100">
            {(departments ?? []).length} / {(locations ?? []).length}
          </p>
        </article>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-300">Modules</h2>
          <p className="text-xs text-slate-500">Canonical hospital_modules keys</p>
        </div>
        {modules.length === 0 ? (
          <p className="text-sm text-slate-500">No hospital_modules or feature_flags rows for this tenant.</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {modules.map((mod) => (
              <div
                key={`${mod.source}:${mod.key}`}
                className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm"
              >
                <div>
                  <span className="text-slate-200">{mod.key}</span>
                  <p className="text-[10px] uppercase tracking-wide text-slate-500">{mod.source}</p>
                </div>
                <span className={mod.active ? "text-emerald-300" : "text-slate-500"}>
                  {mod.active ? "Active" : "Off"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {(departments ?? []).length > 0 ? (
        <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-300">
            Departments
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(departments ?? []).map((d: { id: string; name: string; dept_type?: string }) => (
              <div key={d.id} className="rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm">
                <p className="text-slate-200">{d.name}</p>
                <p className="text-[10px] uppercase tracking-wide text-slate-500">{d.dept_type ?? "—"}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <p className="text-xs text-slate-500">
        Tenant id <code className="text-slate-400">{facility.id}</code>
        {facility.created_at ? ` · created ${formatDateTime(facility.created_at)}` : null}
        {contact !== "—" ? <> · {contact}</> : null}
        {hospitalLegacy ? " · legacy hospitals row present" : " · no legacy hospitals row"}
      </p>
    </div>
  );
}
