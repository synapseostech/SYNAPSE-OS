export const dynamic = "force-dynamic";

import Link from "next/link";
import { requirePlatformPage } from "@/lib/platform/auth";
import {
  formatBytes,
  importStateLabel,
  loadIndividualsSummary,
  loadTenantOverview,
  TENANT_PRODUCTS,
  type TenantOverviewRow,
  type TenantProduct,
} from "@/lib/platform/tenants.server";
import { PlatformPageHeader } from "../_components/platform-page-header";
import { formatDate } from "../_lib/platform-data";

const PRODUCT_LABEL: Record<TenantProduct, string> = {
  pharmacy: "Pharmacies",
  hospital: "Hospitals",
  lab: "Labs",
  clinic: "Clinics",
  other: "Other",
};

const STATUS_FILTERS = ["all", "active", "suspended", "onboarding", "test"] as const;

function stateOf(row: TenantOverviewRow): "active" | "suspended" | "onboarding" | "archived" {
  const lc = String(row.lifecycleStatus ?? "").toUpperCase();
  if (lc === "ARCHIVED" || lc === "DELETION_PENDING" || lc === "DELETED") return "archived";
  if (lc === "SUSPENDED" || row.status === "suspended" || !row.isActive) return "suspended";
  if (row.status === "provisioning" || row.onboardingCompleted === false) return "onboarding";
  return "active";
}

const STATE_CLASS: Record<ReturnType<typeof stateOf>, string> = {
  active: "border-green-500/25 bg-green-500/10 text-green-300",
  suspended: "border-red-500/25 bg-red-500/10 text-red-300",
  onboarding: "border-amber-500/25 bg-amber-500/10 text-amber-300",
  archived: "border-slate-600 bg-slate-800/60 text-slate-400",
};

function daysAgo(iso: string | null): string {
  if (!iso) return "Never";
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (d <= 0) return "Today";
  if (d === 1) return "Yesterday";
  return `${d} days ago`;
}

export default async function TenantsControlCentrePage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string; state?: string; q?: string }>;
}) {
  await requirePlatformPage("/platform/tenants");
  const params = await searchParams;
  const product = (TENANT_PRODUCTS as readonly string[]).includes(params.product ?? "") ? (params.product as TenantProduct) : null;
  const state = (STATUS_FILTERS as readonly string[]).includes(params.state ?? "") ? params.state! : "all";
  const q = (params.q ?? "").trim().toLowerCase();

  const [{ rows, source }, individuals] = await Promise.all([loadTenantOverview(), loadIndividualsSummary()]);

  const byProduct = new Map<TenantProduct, TenantOverviewRow[]>();
  for (const r of rows) byProduct.set(r.product, [...(byProduct.get(r.product) ?? []), r]);

  const filtered = rows.filter((r) => {
    if (product && r.product !== product) return false;
    if (state === "test" && !r.isSynthetic) return false;
    if (state !== "all" && state !== "test" && stateOf(r) !== state) return false;
    if (q && !`${r.name} ${r.slug ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });

  const totalStorage = rows.reduce((sum, r) => sum + (r.storageBytes ?? 0), 0);

  const href = (next: { product?: string | null; state?: string }) => {
    const sp = new URLSearchParams();
    const p = next.product === undefined ? product : next.product;
    const s = next.state ?? state;
    if (p) sp.set("product", p);
    if (s && s !== "all") sp.set("state", s);
    if (q) sp.set("q", q);
    const qs = sp.toString();
    return `/platform/tenants${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Customers"
        title="All tenants"
        description="Every pharmacy, hospital and lab on Synapse, with its plan, users, activity, storage and Tally imports. Open one to suspend, reset onboarding, resend invites or read its audit trail."
      />

      {source === "fallback" ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Storage per tenant is not measured yet: apply migration 20261119150000_platform_control_centre.sql.
        </p>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Tenants by product">
        {(["pharmacy", "hospital", "lab"] as TenantProduct[]).map((p) => {
          const list = byProduct.get(p) ?? [];
          const active30 = list.filter((r) => r.lastActivityAt && Date.now() - new Date(r.lastActivityAt).getTime() < 30 * 86_400_000).length;
          return (
            <Link
              key={p}
              href={href({ product: product === p ? null : p })}
              className={`rounded-xl border bg-[#111117] p-4 transition hover:border-[#F97316]/40 ${product === p ? "border-[#F97316]/60" : "border-slate-800"}`}
            >
              <p className="text-xs uppercase tracking-wide text-slate-500">{PRODUCT_LABEL[p]}</p>
              <p className="mt-2 text-2xl font-bold text-[#F97316]">{list.length}</p>
              <p className="mt-1 text-xs text-slate-500">{active30} active in 30 days</p>
            </Link>
          );
        })}
        <div className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Individuals (My Health)</p>
          <p className="mt-2 text-2xl font-bold text-[#F97316]">{individuals.count}</p>
          <p className="mt-1 text-xs text-slate-500">{individuals.activeLast30Days} active in 30 days</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#111117] p-4">
          <p className="text-xs uppercase tracking-wide text-slate-500">Tenant storage</p>
          <p className="mt-2 text-2xl font-bold text-[#F97316]">{source === "rpc" ? formatBytes(totalStorage) : "—"}</p>
          <p className="mt-1 text-xs text-slate-500">
            <Link href="/platform/health" className="hover:underline">Free-tier usage →</Link>
          </p>
        </div>
      </section>

      <section className="flex flex-wrap items-center gap-2" aria-label="Filters">
        {STATUS_FILTERS.map((s) => (
          <Link
            key={s}
            href={href({ state: s })}
            className={`rounded-full border px-3 py-1 text-xs capitalize ${state === s ? "border-[#F97316] text-[#F97316]" : "border-slate-700 text-slate-400"}`}
          >
            {s === "test" ? "Test tenants" : s}
          </Link>
        ))}
        <form className="ml-auto" action="/platform/tenants">
          {product ? <input type="hidden" name="product" value={product} /> : null}
          {state !== "all" ? <input type="hidden" name="state" value={state} /> : null}
          <label className="sr-only" htmlFor="tenant-search">Search tenants</label>
          <input
            id="tenant-search"
            name="q"
            defaultValue={params.q ?? ""}
            placeholder="Search by name or subdomain"
            className="rounded-lg border border-slate-700 bg-[#07070A] px-3 py-1.5 text-sm"
          />
        </form>
      </section>

      <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Tenants</caption>
            <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Tenant</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Users</th>
                <th className="px-4 py-3">Last activity</th>
                <th className="px-4 py-3 text-right">Storage</th>
                <th className="px-4 py-3">Tally import</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {filtered.map((r) => {
                const st = stateOf(r);
                return (
                  <tr key={r.tenantId} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">
                      <Link href={`/platform/tenants/${r.tenantId}`} className="font-medium text-slate-100 hover:text-[#F97316]">
                        {r.name}
                      </Link>
                      <span className="block text-xs text-slate-500">
                        {r.slug ?? "—"}
                        {r.isSynthetic ? <span className="ml-2 rounded bg-sky-500/10 px-1.5 text-sky-300">test</span> : null}
                      </span>
                    </td>
                    <td className="px-4 py-3 capitalize text-slate-300">{r.product}</td>
                    <td className="px-4 py-3 capitalize text-slate-300">{r.plan ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs capitalize ${STATE_CLASS[st]}`}>{st}</span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{r.userCount}</td>
                    <td className="px-4 py-3 text-slate-400" title={r.lastActivityAt ? formatDate(r.lastActivityAt) : undefined}>
                      {daysAgo(r.lastActivityAt)}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-slate-300">{formatBytes(r.storageBytes)}</td>
                    <td className="px-4 py-3 text-slate-400">
                      {r.product === "pharmacy" ? (
                        <span title={r.lastImportFile ?? undefined}>
                          {importStateLabel(r)}
                          {r.lastImportAt ? <span className="block text-xs text-slate-500">{daysAgo(r.lastImportAt)}</span> : null}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">No tenants match these filters.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </article>
    </div>
  );
}
