export const dynamic = "force-dynamic";

import Link from "next/link";
import { Building2, Download, Filter, MapPin, ShieldAlert } from "lucide-react";
import { requirePlatformAdmin } from "../../../lib/platform/auth";
import {
  formatDate,
  formatUGX,
  loadSubscriptionData,
  monthlyValueUGX,
  safeCount,
  safeRows,
  subscriptionStatusClass,
} from "../_lib/platform-data";
import {
  extendSubscriptionPeriod,
  reactivateSubscription,
  reassignSubscriptionPlan,
  suspendSubscription,
} from "../_lib/subscription-actions";

type TenantRow = {
  id?: string;
  name?: string | null;
  type?: string | null;
  district?: string | null;
  status?: string | null;
  subscription_tier?: string | null;
  monthly_fee_ugx?: number | string | null;
  bed_count?: number | string | null;
  contact_email?: string | null;
  created_at?: string | null;
};

type SubscriptionRow = {
  tenant_id?: string | null;
  plan?: string | null;
  status?: string | null;
  monthly_amount_ugx?: number | string | null;
};

type FeatureFlagRow = {
  tenant_id?: string | null;
  feature_key?: string | null;
  is_enabled?: boolean | null;
};

type ProfileRow = {
  tenant_id?: string | null;
  last_sign_in_at?: string | null;
};

type PatientRow = {
  tenant_id?: string | null;
};

function statusClass(status: string | null | undefined) {
  if (status === "active") return "border-green-500/25 bg-green-500/10 text-green-300";
  if (status === "trial") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  if (status === "suspended") return "border-red-500/25 bg-red-500/10 text-red-300";
  return "border-slate-700 bg-slate-800 text-slate-300";
}

function typeLabel(type: string | null | undefined) {
  if (!type) return "facility";
  return type.replace(/_/g, " ");
}

export default async function PlatformHospitalsPage() {
  await requirePlatformAdmin();

  const [tenants, subscriptions, flags, staffRows, patientRows, activeFacilities, suspendedFacilities, subData] = await Promise.all([
    safeRows<TenantRow>(
      "tenants",
      "id, name, type, district, status, subscription_tier, monthly_fee_ugx, bed_count, contact_email, created_at",
      { orderBy: "created_at", limit: 250 }
    ),
    safeRows<SubscriptionRow>("facility_subscriptions", "tenant_id, plan, status, monthly_amount_ugx", { limit: 1000 }),
    safeRows<FeatureFlagRow>("feature_flags", "tenant_id, feature_key, is_enabled", { filters: [["is_enabled", true]], limit: 5000 }),
    safeRows<ProfileRow>("profiles", "tenant_id, last_sign_in_at", { limit: 5000 }),
    safeRows<PatientRow>("patients", "tenant_id", { limit: 5000 }),
    safeCount("tenants", [["status", "active"]]),
    safeCount("tenants", [["status", "suspended"]]),
    loadSubscriptionData(),
  ]);

  const subscriptionMap = new Map(subscriptions.map((row) => [row.tenant_id, row]));
  const tenantSubMap = new Map(subData.subscriptions.map((row) => [row.tenant_id, row]));
  const assignablePlans = subData.plans
    .filter((plan) => plan.is_active !== false && plan.id && plan.slug)
    .sort((a, b) => (a.slug ?? "").localeCompare(b.slug ?? ""));

  const lastSignInByTenant = new Map<string, string>();
  for (const row of staffRows) {
    if (!row.tenant_id || !row.last_sign_in_at) continue;
    const current = lastSignInByTenant.get(row.tenant_id);
    if (!current || row.last_sign_in_at > current) lastSignInByTenant.set(row.tenant_id, row.last_sign_in_at);
  }
  const modulesByTenant = new Map<string, number>();
  for (const flag of flags) {
    if (!flag.tenant_id) continue;
    modulesByTenant.set(flag.tenant_id, (modulesByTenant.get(flag.tenant_id) ?? 0) + 1);
  }

  const staffByTenant = new Map<string, number>();
  for (const row of staffRows) {
    if (!row.tenant_id) continue;
    staffByTenant.set(row.tenant_id, (staffByTenant.get(row.tenant_id) ?? 0) + 1);
  }

  const patientsByTenant = new Map<string, number>();
  for (const row of patientRows) {
    if (!row.tenant_id) continue;
    patientsByTenant.set(row.tenant_id, (patientsByTenant.get(row.tenant_id) ?? 0) + 1);
  }

  // Legacy hospital subs (facility_subscriptions, already monthly) + SaaS subs
  // (tenant_subscriptions, normalized to monthly across billing cycles).
  const totalMrr =
    subscriptions
      .filter((row) => row.status === "active")
      .reduce((sum, row) => sum + Number(row.monthly_amount_ugx ?? 0), 0) + subData.mrr;

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Tenant Control</p>
          <h1 className="mt-2 text-2xl font-bold">Facilities</h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage hospitals, clinics, pharmacies, labs, subscription state, enabled modules, and operational risk.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300">
            <Download className="h-4 w-4" />
            Export
          </button>
          <Link href="/platform/hospitals/new" className="rounded-xl bg-[#F97316] px-4 py-2 text-sm font-semibold text-white hover:bg-[#EA6C0A]">
            Add facility
          </Link>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Total facilities", tenants.length.toLocaleString()],
          ["Active facilities", activeFacilities.toLocaleString()],
          ["Suspended", suspendedFacilities.toLocaleString()],
          ["Monthly revenue", formatUGX(totalMrr)],
          ["Districts covered", new Set(tenants.map((row) => row.district).filter(Boolean)).size.toLocaleString()],
        ].map(([label, value]) => (
          <article key={label} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-[#F97316]">{value}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr_340px]">
        <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
            <div>
              <h2 className="text-sm font-semibold">Facility Registry</h2>
              <p className="mt-1 text-xs text-slate-500">Search, filter, open details, suspend, or configure modules per tenant.</p>
            </div>
            <div className="inline-flex items-center gap-2 rounded-xl border border-slate-800 bg-[#07070A] px-3 py-2 text-xs text-slate-400">
              <Filter className="h-3.5 w-3.5 text-[#E8B84B]" />
              Type, district, plan, status filters ready
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Facility</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">District</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Modules</th>
                  <th className="px-4 py-3">Staff</th>
                  <th className="px-4 py-3">Patients</th>
                  <th className="px-4 py-3">Monthly</th>
                  <th className="px-4 py-3">Billing</th>
                  <th className="px-4 py-3">Period end</th>
                  <th className="px-4 py-3">Last payment</th>
                  <th className="px-4 py-3">Last sign-in</th>
                  <th className="px-4 py-3">Joined</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {tenants.map((tenant) => {
                  const subscription = subscriptionMap.get(tenant.id ?? "");
                  const tenantSub = tenantSubMap.get(tenant.id ?? "");
                  const tenantSubPlan = tenantSub ? subData.planMap.get(tenantSub.plan_id ?? "") : undefined;
                  const monthlyFee = tenantSubPlan
                    ? monthlyValueUGX(tenantSubPlan)
                    : Number(subscription?.monthly_amount_ugx ?? tenant.monthly_fee_ugx ?? 0);
                  const isSuspended = tenantSub?.status === "suspended";
                  return (
                    <tr key={tenant.id ?? tenant.name ?? crypto.randomUUID()} className="align-top">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-100">{tenant.name ?? "Unnamed facility"}</p>
                        <p className="mt-1 text-xs text-slate-500">{tenant.contact_email ?? "No contact email"}</p>
                      </td>
                      <td className="px-4 py-3 capitalize text-slate-300">{typeLabel(tenant.type)}</td>
                      <td className="px-4 py-3 text-slate-400">{tenant.district ?? "Unknown"}</td>
                      <td className="px-4 py-3 capitalize text-slate-300">{tenantSubPlan?.slug ?? subscription?.plan ?? tenant.subscription_tier ?? "unassigned"}</td>
                      <td className="px-4 py-3 text-slate-300">{modulesByTenant.get(tenant.id ?? "") ?? 0}</td>
                      <td className="px-4 py-3 text-slate-300">{staffByTenant.get(tenant.id ?? "") ?? 0}</td>
                      <td className="px-4 py-3 text-slate-300">{patientsByTenant.get(tenant.id ?? "") ?? 0}</td>
                      <td className="px-4 py-3 text-slate-300">{formatUGX(monthlyFee)}</td>
                      <td className="px-4 py-3">
                        {tenantSub ? (
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${subscriptionStatusClass(tenantSub.status)}`}>
                            {tenantSub.status ?? "unknown"}
                          </span>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-400">{tenantSub ? formatDate(tenantSub.current_period_end) : "—"}</td>
                      <td className="px-4 py-3 text-slate-400">{tenantSub?.last_payment_at ? formatDate(tenantSub.last_payment_at) : "—"}</td>
                      <td className="px-4 py-3 text-slate-400">{formatDate(lastSignInByTenant.get(tenant.id ?? ""))}</td>
                      <td className="px-4 py-3 text-slate-500">{formatDate(tenant.created_at)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs ${statusClass(tenant.status)}`}>
                          {tenant.status ?? "unknown"}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Link href={`/platform/hospitals/${tenant.id}`} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">
                            View
                          </Link>
                          <Link href={`/platform/hospitals/${tenant.id}?tab=modules`} className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">
                            Modules
                          </Link>
                          {tenantSub ? (
                            <>
                              {isSuspended ? (
                                <form action={reactivateSubscription}>
                                  <input type="hidden" name="tenantId" value={tenant.id ?? ""} />
                                  <button type="submit" className="rounded-lg border border-green-500/40 px-2 py-1 text-xs text-green-300">
                                    Reactivate
                                  </button>
                                </form>
                              ) : (
                                <form action={suspendSubscription}>
                                  <input type="hidden" name="tenantId" value={tenant.id ?? ""} />
                                  <button type="submit" className="rounded-lg border border-red-500/40 px-2 py-1 text-xs text-red-300">
                                    Suspend
                                  </button>
                                </form>
                              )}
                              <form action={extendSubscriptionPeriod}>
                                <input type="hidden" name="tenantId" value={tenant.id ?? ""} />
                                <input type="hidden" name="days" value="30" />
                                <button type="submit" className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">
                                  Extend 30d
                                </button>
                              </form>
                              <form action={reassignSubscriptionPlan} className="flex items-center gap-1">
                                <input type="hidden" name="tenantId" value={tenant.id ?? ""} />
                                <select
                                  key={tenantSub.plan_id ?? ""}
                                  name="planId"
                                  defaultValue={tenantSub.plan_id ?? ""}
                                  className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-300"
                                >
                                  {tenantSub.plan_id && !assignablePlans.some((plan) => plan.id === tenantSub.plan_id) ? (
                                    <option value={tenantSub.plan_id}>{tenantSubPlan?.slug ?? "current plan"}</option>
                                  ) : null}
                                  {assignablePlans.map((plan) => (
                                    <option key={plan.id} value={plan.id}>
                                      {plan.slug}
                                      {(plan.slug ?? "").startsWith("hospital_") ? " (legacy)" : ""}
                                    </option>
                                  ))}
                                </select>
                                <button type="submit" className="rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300">
                                  Set plan
                                </button>
                              </form>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {tenants.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="px-4 py-8 text-center text-slate-500">
                      No facility tenants found. Connect the tenants table to activate this registry.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>

        <aside className="space-y-4">
          <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-[#E8B84B]" />
              <h2 className="text-sm font-semibold">Facility Detail Tabs</h2>
            </div>
            <div className="mt-4 space-y-2 text-sm text-slate-400">
              {["Overview metadata", "Staff and invitations", "Module toggles", "Billing history", "Custom domain", "Danger zone"].map((item) => (
                <p key={item} className="rounded-lg border border-slate-800 bg-[#07070A] px-3 py-2">{item}</p>
              ))}
            </div>
          </article>

          <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-[#E8B84B]" />
              <h2 className="text-sm font-semibold">Uganda Coverage</h2>
            </div>
            <div className="mt-4 space-y-2">
              {Array.from(new Set(tenants.map((row) => row.district).filter(Boolean))).slice(0, 8).map((district) => (
                <div key={district} className="flex justify-between rounded-lg border border-slate-800 bg-[#07070A] px-3 py-2 text-sm">
                  <span className="text-slate-300">{district}</span>
                  <span className="text-[#E8B84B]">{tenants.filter((row) => row.district === district).length}</span>
                </div>
              ))}
              {tenants.length === 0 ? <p className="text-sm text-slate-500">No district data yet.</p> : null}
            </div>
          </article>

          <article className="rounded-xl border border-red-500/25 bg-red-500/10 p-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-red-300" />
              <h2 className="text-sm font-semibold text-red-100">Risk Controls</h2>
            </div>
            <p className="mt-2 text-sm text-red-200/80">
              Suspend/unsuspend, domain verification, deletion confirmation, and audit logging are part of the facility control surface.
            </p>
          </article>
        </aside>
      </section>
    </div>
  );
}
