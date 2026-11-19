export const dynamic = "force-dynamic";

import Link from "next/link";
import { requirePlatformPage } from "../../../lib/platform/auth";
import { getProductionTruth } from "../../../lib/platform/production-truth";
import { getHospitalPilotRc1Pulse } from "../../../lib/platform/rc1-pulse";
import { PlatformPageHeader } from "../_components/platform-page-header";

export default async function DeploymentsPage() {
  await requirePlatformPage("/platform/deployments");
  const truth = await getProductionTruth();
  const rc1 = getHospitalPilotRc1Pulse();
  const prodDeploy = truth.vercelDeployments.deployments[0];

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Deployments"
        title="Production truth — where code is running"
        description="GitHub main → Vercel production → this process → remote migration ledger. Missing credentials show NOT_CONFIGURED — never fake green."
      />

      <section className="rounded-xl border border-subtle bg-surface p-4">
        <p className="text-xs uppercase text-muted-color">Release alignment</p>
        <p className="mt-2 font-mono text-lg font-semibold text-primary-color">{truth.releaseAlignment.status}</p>
        <p className="mt-1 text-xs text-muted-color">{truth.releaseAlignment.detail}</p>
      </section>

      <section className="rounded-xl border border-[#F97316]/40 bg-surface p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-[#F97316]">Hospital Pilot RC1 pulse</p>
            <p className="mt-2 font-mono text-2xl font-semibold text-primary-color">{rc1.status}</p>
            <p className="mt-1 text-xs text-muted-color">{rc1.detail}</p>
          </div>
          <p className="font-mono text-sm text-secondary-color">
            {rc1.passed}/{rc1.total} files · live {rc1.livePassed}/{rc1.liveTotal}
          </p>
        </div>
        <p className="mt-2 text-[11px] text-muted-color">
          File presence ≠ live workflow. Domain/http PASS is not browser/RLS acceptance.
        </p>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rc1.gates.map((gate) => (
            <li
              key={gate.id}
              className="rounded-lg border border-subtle px-3 py-2 text-xs text-secondary-color"
            >
              <span
                className={
                  gate.status === "PASS"
                    ? "text-emerald-400"
                    : gate.status === "STALE" || gate.status === "UNVERIFIED"
                      ? "text-orange-400"
                      : "text-amber-400"
                }
              >
                {gate.status}
              </span>{" "}
              <span className="uppercase tracking-wide text-muted-color">{gate.proofKind}</span>{" "}
              <span className="text-primary-color">{gate.label}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[
          {
            label: "GitHub main SHA",
            value: truth.githubMain.shortSha ?? truth.githubMain.status,
            detail: truth.githubMain.detail,
          },
          {
            label: "Vercel production SHA",
            value: prodDeploy?.shortSha ?? truth.vercelDeployments.status,
            detail: truth.vercelDeployments.detail,
          },
          {
            label: "This process SHA",
            value: truth.processDeploy.shortSha ?? "NOT CONFIGURED",
            detail: truth.processDeploy.detail,
          },
          {
            label: "GitHub ↔ Vercel",
            value: truth.releaseAlignment.githubVsVercel.status,
            detail: truth.releaseAlignment.githubVsVercel.detail,
          },
          {
            label: "GitHub ↔ process",
            value: truth.releaseAlignment.githubVsProcess.status,
            detail: truth.releaseAlignment.githubVsProcess.detail,
          },
          {
            label: "Repo migration head",
            value: truth.repoMigration.version ?? truth.repoMigration.status,
            detail: truth.repoMigration.detail,
          },
          {
            label: "Remote migration head",
            value: truth.remoteMigration.version ?? truth.remoteMigration.status,
            detail: truth.remoteMigration.detail,
          },
          {
            label: "Repo ↔ remote migrations",
            value: truth.releaseAlignment.repoVsRemoteMigration.status,
            detail: truth.releaseAlignment.repoVsRemoteMigration.detail,
          },
          {
            label: "Production state",
            value: prodDeploy?.state ?? "—",
            detail: prodDeploy?.url ?? "No deployment URL",
          },
          {
            label: "Checked at",
            value: new Date(truth.checkedAt).toLocaleString(),
            detail: "Live probe timestamp",
          },
        ].map((card) => (
          <article key={card.label} className="rounded-xl border border-subtle bg-surface p-4">
            <p className="text-xs uppercase text-muted-color">{card.label}</p>
            <p className="mt-2 font-mono text-sm font-semibold text-primary-color">{card.value}</p>
            <p className="mt-1 text-xs text-muted-color">{card.detail}</p>
          </article>
        ))}
      </section>

      <section className="rounded-xl border border-subtle bg-surface p-4">
        <h2 className="text-sm font-semibold text-primary-color">Credential status</h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {(
            [
              ["GITHUB_TOKEN / GH_TOKEN", truth.githubMain.status !== "NOT_CONFIGURED"],
              ["VERCEL_TOKEN + VERCEL_PROJECT_ID", truth.vercelDeployments.status !== "NOT_CONFIGURED"],
              ["VERCEL_GIT_COMMIT_SHA", Boolean(truth.processDeploy.sha)],
              ["synapse_remote_migration_head RPC", truth.remoteMigration.status === "HEALTHY"],
            ] as const
          ).map(([label, ok]) => (
            <p key={label} className="text-sm text-secondary-color">
              <span className={ok ? "text-emerald-300" : "text-red-300"}>{ok ? "✓" : "✗"}</span> {label}
            </p>
          ))}
        </div>
        <Link href="/platform/health" className="mt-4 inline-block text-xs font-semibold text-[#F97316] hover:underline">
          Full health probes →
        </Link>
      </section>
    </div>
  );
}
