export const dynamic = "force-dynamic";

import Link from "next/link";
import { requirePlatformPage } from "@/lib/platform/auth";
import { getProductionTruth } from "@/lib/platform/production-truth";
import { PRODUCT_MANIFEST, statusLabel } from "@synapse/config/manifest";
import { safeCount, safeRows, formatDateTime } from "../_lib/platform-data";
import { roleLabel, isObserverRole } from "@/lib/platform/rbac";

export default async function PlatformPerformancePage() {
  const actor = await requirePlatformPage("/platform/performance");
  const truth = await getProductionTruth();

  const [tenantCount, activeTenants, auditRecent] = await Promise.all([
    safeCount("tenants"),
    safeCount("tenants", [["is_active", true]]),
    safeRows<{ action: string; created_at: string; new_value: Record<string, unknown> | null }>(
      "audit_log",
      "action, created_at, new_value",
      { orderBy: "created_at", limit: 12 }
    ),
  ]);

  const sanitizedFeed = (auditRecent ?? [])
    .filter((row) => {
      const action = (row.action ?? "").toLowerCase();
      return !action.includes("password") && !action.includes("patient") && !action.includes("phi");
    })
    .slice(0, 8);

  return (
    <div className="space-y-6">
      <section>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Stakeholder View</p>
        <h1 className="mt-2 text-2xl font-bold">SYNAPSE Performance</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-400">
          High-level platform health and development progress for {roleLabel(actor.platformRole)} access.
          {isObserverRole(actor.platformRole)
            ? " Read-only — no production mutations or clinical PHI."
            : null}
        </p>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Platform DB", truth.database.status, truth.database.detail],
          ["GitHub main", truth.githubMain.shortSha ?? "—", truth.githubMain.detail],
          ["Deploy SHA", truth.processDeploy.shortSha ?? "—", truth.processDeploy.detail],
          ["Facilities", String(activeTenants), `${tenantCount} total tenants`],
        ].map(([label, value, detail]) => (
          <article key={String(label)} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-xl font-bold text-[#F97316]">{value}</p>
            <p className="mt-1 text-xs text-slate-500">{detail}</p>
          </article>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 className="text-sm font-semibold">Product Maturity</h2>
          <ul className="mt-4 space-y-3">
            {PRODUCT_MANIFEST.products.map((product) => (
              <li key={product.id} className="flex items-center justify-between border-b border-slate-800/60 pb-2 text-sm">
                <span>{product.name}</span>
                <span className="text-slate-400">{statusLabel(product.status)}</span>
              </li>
            ))}
          </ul>
        </article>

        <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 className="text-sm font-semibold">Module Readiness</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {truth.modules.slice(0, 10).map((mod) => (
              <li key={mod.id} className="flex justify-between">
                <Link href={mod.href as string} className="text-slate-200 hover:text-[#F97316]">{mod.label}</Link>
                <span className="text-slate-500">{mod.status}</span>
              </li>
            ))}
          </ul>
        </article>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 className="text-sm font-semibold">Integrations & AI</h2>
          <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <dt className="text-slate-500">OpenRouter</dt>
            <dd>{truth.openRouter.status}</dd>
            <dt className="text-slate-500">ICD-11</dt>
            <dd>{truth.icd11.status}</dd>
            <dt className="text-slate-500">Vercel</dt>
            <dd>{truth.vercelDeployments.status}</dd>
            <dt className="text-slate-500">SHA parity</dt>
            <dd>{truth.shaComparison.status}</dd>
          </dl>
        </article>

        <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 className="text-sm font-semibold">Quick Links</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              ["/platform/test-center", "Test Center"],
              ["/platform/deployments", "Deployments"],
              ["/platform/incidents", "Incidents"],
              ["/platform/registry", "Product Registry"],
              ["/platform/health", "Platform Health"],
            ].map(([href, label]) => (
              <Link
                key={href}
                href={href as string}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-[#F97316]/40"
              >
                {label}
              </Link>
            ))}
          </div>
        </article>
      </section>

      <article className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <h2 className="text-sm font-semibold">Control-Plane Activity (sanitized)</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {sanitizedFeed.map((row, i) => (
            <li key={`${row.action}-${i}`} className="flex justify-between border-b border-slate-800/40 pb-2">
              <span>{row.action}</span>
              <span className="text-slate-500">{formatDateTime(row.created_at)}</span>
            </li>
          ))}
          {sanitizedFeed.length === 0 ? (
            <li className="text-slate-500">No recent platform events.</li>
          ) : null}
        </ul>
      </article>
    </div>
  );
}
