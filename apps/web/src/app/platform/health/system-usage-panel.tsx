import Link from "next/link";
import { formatBytes } from "@/lib/platform/tenants.server";
import {
  FREE_TIER,
  loadActiveProjects,
  loadApkReleases,
  loadRecentErrors,
  loadSlowQueries,
  loadSystemUsage,
  usageLevel,
  type UsageLevel,
} from "@/lib/platform/system-usage.server";
import { formatDateTime } from "../_lib/platform-data";

const LEVEL_BAR: Record<UsageLevel, string> = { ok: "bg-emerald-500", warn: "bg-amber-400", over: "bg-red-500" };
const LEVEL_TEXT: Record<UsageLevel, string> = { ok: "text-emerald-300", warn: "text-amber-300", over: "text-red-300" };
const LEVEL_WORD: Record<UsageLevel, string> = { ok: "Within free tier", warn: "Over 80% of free tier", over: "Over the free-tier limit" };

function Meter({ label, used, limit, usedText, limitText, note }: { label: string; used: number; limit: number; usedText: string; limitText: string; note?: string }) {
  const level = usageLevel(used, limit);
  const pct = Math.min(100, Math.round((used / limit) * 100));
  return (
    <article className={`rounded-xl border p-4 ${level === "ok" ? "border-slate-800 bg-[#111117]" : level === "warn" ? "border-amber-500/40 bg-amber-500/5" : "border-red-500/50 bg-red-500/5"}`}>
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-xl font-bold text-slate-100">
        {usedText} <span className="text-sm font-normal text-slate-500">of {limitText}</span>
      </p>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`${label} ${pct}%`}>
        <div className={`h-full ${LEVEL_BAR[level]}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1 text-xs ${LEVEL_TEXT[level]}`}>{pct}% · {LEVEL_WORD[level]}</p>
      {note ? <p className="mt-1 text-xs text-slate-500">{note}</p> : null}
    </article>
  );
}

export async function SystemUsagePanel() {
  const [usage, slow, projects, errors, apk] = await Promise.all([
    loadSystemUsage(),
    loadSlowQueries(8),
    loadActiveProjects(),
    loadRecentErrors(),
    loadApkReleases(5),
  ]);
  const latest = apk?.releases[0] ?? null;
  const topBucket = usage?.storage[0];

  return (
    <div className="space-y-6">
      <section aria-labelledby="free-tier-heading" className="space-y-3">
        <h2 id="free-tier-heading" className="text-sm font-semibold">Free-tier usage</h2>
        {usage ? (
          <div className="grid gap-3 md:grid-cols-3">
            <Meter
              label="Database"
              used={usage.databaseBytes}
              limit={FREE_TIER.databaseBytes}
              usedText={formatBytes(usage.databaseBytes)}
              limitText="500 MB"
              note={`${usage.connections} open connections · measured ${formatDateTime(usage.measuredAt)}`}
            />
            <Meter
              label="File storage"
              used={usage.storageBytes}
              limit={FREE_TIER.storageBytes}
              usedText={formatBytes(usage.storageBytes)}
              limitText="1 GB"
              note={topBucket ? `Largest bucket: ${topBucket.bucket} (${formatBytes(topBucket.bytes)}, ${topBucket.objects} files)` : undefined}
            />
            {projects.configured ? (
              <Meter
                label="Active Supabase projects"
                used={projects.active}
                limit={FREE_TIER.activeProjects}
                usedText={String(projects.active)}
                limitText="2"
                note={projects.error ?? projects.names.join(", ")}
              />
            ) : (
              <article className="rounded-xl border border-slate-800 bg-[#111117] p-4">
                <p className="text-xs uppercase tracking-wide text-slate-500">Active Supabase projects</p>
                <p className="mt-2 text-sm text-slate-400">
                  Set <code className="font-mono">SUPABASE_ACCESS_TOKEN</code> on the web deployment to count them here (free plan allows 2).
                </p>
              </article>
            )}
          </div>
        ) : (
          <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
            Database and storage size need migration 20261119150000_platform_control_centre.sql.
          </p>
        )}
        {usage && usage.largestTables.length ? (
          <details className="rounded-xl border border-slate-800 bg-[#111117]">
            <summary className="cursor-pointer p-4 text-sm">Largest tables</summary>
            <table className="min-w-full border-t border-slate-800 text-sm">
              <tbody className="divide-y divide-slate-800">
                {usage.largestTables.map((t) => (
                  <tr key={t.table}>
                    <td className="px-4 py-2 font-mono text-xs">{t.table}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatBytes(t.bytes)}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-slate-500">~{t.rows.toLocaleString()} rows</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="apk-heading" className="rounded-xl border border-slate-800 bg-[#111117] p-5">
        <h2 id="apk-heading" className="text-sm font-semibold">Android app releases</h2>
        {apk === null ? (
          <p className="mt-2 text-sm text-slate-400">The app_releases table is not in this database yet (migration 20261118120000).</p>
        ) : latest ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm">
              Latest <span className="font-semibold text-[#F97316]">{latest.version}</span> (build {latest.versionCode}) · published {formatDateTime(latest.publishedAt)} via {latest.source.replace("_", " ")}
              {latest.minimumVersion ? <> · installs older than {latest.minimumVersion} must update</> : null}
            </p>
            <p className="text-xs text-slate-500">
              Announcement emails for this release: {apk.emailed} sent{apk.failed ? `, ${apk.failed} failed` : ""}.{" "}
              <a href={latest.apkUrl} className="text-[#F97316] hover:underline" rel="noopener noreferrer">APK link</a>
            </p>
            <ul className="divide-y divide-slate-800 text-sm">
              {apk.releases.slice(1).map((r) => (
                <li key={r.versionCode} className="flex justify-between py-1.5 text-slate-400">
                  <span>{r.version} ({r.versionCode})</span>
                  <span className="text-xs">{formatDateTime(r.publishedAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-400">No APK has been recorded yet. The next EAS build will appear here.</p>
        )}
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="errors-heading" className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 id="errors-heading" className="text-sm font-semibold">Recent errors (7 days)</h2>
          <ul className="mt-3 divide-y divide-slate-800 text-sm">
            {errors.map((e, i) => (
              <li key={`${e.at}-${i}`} className="py-2">
                <div className="flex justify-between gap-2 text-xs text-slate-500">
                  <span>{e.source}</span>
                  <span>{formatDateTime(e.at)}</span>
                </div>
                {e.href ? (
                  <Link href={e.href} className="text-slate-200 hover:text-[#F97316]">{e.message}</Link>
                ) : (
                  <p className="text-slate-200">{e.message}</p>
                )}
              </li>
            ))}
          </ul>
          {errors.length === 0 ? <p className="mt-2 text-sm text-slate-500">No failed imports, invite or release emails, or open incidents.</p> : null}
        </section>

        <section aria-labelledby="slow-heading" className="rounded-xl border border-slate-800 bg-[#111117] p-5">
          <h2 id="slow-heading" className="text-sm font-semibold">Slowest queries (app traffic)</h2>
          {slow === null ? (
            <p className="mt-2 text-sm text-slate-400">Needs migration 20261119150000_platform_control_centre.sql.</p>
          ) : (
            <ul className="mt-3 divide-y divide-slate-800 text-sm">
              {slow.map((q, i) => (
                <li key={i} className="py-2">
                  <p className="truncate font-mono text-xs text-slate-300" title={q.query}>{q.query}</p>
                  <p className="text-xs text-slate-500">
                    {q.meanMs.toLocaleString()} ms average · {q.calls.toLocaleString()} calls · {Math.round(q.totalMs / 1000).toLocaleString()} s total
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-slate-500">From pg_stat_statements since its last reset; constants are normalised away.</p>
        </section>
      </div>
    </div>
  );
}
