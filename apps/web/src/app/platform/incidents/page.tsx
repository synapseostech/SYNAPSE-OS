export const dynamic = "force-dynamic"

import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { safeRows } from "../_lib/platform-data"

export default async function IncidentsPage() {
  await requirePlatformPage("/platform/incidents")
  const incidents = await safeRows<{
    id?: string
    service?: string
    severity?: string
    status?: string
    impact?: string
    started_at?: string
  }>("platform_incidents", "id, service, severity, status, impact, started_at", { orderBy: "started_at", limit: 40 })

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Incidents"
        title="Lightweight incident log"
        description="Statuses: INVESTIGATING, IDENTIFIED, MONITORING, RESOLVED. Empty means there is no fabricated uptime incident stream."
      />
      {incidents.length === 0 ? (
        <p className="rounded-2xl border border-subtle bg-surface p-6 text-sm text-muted-color">No incidents recorded.</p>
      ) : (
        <ul className="space-y-2">
          {incidents.map((incident) => (
            <li key={incident.id} className="rounded-xl border border-subtle bg-surface px-4 py-3">
              <p className="text-sm font-medium text-primary-color">
                {incident.severity} · {incident.service} · {incident.status}
              </p>
              <p className="text-xs text-muted-color">{incident.impact}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
