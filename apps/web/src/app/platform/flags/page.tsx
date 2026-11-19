export const dynamic = "force-dynamic";

import { Flag, History, Save } from "lucide-react";
import { createServiceClient } from "../../../lib/supabase/server";
import { requirePlatformAccess, requirePlatformPage } from "../../../lib/platform/auth";
import { FEATURE_KEYS, formatDateTime, logPlatformEvent, safeRows } from "../_lib/platform-data";

type TenantRow = {
  id?: string;
  name?: string | null;
  type?: string | null;
  status?: string | null;
};

type FeatureFlagRow = {
  id?: string;
  tenant_id?: string | null;
  feature_key?: string | null;
  is_enabled?: boolean | null;
  enabled_by?: string | null;
  enabled_at?: string | null;
  notes?: string | null;
  created_at?: string | null;
};

const FEATURE_LABELS: Record<(typeof FEATURE_KEYS)[number], string> = {
  telemedicine_video: "LiveKit video consultations",
  insurance_copilot: "Insurance claims and pre-auth workflow",
  ai_clinical_assist: "Gemini clinical assist during encounters",
  pharmacy_network: "Inventory sync to Synapse Pharm network",
  advanced_analytics: "Extended reporting and exports",
  wearable_sync: "BLE and wearable ingestion",
  dhis2_export: "Ministry DHIS2 export",
  sms_reminders: "Africa's Talking appointment reminders",
};

async function saveFeatureFlag(formData: FormData) {
  "use server";
  const profile = await requirePlatformAccess("feature_flag.manage");

  const tenantId = String(formData.get("tenant_id") ?? "");
  const featureKey = String(formData.get("feature_key") ?? "");
  const isEnabled = formData.get("is_enabled") === "on";
  const notes = String(formData.get("notes") ?? "");

  if (!featureKey) return;

  const supabaseAdmin = createServiceClient();
  await (supabaseAdmin as any).from("feature_flags").upsert(
    {
      tenant_id: tenantId || null,
      feature_key: featureKey,
      is_enabled: isEnabled,
      enabled_by: profile.id,
      enabled_at: isEnabled ? new Date().toISOString() : null,
      notes: notes || null,
    },
    { onConflict: "tenant_id,feature_key" }
  );

  await logPlatformEvent({
    actorId: profile.id,
    action: isEnabled ? "feature_flag.enabled" : "feature_flag.disabled",
    entityType: "feature_flag",
    entityId: tenantId || featureKey,
    tenantId: tenantId || null,
    metadata: { feature_key: featureKey, tenant_id: tenantId || null, is_enabled: isEnabled, notes: notes || null },
  });
}

function flagKey(tenantId: string | null | undefined, featureKey: string | null | undefined) {
  return `${tenantId ?? "global"}:${featureKey ?? ""}`;
}

export default async function PlatformFlagsPage() {
  await requirePlatformPage("/platform/flags");

  const [tenants, flags] = await Promise.all([
    safeRows<TenantRow>("tenants", "id, name, type, status", { orderBy: "name", ascending: true, limit: 80 }),
    safeRows<FeatureFlagRow>("feature_flags", "id, tenant_id, feature_key, is_enabled, enabled_by, enabled_at, notes, created_at", {
      orderBy: "enabled_at",
      limit: 5000,
    }),
  ]);

  const flagMap = new Map(flags.map((flag) => [flagKey(flag.tenant_id, flag.feature_key), flag]));
  const enabledCount = flags.filter((flag) => flag.is_enabled).length;

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Runtime Control</p>
          <h1 className="mt-2 text-2xl font-bold">Feature Flags</h1>
          <p className="mt-1 text-sm text-slate-400">
            Roll out AI, telemedicine, pharmacy sync, DHIS2, SMS, and beta modules globally or tenant-by-tenant.
          </p>
        </div>
        <div className="rounded-xl border border-[#E8B84B]/30 bg-[#E8B84B]/10 px-4 py-2 text-sm font-semibold text-[#E8B84B]">
          {enabledCount.toLocaleString()} enabled overrides
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Core feature keys", FEATURE_KEYS.length],
          ["Facilities visible", tenants.length],
          ["Stored overrides", flags.length],
          ["Enabled flags", enabledCount],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-2xl font-bold text-[#F97316]">{Number(value).toLocaleString()}</p>
          </article>
        ))}
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
          <div className="flex items-center gap-2">
            <Flag className="h-4 w-4 text-[#E8B84B]" />
            <div>
              <h2 className="text-sm font-semibold">Feature Toggle Matrix</h2>
              <p className="mt-1 text-xs text-slate-500">Global controls plus the first 80 facilities for focused rollout.</p>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1100px] text-sm">
            <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="sticky left-0 z-10 bg-[#07070A] px-4 py-3">Feature</th>
                <th className="px-4 py-3">Global</th>
                {tenants.slice(0, 10).map((tenant) => (
                  <th key={tenant.id ?? tenant.name ?? crypto.randomUUID()} className="min-w-44 px-4 py-3">{tenant.name ?? "Unnamed"}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {FEATURE_KEYS.map((featureKey) => {
                const globalFlag = flagMap.get(flagKey(null, featureKey));
                return (
                  <tr key={featureKey}>
                    <td className="sticky left-0 z-10 bg-[#111117] px-4 py-3">
                      <p className="font-mono text-xs text-[#E8B84B]">{featureKey}</p>
                      <p className="mt-1 max-w-64 text-xs text-slate-500">{FEATURE_LABELS[featureKey]}</p>
                    </td>
                    <td className="px-4 py-3">
                      <form action={saveFeatureFlag} className="flex items-center gap-2">
                        <input type="hidden" name="feature_key" value={featureKey} />
                        <input type="checkbox" name="is_enabled" defaultChecked={Boolean(globalFlag?.is_enabled)} className="h-4 w-4 accent-[#F97316]" />
                        <button type="submit" className="rounded-lg border border-slate-700 p-1.5 text-slate-300" aria-label={`Save global ${featureKey}`}>
                          <Save className="h-3.5 w-3.5" />
                        </button>
                      </form>
                    </td>
                    {tenants.slice(0, 10).map((tenant) => {
                      const tenantFlag = flagMap.get(flagKey(tenant.id, featureKey));
                      return (
                        <td key={`${tenant.id}:${featureKey}`} className="px-4 py-3">
                          <form action={saveFeatureFlag} className="flex items-center gap-2">
                            <input type="hidden" name="tenant_id" value={tenant.id ?? ""} />
                            <input type="hidden" name="feature_key" value={featureKey} />
                            <input type="checkbox" name="is_enabled" defaultChecked={Boolean(tenantFlag?.is_enabled)} className="h-4 w-4 accent-[#F97316]" />
                            <button type="submit" className="rounded-lg border border-slate-700 p-1.5 text-slate-300" aria-label={`Save ${featureKey} for ${tenant.name}`}>
                              <Save className="h-3.5 w-3.5" />
                            </button>
                          </form>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-slate-800 bg-[#111117] p-4">
        <div className="mb-4 flex items-center gap-2">
          <History className="h-4 w-4 text-[#E8B84B]" />
          <h2 className="text-sm font-semibold">Recent Flag Changes</h2>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {flags.slice(0, 9).map((flag) => (
            <article key={flag.id ?? flagKey(flag.tenant_id, flag.feature_key)} className="rounded-lg border border-slate-800 bg-[#07070A] p-3">
              <p className="font-mono text-xs text-[#E8B84B]">{flag.feature_key ?? "unknown_flag"}</p>
              <p className="mt-1 text-sm text-slate-300">{flag.is_enabled ? "Enabled" : "Disabled"} for {flag.tenant_id ?? "global rollout"}</p>
              <p className="mt-1 text-xs text-slate-500">{formatDateTime(flag.enabled_at ?? flag.created_at)}</p>
            </article>
          ))}
          {flags.length === 0 ? <p className="text-sm text-slate-500">No stored feature flag changes yet.</p> : null}
        </div>
      </section>
    </div>
  );
}
