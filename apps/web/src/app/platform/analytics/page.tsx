export const dynamic = "force-dynamic";

import { Activity, BarChart3, Building2, CheckCircle2, Clock, TrendingUp, Users, Zap } from "lucide-react";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { createServiceClient } from "../../../lib/supabase/server";
import { formatDateTime } from "../_lib/platform-data";

function safeRows<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

function safeNum(v: unknown): number {
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

type OnboardingRow = {
  tenant_id: string;
  current_step: number | null;
  account_created_at: string | null;
  invite_sent_at: string | null;
  tenant?: { name: string | null } | null;
};

type AuditRow = {
  id: string;
  action: string | null;
  created_at: string | null;
  metadata: Record<string, unknown> | null;
};

type TenantRow = {
  id: string;
  name: string | null;
  plan: string | null;
  is_active: boolean | null;
  created_at: string | null;
};

export default async function AnalyticsPage() {
  await requirePlatformPage("/platform/analytics");
  const db = createServiceClient() as any;

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: totalPharmacies },
    { count: activePharmacies },
    { count: pharmacyAdmins },
    { count: newUsers7d },
    { count: newPharmacies30d },
    { count: totalSessions },
    { data: onboardingRaw },
    { data: recentTenantsRaw },
    { data: recentEventsRaw },
    { count: totalProducts },
    { count: totalTransactions },
  ] = await Promise.all([
    db.from("tenants").select("id", { count: "exact", head: true }).eq("facility_type", "pharmacy"),
    db.from("tenants").select("id", { count: "exact", head: true }).eq("facility_type", "pharmacy").eq("is_active", true),
    db.from("profiles").select("id", { count: "exact", head: true }).eq("role", "pharmacy_admin"),
    db.from("profiles").select("id", { count: "exact", head: true }).gt("created_at", sevenDaysAgo),
    db.from("tenants").select("id", { count: "exact", head: true }).eq("facility_type", "pharmacy").gt("created_at", thirtyDaysAgo),
    db.from("synapse_sessions").select("id", { count: "exact", head: true }),
    db.from("pharmacy_onboarding")
      .select("tenant_id, current_step, account_created_at, invite_sent_at, tenant:tenants(name)")
      .order("account_created_at", { ascending: false })
      .limit(20),
    db.from("tenants")
      .select("id, name, plan, is_active, created_at")
      .eq("facility_type", "pharmacy")
      .order("created_at", { ascending: false })
      .limit(10),
    db.from("audit_log")
      .select("id, action, created_at, metadata")
      .order("created_at", { ascending: false })
      .limit(15),
    db.from("pharmacy_products").select("id", { count: "exact", head: true }),
    db.from("pharmacy_transactions").select("id", { count: "exact", head: true }),
  ]);

  const onboarding = safeRows<OnboardingRow>(onboardingRaw);
  const recentTenants = safeRows<TenantRow>(recentTenantsRaw);
  const recentEvents = safeRows<AuditRow>(recentEventsRaw);

  // Onboarding funnel
  const funnel = [1, 2, 3, 4, 5].map((step) => ({
    step,
    label: ["Account Created", "Profile Setup", "Store Setup", "Products Added", "Completed"][step - 1],
    count: onboarding.filter((o) => safeNum(o.current_step) >= step).length,
  }));
  const maxFunnel = funnel[0]?.count || 1;

  const kpis = [
    { label: "Total Pharmacies", value: safeNum(totalPharmacies), icon: Building2, color: "text-[#E8B84B]", border: "border-[#E8B84B]/20", bg: "bg-[#E8B84B]/5" },
    { label: "Active", value: safeNum(activePharmacies), icon: CheckCircle2, color: "text-green-400", border: "border-green-500/20", bg: "bg-green-500/5" },
    { label: "Pharmacy Admins", value: safeNum(pharmacyAdmins), icon: Users, color: "text-blue-400", border: "border-blue-500/20", bg: "bg-blue-500/5" },
    { label: "New Users (7d)", value: safeNum(newUsers7d), icon: TrendingUp, color: "text-[#F97316]", border: "border-[#F97316]/20", bg: "bg-[#F97316]/5" },
    { label: "New Pharmacies (30d)", value: safeNum(newPharmacies30d), icon: Activity, color: "text-purple-400", border: "border-purple-500/20", bg: "bg-purple-500/5" },
    { label: "Total Products", value: safeNum(totalProducts), icon: BarChart3, color: "text-cyan-400", border: "border-cyan-500/20", bg: "bg-cyan-500/5" },
    { label: "Transactions", value: safeNum(totalTransactions), icon: Zap, color: "text-pink-400", border: "border-pink-500/20", bg: "bg-pink-500/5" },
    { label: "Sessions", value: safeNum(totalSessions), icon: Clock, color: "text-slate-400", border: "border-slate-500/20", bg: "bg-slate-500/5" },
  ];

  function stepBadge(step: number | null) {
    const s = safeNum(step);
    if (s >= 5) return "border-green-500/30 bg-green-500/10 text-green-300";
    if (s >= 3) return "border-yellow-500/30 bg-yellow-500/10 text-yellow-300";
    return "border-slate-600 bg-slate-800/50 text-slate-400";
  }

  function stepLabel(step: number | null) {
    const labels = ["—", "Account created", "Profile setup", "Store setup", "Products added", "Completed"];
    return labels[safeNum(step)] ?? "—";
  }

  function planBadge(plan: string | null) {
    if (plan === "enterprise") return "border-[#E8B84B]/30 bg-[#E8B84B]/10 text-[#E8B84B]";
    if (plan === "professional") return "border-purple-500/30 bg-purple-500/10 text-purple-300";
    if (plan === "starter") return "border-blue-500/30 bg-blue-500/10 text-blue-300";
    return "border-slate-600 bg-slate-800/50 text-slate-400";
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Platform Analytics</p>
        <h1 className="mt-2 text-2xl font-bold">Analytics</h1>
        <p className="mt-1 text-sm text-slate-400">Real-time data across all pharmacies and the Synapse platform.</p>
      </section>

      {/* KPI grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((kpi) => {
          const Icon = kpi.icon;
          return (
            <div key={kpi.label} className={`rounded-xl border ${kpi.border} ${kpi.bg} p-4`}>
              <div className="flex items-center justify-between">
                <p className={`text-xs font-semibold uppercase tracking-wide ${kpi.color}`}>{kpi.label}</p>
                <Icon className={`h-4 w-4 ${kpi.color}`} />
              </div>
              <p className={`mt-2 text-3xl font-bold ${kpi.color}`}>{kpi.value.toLocaleString()}</p>
            </div>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Onboarding funnel */}
        <section className="rounded-xl border border-slate-800 bg-[#111117]">
          <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
            <BarChart3 className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="font-semibold">Onboarding Funnel</h2>
            <span className="ml-auto text-xs text-slate-500">{safeNum(totalPharmacies)} total</span>
          </div>
          <div className="space-y-3 p-5">
            {funnel.map(({ step, label, count }) => (
              <div key={step}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-slate-400">{step}. {label}</span>
                  <span className="font-medium text-slate-300">{count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-[#F97316] to-[#E8B84B] transition-all"
                    style={{ width: `${maxFunnel > 0 ? (count / maxFunnel) * 100 : 0}%` }}
                  />
                </div>
              </div>
            ))}
            {onboarding.length === 0 && (
              <p className="py-4 text-center text-sm text-slate-500">No pharmacies onboarded yet.</p>
            )}
          </div>
        </section>

        {/* Recent pharmacies */}
        <section className="rounded-xl border border-slate-800 bg-[#111117]">
          <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
            <Building2 className="h-4 w-4 text-[#E8B84B]" />
            <h2 className="font-semibold">Recent Pharmacies</h2>
          </div>
          {recentTenants.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">No pharmacies yet.</p>
          ) : (
            <div className="divide-y divide-slate-800/50">
              {recentTenants.map((t) => (
                <div key={t.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-sm font-medium text-slate-200">{t.name ?? "—"}</p>
                    <p className="text-xs text-slate-500">{t.created_at ? formatDateTime(t.created_at) : "—"}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${planBadge(t.plan)}`}>
                      {t.plan ?? "—"}
                    </span>
                    <span className={`h-2 w-2 rounded-full ${t.is_active ? "bg-green-400" : "bg-slate-600"}`} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Onboarding detail table */}
      <section className="rounded-xl border border-slate-800 bg-[#111117]">
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
          <Users className="h-4 w-4 text-[#E8B84B]" />
          <h2 className="font-semibold">Onboarding Progress</h2>
        </div>
        {onboarding.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No onboarding records yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">Pharmacy</th>
                  <th className="px-5 py-3 font-medium">Current Step</th>
                  <th className="px-5 py-3 font-medium">Account Created</th>
                </tr>
              </thead>
              <tbody>
                {onboarding.map((o) => (
                  <tr key={o.tenant_id} className="border-b border-slate-800/50 hover:bg-slate-800/20">
                    <td className="px-5 py-3 font-medium text-slate-200">
                      {(o.tenant as any)?.name ?? o.tenant_id.slice(0, 8) + "…"}
                    </td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${stepBadge(o.current_step)}`}>
                        {stepLabel(o.current_step)}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">
                      {o.account_created_at ? formatDateTime(o.account_created_at) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Live activity feed */}
      <section className="rounded-xl border border-slate-800 bg-[#111117]">
        <div className="flex items-center gap-3 border-b border-slate-800 px-5 py-4">
          <Activity className="h-4 w-4 text-[#E8B84B]" />
          <h2 className="font-semibold">Live Activity Feed</h2>
          <span className="ml-auto text-xs text-slate-500">Last 15 events</span>
        </div>
        {recentEvents.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-slate-500">No platform events recorded yet.</p>
        ) : (
          <div className="divide-y divide-slate-800/50">
            {recentEvents.map((e) => (
              <div key={e.id} className="flex items-center justify-between px-5 py-3">
                <div className="flex items-center gap-3">
                  <div className="h-1.5 w-1.5 rounded-full bg-[#E8B84B]" />
                  <span className="text-sm text-slate-300">{e.action ?? "event"}</span>
                </div>
                <span className="text-xs text-slate-500">
                  {e.created_at ? formatDateTime(e.created_at) : "—"}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
