export const dynamic = "force-dynamic"

import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { checkDatabaseLatency } from "../_lib/platform-data"

export default async function DatabaseControlPage() {
  await requirePlatformPage("/platform/database")
  const db = await checkDatabaseLatency()
  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Database control center"
        title="Operational metadata only"
        description="There is no generic production SQL console in the browser. This page reports connectivity and known schema facts."
      />
      <div className="grid gap-3 md:grid-cols-2">
        <article className="rounded-xl border border-subtle bg-surface p-4">
          <p className="text-xs uppercase text-muted-color">Connectivity</p>
          <p className="mt-2 text-lg font-semibold text-primary-color">{db.ok ? "Connected" : "NOT CONNECTED"}</p>
          <p className="text-xs text-muted-color">{db.latencyMs} ms probe</p>
        </article>
        <article className="rounded-xl border border-subtle bg-surface p-4">
          <p className="text-xs uppercase text-muted-color">Latest checked-in migration</p>
          <p className="mt-2 font-mono text-sm text-primary-color">20260828090000_synapse_exchange_lab_pathways_simulation</p>
        </article>
        <article className="rounded-xl border border-subtle bg-surface p-4">
          <p className="text-xs uppercase text-muted-color">SQL console</p>
          <p className="mt-2 text-sm text-muted-color">Disabled by design. Use reviewed migrations and service-role APIs.</p>
        </article>
        <article className="rounded-xl border border-subtle bg-surface p-4">
          <p className="text-xs uppercase text-muted-color">RLS</p>
          <p className="mt-2 text-sm text-muted-color">Coverage is not claimed as a hardcoded fraction. Inspect live policies before calling a table safe.</p>
        </article>
      </div>
    </div>
  )
}
