export const dynamic = "force-dynamic";

import Link from "next/link";
import { MapPinned, Power, Trash2, UploadCloud } from "lucide-react";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { formatDateTime, safeRows } from "../_lib/platform-data";
import { PharmacyEditModal } from "./PharmacyEditModal";
import { DomainCell } from "./DomainCell";
import { setPharmacyOperationalStatus, deletePharmacy } from "./actions";

type PharmacyRow = {
  id?: string;
  name?: string | null;
  slug?: string | null;
  facility_type?: string | null;
  district?: string | null;
  email?: string | null;
  phone?: string | null;
  plan?: string | null;
  status?: string | null;
  is_active?: boolean | null;
  is_network_member?: boolean | null;
  accepts_refill_requests?: boolean | null;
  network_listing_name?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
};

type PharmacyProfileRow = {
  tenant_id?: string | null;
  custom_domain?: string | null;
  custom_domain_verified?: boolean | null;
  default_domain?: string | null;
  domain_status?: string | null;
  domain_error?: string | null;
  domain_verification?: unknown[] | null;
  migrated_from?: string | null;
  migration_status?: string | null;
  migration_completed_at?: string | null;
  is_network_visible?: boolean | null;
  delivery_available?: boolean | null;
  contact_person?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
};

type OnboardingRow = {
  tenant_id?: string | null;
  current_step?: number | null;
  invite_token?: string | null;
  invite_sent_at?: string | null;
  invite_expires_at?: string | null;
};

function pharmacyRouteForSlug(slug?: string | null) {
  const cleanSlug = (slug || "pharmacy").replace(/^pharm-/, "");
  return `https://pharm.synapseos.tech/${cleanSlug}`;
}

export default async function PharmacyNetworkPage() {
  await requirePlatformPage("/platform/pharmacy-network");

  const [pharmacies, profiles, onboardingRows] = await Promise.all([
    safeRows<PharmacyRow>(
      "tenants",
      "id, name, slug, facility_type, district, email, phone, plan, status, is_active, is_network_member, accepts_refill_requests, network_listing_name, updated_at, created_at",
      {
        filters: [["facility_type", "pharmacy"]],
        orderBy: "updated_at",
        limit: 200,
      }
    ),
    safeRows<PharmacyProfileRow>(
      "pharmacy_profiles",
      "tenant_id, custom_domain, custom_domain_verified, default_domain, domain_status, domain_error, domain_verification, migrated_from, migration_status, migration_completed_at, is_network_visible, delivery_available, contact_person, contact_phone, contact_email",
      { limit: 1000 }
    ),
    safeRows<OnboardingRow>(
      "pharmacy_onboarding",
      "tenant_id, current_step, invite_token, invite_sent_at, invite_expires_at",
      { limit: 1000 }
    ),
  ]);

  const activePharmacies = pharmacies.filter((p) => p.status !== "deleted");
  const profileByTenant = new Map(profiles.map((p) => [p.tenant_id, p]));
  const onboardingByTenant = new Map(onboardingRows.map((r) => [r.tenant_id, r]));

  const onboardingInProgress = activePharmacies.filter((p) => {
    const step = onboardingByTenant.get(p.id ?? "")?.current_step ?? 0;
    return step > 0 && step < 5;
  }).length;

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Operations</p>
          <h1 className="mt-1 text-2xl font-bold text-primary-color">Pharmacies</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-color">
            Manage onboarded pharmacy tenants — status, domains, onboarding progress, and operational controls.
            Inventory is managed inside each pharmacy&apos;s own portal.
          </p>
        </div>
        <Link
          href="/platform/pharmacies/onboard"
          className="inline-flex items-center gap-2 rounded-xl bg-[#F97316] px-4 py-2.5 text-sm font-semibold text-[#07070A] transition hover:opacity-90"
        >
          <UploadCloud className="h-4 w-4" />
          Onboard pharmacy
        </Link>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Active pharmacies", activePharmacies.filter((p) => p.is_active !== false).length],
          ["Network members", activePharmacies.filter((p) => p.is_network_member).length],
          ["Accepting refills", activePharmacies.filter((p) => p.accepts_refill_requests).length],
          ["Onboarding in progress", onboardingInProgress],
        ].map(([label, value]) => (
          <article key={String(label)} className="rounded-xl border border-subtle bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-color">{label}</p>
            <p className="mt-2 font-display text-2xl font-bold tabular-nums text-[#F97316]">
              {Number(value).toLocaleString()}
            </p>
          </article>
        ))}
      </section>

      <article className="overflow-hidden rounded-xl border border-subtle bg-surface">
        <div className="flex items-center justify-between border-b border-subtle px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-primary-color">Connected pharmacies</h2>
            <p className="text-xs text-muted-color">Suspend, edit, or remove tenants from the network</p>
          </div>
          <MapPinned className="h-4 w-4 text-[#E8B84B]" />
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b border-subtle text-left text-xs uppercase tracking-wide text-muted-color">
              <tr>
                <th className="px-4 py-3">Pharmacy</th>
                <th className="px-4 py-3">District</th>
                <th className="px-4 py-3">Domain</th>
                <th className="px-4 py-3">Onboarding</th>
                <th className="px-4 py-3">Last activity</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-subtle">
              {activePharmacies.map((pharmacy) => {
                const pharmacyProfile = profileByTenant.get(pharmacy.id ?? "");
                const onboarding = onboardingByTenant.get(pharmacy.id ?? "");
                const defaultDomain = pharmacyProfile?.default_domain ?? pharmacyRouteForSlug(pharmacy.slug ?? pharmacy.id);
                const customDomain = pharmacyProfile?.custom_domain;
                const displayDomain = customDomain || defaultDomain;
                const isActive = pharmacy.is_active !== false && pharmacy.status !== "suspended";
                const step = onboarding?.current_step ?? 0;
                const onboardingLabel =
                  step >= 5 ? "Complete" : step > 0 ? `Step ${step} / 5` : "Not started";

                return (
                  <tr key={pharmacy.id ?? pharmacy.name} className="transition hover:bg-elevated/50">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-primary-color">{pharmacy.name ?? "Unnamed"}</p>
                      <p className="text-[10px] capitalize text-muted-color">{pharmacy.plan ?? "starter"} plan</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-secondary-color">{pharmacy.district ?? "—"}</td>
                    <td className="px-4 py-3">
                      <DomainCell
                        displayDomain={displayDomain}
                        isVerified={Boolean(pharmacyProfile?.custom_domain_verified)}
                        hasCustom={Boolean(customDomain)}
                      />
                    </td>
                    <td className="px-4 py-3 text-xs text-secondary-color">{onboardingLabel}</td>
                    <td className="px-4 py-3 text-xs text-muted-color">{formatDateTime(pharmacy.updated_at)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`rounded-full border px-2 py-0.5 text-xs ${
                          isActive
                            ? "border-green-500/25 bg-green-500/10 text-green-300"
                            : "border-red-500/25 bg-red-500/10 text-red-300"
                        }`}
                      >
                        {isActive ? (pharmacy.status ?? "active") : "suspended"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <PharmacyEditModal pharmacy={pharmacy} profile={pharmacyProfile} onboarding={onboarding} />

                        <form action={setPharmacyOperationalStatus}>
                          <input type="hidden" name="tenant_id" value={pharmacy.id ?? ""} />
                          <input type="hidden" name="status" value={isActive ? "suspended" : "active"} />
                          <input
                            type="hidden"
                            name="reason"
                            value={isActive ? "Platform admin suspended" : "Platform admin reactivated"}
                          />
                          <button
                            type="submit"
                            title={isActive ? "Suspend pharmacy" : "Reactivate pharmacy"}
                            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
                              isActive
                                ? "border-amber-500/30 text-amber-300 hover:border-amber-500/60"
                                : "border-green-500/30 text-green-300 hover:border-green-500/60"
                            }`}
                          >
                            <Power className="h-3 w-3" />
                            {isActive ? "Suspend" : "Reactivate"}
                          </button>
                        </form>

                        <details className="relative">
                          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-lg border border-red-500/30 px-2 py-1 text-xs text-red-400 transition hover:border-red-500/60">
                            <Trash2 className="h-3 w-3" />
                            Delete
                          </summary>
                          <div className="absolute bottom-full right-0 z-10 mb-1 w-44 rounded-xl border border-red-500/30 bg-surface p-3 shadow-xl">
                            <p className="mb-2 text-xs text-red-300">
                              Delete <strong>{pharmacy.name}</strong>? Cannot be undone.
                            </p>
                            <form action={deletePharmacy}>
                              <input type="hidden" name="tenant_id" value={pharmacy.id ?? ""} />
                              <button
                                type="submit"
                                className="w-full rounded-lg border border-red-500/40 bg-red-500/20 px-2 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/30"
                              >
                                Confirm delete
                              </button>
                            </form>
                          </div>
                        </details>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {activePharmacies.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-12 text-center">
                    <p className="text-sm text-muted-color">No pharmacies onboarded yet.</p>
                    <Link
                      href="/platform/pharmacies/onboard"
                      className="mt-3 inline-block text-sm font-semibold text-[#F97316]"
                    >
                      Onboard your first pharmacy →
                    </Link>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
