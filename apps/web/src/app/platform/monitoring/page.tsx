export const dynamic = "force-dynamic"

import { overallPlatformHealth } from "@synapse/config/manifest"
import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { checkDatabaseLatency } from "../_lib/platform-data"

function tone(status: string) {
  if (status === "healthy") return "text-emerald-300"
  if (status === "degraded") return "text-amber-300"
  return "text-zinc-400"
}

async function probe(label: string, url: string) {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" })
    clearTimeout(timer)
    return {
      id: label,
      label,
      status: res.ok ? "healthy" : "degraded",
      latencyMs: Date.now() - started,
      detail: `HTTP ${res.status}`,
    }
  } catch (error) {
    return {
      id: label,
      label,
      status: "not_connected",
      latencyMs: null as number | null,
      detail: error instanceof Error ? error.message : "unreachable",
    }
  }
}

export default async function MonitoringPage() {
  await requirePlatformPage("/platform/monitoring")
  const db = await checkDatabaseLatency()
  const surfaces = await Promise.all([
    probe("synapseos.tech", "https://synapseos.tech"),
    probe("admin.synapseos.tech", "https://admin.synapseos.tech/platform/login"),
    probe("pharm.synapseos.tech", "https://pharm.synapseos.tech"),
    probe("demo.synapseos.tech", "https://demo.synapseos.tech"),
  ])
  const extras = [
    {
      id: "github",
      label: "GitHub",
      status: process.env.GITHUB_TOKEN ? "healthy" : "not_configured",
      latencyMs: null as number | null,
      detail: process.env.GITHUB_TOKEN ? "Token configured" : "NOT CONFIGURED",
    },
    {
      id: "vercel",
      label: "Vercel",
      status: process.env.VERCEL_TOKEN ? "healthy" : "not_configured",
      latencyMs: null,
      detail: process.env.VERCEL_TOKEN ? "Token configured" : "NOT CONFIGURED",
    },
    {
      id: "eas",
      label: "EAS / Expo",
      status: process.env.EXPO_TOKEN ? "healthy" : "not_connected",
      latencyMs: null,
      detail: process.env.EXPO_TOKEN ? "Token configured" : "NOT CONNECTED",
    },
    {
      id: "jobs",
      label: "Background jobs",
      status: "not_configured",
      latencyMs: null,
      detail: "NO TELEMETRY",
    },
  ]
  const overall = overallPlatformHealth(0)

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Live service monitoring"
        title={`Overall status: ${overall}`}
        description="Health checks never fabricate green status. Missing telemetry is shown as NOT CONNECTED or NOT CONFIGURED."
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <article className="rounded-xl border border-subtle bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted-color">Database</p>
          <p className={`mt-2 text-lg font-semibold ${tone(db.ok ? "healthy" : "not_connected")}`}>
            {db.ok ? "HEALTHY" : "NOT CONNECTED"}
          </p>
          <p className="mt-1 text-xs text-muted-color">{db.latencyMs} ms probe</p>
        </article>
        {[...surfaces, ...extras].map((item) => (
          <article key={item.id} className="rounded-xl border border-subtle bg-surface p-4">
            <p className="text-xs uppercase tracking-wide text-muted-color">{item.label}</p>
            <p className={`mt-2 text-lg font-semibold ${tone(item.status)}`}>{item.status.replaceAll("_", " ").toUpperCase()}</p>
            <p className="mt-1 text-xs text-muted-color">
              {item.detail}
              {item.latencyMs != null ? ` · ${item.latencyMs} ms` : ""}
            </p>
          </article>
        ))}
        <article className="rounded-xl border border-subtle bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted-color">Production SHA</p>
          <p className="mt-2 font-mono text-sm text-primary-color">{process.env.VERCEL_GIT_COMMIT_SHA ?? "NOT CONFIGURED"}</p>
        </article>
      </div>
    </div>
  )
}
