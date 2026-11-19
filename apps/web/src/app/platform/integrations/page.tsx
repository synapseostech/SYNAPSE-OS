export const dynamic = "force-dynamic"

import { INTEGRATIONS } from "@synapse/config/manifest"
import { createSimulationAdapterSet } from "@synapse/interop"
import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { StatusBadge } from "../../../components/StatusBadge"

export default async function IntegrationsPage() {
  await requirePlatformPage("/platform/integrations")
  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Integration control center"
        title="Connectors and adapters"
        description="Do not claim a live national integration unless one actually exists. Last exchange metrics stay empty until telemetry is connected."
      />
      <div className="overflow-x-auto rounded-2xl border border-subtle">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-elevated text-[11px] uppercase tracking-wide text-muted-color">
            <tr>
              <th className="px-4 py-3">Connector</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Last success</th>
              <th className="px-4 py-3">Last failure</th>
              <th className="px-4 py-3">Messages today</th>
              <th className="px-4 py-3">Error rate</th>
            </tr>
          </thead>
          <tbody>
            {INTEGRATIONS.map((item) => (
              <tr key={item.id} className="border-t border-subtle">
                <td className="px-4 py-3">
                  <p className="font-medium text-primary-color">{item.name}</p>
                  <p className="text-xs text-muted-color">{item.standard ?? item.id}</p>
                </td>
                <td className="px-4 py-3">
                  <StatusBadge status={item.status} kind="integration" />
                </td>
                <td className="px-4 py-3 text-xs text-muted-color">NO TELEMETRY</td>
                <td className="px-4 py-3 text-xs text-muted-color">NO TELEMETRY</td>
                <td className="px-4 py-3 text-xs text-muted-color">NOT CONNECTED</td>
                <td className="px-4 py-3 text-xs text-muted-color">NOT CONNECTED</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <PlatformPageHeader
        eyebrow="Simulation adapters"
        title="Overlay connectors for the Simulation Lab"
        description="These adapters are labelled simulation. They are not live eAFYA, ALIS, UgandaEMR or DHIS2 integrations."
      />
      <div className="overflow-x-auto rounded-2xl border border-subtle">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-elevated text-[11px] uppercase tracking-wide text-muted-color">
            <tr>
              <th className="px-4 py-3">Adapter</th>
              <th className="px-4 py-3">Mode</th>
              <th className="px-4 py-3">Version</th>
              <th className="px-4 py-3">Health</th>
              <th className="px-4 py-3">Capabilities</th>
            </tr>
          </thead>
          <tbody>
            {createSimulationAdapterSet().map((adapter) => {
              const identity = adapter.identify()
              const health = adapter.health()
              return (
                <tr key={identity.id} className="border-t border-subtle">
                  <td className="px-4 py-3">
                    <p className="font-medium text-primary-color">{identity.name}</p>
                    <p className="text-xs text-muted-color">{identity.id}</p>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-color">{identity.mode}</td>
                  <td className="px-4 py-3 text-xs text-muted-color">{identity.version}</td>
                  <td className="px-4 py-3 text-xs uppercase text-muted-color">{health.status}</td>
                  <td className="px-4 py-3 text-xs text-muted-color">{adapter.capabilities().join(", ")}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
