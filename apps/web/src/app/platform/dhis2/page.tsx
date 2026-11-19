export const dynamic = "force-dynamic";

import { revalidatePath } from "next/cache";
import { DatabaseZap, Play, RefreshCcw } from "lucide-react";
import { requirePlatformAccess, requirePlatformPage } from "../../../lib/platform/auth";
import { formatDateTime } from "../_lib/platform-data";
import {
  loadDhis2MonitorState,
  processPendingExports,
  retryExportJob,
  triggerAggregateExport,
} from "@/lib/platform/dhis2-export-actions";

function statusClass(status: string | null | undefined) {
  if (status === "succeeded" || status === "success" || status === "pushed") {
    return "border-green-500/25 bg-green-500/10 text-green-300";
  }
  if (status === "failed" || status === "dead") return "border-red-500/25 bg-red-500/10 text-red-300";
  if (status === "running" || status === "pending") return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  return "border-slate-700 bg-slate-800 text-slate-300";
}

async function triggerExportAll() {
  "use server";
  const profile = await requirePlatformAccess("integration.manage");
  await triggerAggregateExport({
    actorId: profile.id,
    actorRole: profile.role ?? "platform_admin",
  });
  revalidatePath("/platform/dhis2");
}

async function retryExport(formData: FormData) {
  "use server";
  const profile = await requirePlatformAccess("integration.manage");
  const jobId = String(formData.get("job_id") ?? "");
  if (!jobId) return;
  await retryExportJob({
    actorId: profile.id,
    actorRole: profile.role ?? "platform_admin",
    jobId,
  });
  revalidatePath("/platform/dhis2");
}

async function drainPending() {
  "use server";
  const profile = await requirePlatformAccess("integration.manage");
  await processPendingExports({
    actorId: profile.id,
    actorRole: profile.role ?? "platform_admin",
  });
  revalidatePath("/platform/dhis2");
}

export default async function Dhis2ExportsPage() {
  await requirePlatformPage("/platform/dhis2");
  const state = await loadDhis2MonitorState();
  const jobs = state.jobs;
  const latest = jobs[0];
  const failures = jobs.filter((row) => row.status === "failed" || row.status === "dead").length;
  const modeLabel = state.mode === "live" ? "Live" : "Simulation";

  return (
    <div className="space-y-6">
      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Ministry Reporting</p>
          <h1 className="mt-2 text-2xl font-bold">DHIS2 Export Monitor</h1>
          <p className="mt-1 text-sm text-slate-400">
            Outbound aggregate DataValueSets only. Privacy-gated — no identifiable patient packets.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
        <form action={triggerExportAll}>
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl bg-[#F97316] px-4 py-2 text-sm font-bold text-[#07070A]"
          >
            <Play className="h-4 w-4" />
            Trigger aggregate export
          </button>
        </form>
        <form action={drainPending}>
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-200"
          >
            <RefreshCcw className="h-4 w-4" />
            Drain pending
          </button>
        </form>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {[
          ["Mode", modeLabel],
          ["Health", state.health.status],
          ["Last status", latest?.status ?? "none"],
          ["Records last run", Number(latest?.payload?.dataValues?.length ?? 0).toLocaleString()],
          ["Failures", failures.toLocaleString()],
          ["Mapping coverage", `${state.mappingCoverage.mapped}/${state.mappingCoverage.seeded}`],
          ["Last simulation", state.lastSuccessfulSimulation?.period ?? "none"],
        ].map(([label, value]) => (
          <article key={label} className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-2 text-xl font-bold text-[#F97316]">{value}</p>
          </article>
        ))}
      </section>

      {state.mode === "simulation" ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          Running in simulation mode — payloads are recorded locally and never sent to a national DHIS2 instance.
          Set <code className="font-mono text-xs">DHIS2_MODE=live</code> only with operator approval.
        </p>
      ) : null}

      <section className="grid gap-4 xl:grid-cols-[1fr_360px]">
        <article className="overflow-hidden rounded-xl border border-slate-800 bg-[#111117]">
          <div className="border-b border-slate-800 p-4">
            <h2 className="text-sm font-semibold">Export jobs</h2>
            <p className="mt-1 text-xs text-slate-500">
              Storage: {state.storage}. Capability: public_health.export_aggregate.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-[#07070A] text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Org unit</th>
                  <th className="px-4 py-3">Values</th>
                  <th className="px-4 py-3">Mode</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Error</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {jobs.map((row) => (
                  <tr key={row.id}>
                    <td className="px-4 py-3 font-mono text-xs text-slate-300">{row.period}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{row.orgUnit}</td>
                    <td className="px-4 py-3 text-slate-300">
                      {Number(row.payload?.dataValues?.length ?? 0).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-slate-400">{row.mode}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full border px-2 py-0.5 text-xs ${statusClass(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-slate-500">{row.lastError ?? "None"}</td>
                    <td className="px-4 py-3">
                      <form action={retryExport}>
                        <input type="hidden" name="job_id" value={row.id} />
                        <button
                          type="submit"
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-700 px-2 py-1 text-xs text-slate-300"
                        >
                          <RefreshCcw className="h-3 w-3" />
                          Retry
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
                {jobs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                      No DHIS2 export jobs yet. Trigger an aggregate export to run the simulation path.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </article>

        <aside className="space-y-4">
          <section className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <div className="mb-3 flex items-center gap-2">
              <DatabaseZap className="h-4 w-4 text-[#E8B84B]" />
              <h2 className="text-sm font-semibold">Connection</h2>
            </div>
            <p className="text-sm text-slate-300">{state.health.detail ?? state.health.status}</p>
            <p className="mt-1 text-xs text-slate-500">Checked {formatDateTime(state.health.checkedAt)}</p>
            <p className="mt-3 text-sm text-slate-300">Env</p>
            <p className="mt-1 font-mono text-xs text-slate-500">
              DHIS2_MODE={state.mode}
              <br />
              DHIS2_BASE_URL={process.env.DHIS2_BASE_URL || process.env.DHIS2_URL || "(unset)"}
            </p>
          </section>

          <section className="rounded-xl border border-slate-800 bg-[#111117] p-4">
            <h2 className="text-sm font-semibold">Mapping reference</h2>
            <div className="mt-3 space-y-2 text-xs">
              {[
                ["confirmed ICD-11 stem", "DHIS2 data element"],
                ["facility local org key", "DHIS2 org unit UID"],
                ["aggregate period (month)", "DHIS2 period YYYYMM"],
                ["privacy policy", "counts only — no names/IDs"],
              ].map(([source, target]) => (
                <div key={source} className="rounded-lg border border-slate-800 bg-[#07070A] p-3">
                  <p className="font-mono text-[#E8B84B]">{source}</p>
                  <p className="mt-1 text-slate-500">{target}</p>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </div>
  );
}
