export const dynamic = "force-dynamic";

import { requirePlatformPage } from "../../../lib/platform/auth";
import { createServiceClient } from "../../../lib/supabase/server";
import { formatDateTime, safeCount } from "../_lib/platform-data";
import { PlatformHealthClient } from "./health-client";
import { PlatformPageHeader } from "../_components/platform-page-header";
import { SystemUsagePanel } from "./system-usage-panel";

function db() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createServiceClient() as any;
}

async function countWhere(
  table: string,
  apply: (query: any) => any, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<number> {
  try {
    const { count, error } = await apply(db().from(table).select("id", { count: "exact", head: true }));
    return error ? 0 : count ?? 0;
  } catch {
    return 0;
  }
}

async function getStandingAudit() {
  const now = Date.now();
  const otpCutoff = new Date(now - 15 * 60 * 1000).toISOString();
  const resetCutoff = new Date(now - 60 * 60 * 1000).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    posSalesTotal,
    posSales30d,
    profilesTotal,
    profilesSignedIn,
    staleOtps,
    staleResetTokens,
    sweepRun,
    mobileSessionsActive,
    pushTokens,
    pharmacyTenants,
  ] = await Promise.all([
    safeCount("pharmacy_pos_sales"),
    countWhere("pharmacy_pos_sales", (q) => q.gte("created_at", thirtyDaysAgo)),
    safeCount("profiles"),
    countWhere("profiles", (q) => q.not("last_sign_in_at", "is", null)),
    countWhere("auth_otps", (q) => q.lt("created_at", otpCutoff)),
    countWhere("password_reset_tokens", (q) => q.lt("created_at", resetCutoff)),
    db()
      .from("platform_billing_config")
      .select("value, updated_at")
      .eq("key", "billing_sweep_last_run")
      .maybeSingle()
      .then((res: { data: { value?: Record<string, unknown>; updated_at?: string } | null }) => res.data)
      .catch(() => null),
    countWhere("synapse_sessions", (q) =>
      q.eq("app", "mobile").is("revoked_at", null).gt("expires_at", new Date().toISOString()),
    ),
    safeCount("mobile_push_tokens"),
    countWhere("tenants", (q) => q.eq("facility_type", "pharmacy")),
  ]);

  return {
    posSalesTotal,
    posSales30d,
    profilesSignedIn,
    profilesNeverSignedIn: Math.max(profilesTotal - profilesSignedIn, 0),
    staleOtps,
    staleResetTokens,
    sweepLastRun: sweepRun?.updated_at ?? null,
    sweepSummary: sweepRun?.value ?? null,
    mobileSessionsActive,
    pushTokens,
    pharmacyTenants,
  };
}

export default async function PlatformHealthPage() {
  await requirePlatformPage("/platform/health");
  const audit = await getStandingAudit();

  const cards: Array<{ label: string; value: string; detail: string; alert?: boolean }> = [
    {
      label: "Pharmacy tenants",
      value: audit.pharmacyTenants.toLocaleString(),
      detail: "facility_type = pharmacy",
    },
    {
      label: "POS sales (all time)",
      value: audit.posSalesTotal.toLocaleString(),
      detail: `${audit.posSales30d.toLocaleString()} in last 30 days`,
    },
    {
      label: "Mobile sessions (active)",
      value: audit.mobileSessionsActive.toLocaleString(),
      detail: "synapse_sessions app=mobile, unrevoked, unexpired",
    },
    {
      label: "Push tokens registered",
      value: audit.pushTokens.toLocaleString(),
      detail: "mobile_push_tokens rows",
    },
    {
      label: "Profiles signed in",
      value: audit.profilesSignedIn.toLocaleString(),
      detail: `${audit.profilesNeverSignedIn.toLocaleString()} never signed in`,
      alert: audit.profilesSignedIn === 0,
    },
    {
      label: "Stale OTP rows (>15 min)",
      value: audit.staleOtps.toLocaleString(),
      detail: "Purged by the nightly billing sweep",
      alert: audit.staleOtps > 50,
    },
    {
      label: "Stale reset tokens (>60 min)",
      value: audit.staleResetTokens.toLocaleString(),
      detail: "Purged by the nightly billing sweep",
      alert: audit.staleResetTokens > 50,
    },
    {
      label: "Billing sweep last run",
      value: audit.sweepLastRun ? formatDateTime(audit.sweepLastRun) : "Never recorded",
      detail: "Nightly 00:15 Africa/Kampala via Vercel Cron",
      alert: !audit.sweepLastRun,
    },
  ];

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="System"
        title="System health"
        description="Free-tier usage, recent errors, slow queries and the Android release, then live product signals and runtime health across Synapse apps."
      />

      <SystemUsagePanel />

      <h2 className="pt-2 text-sm font-semibold">Product signals</h2>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <article
            key={card.label}
            className={`rounded-xl border p-4 ${card.alert ? "border-amber-500/40 bg-amber-500/5" : "border-slate-800 bg-[#111117]"}`}
          >
            <p className="text-xs uppercase tracking-wide text-slate-500">{card.label}</p>
            <p className={`mt-2 text-xl font-bold ${card.alert ? "text-amber-300" : "text-[#F97316]"}`}>{card.value}</p>
            <p className="mt-1 text-xs text-slate-500">{card.detail}</p>
          </article>
        ))}
      </section>

      <PlatformHealthClient />
    </div>
  );
}
