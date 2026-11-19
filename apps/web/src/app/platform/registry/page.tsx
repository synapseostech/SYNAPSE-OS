export const dynamic = "force-dynamic"

import { ALL_CAPABILITIES, INTEGRATIONS, PRODUCT_MANIFEST } from "@synapse/config/manifest"
import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { StatusBadge } from "../../../components/StatusBadge"

export default async function ProductRegistryPage() {
  await requirePlatformPage("/platform/registry")

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Product registry"
        title="Every SYNAPSE project, with engineering status"
        description={`Manifest ${PRODUCT_MANIFEST.version} · updated ${PRODUCT_MANIFEST.updated}. Marketing and admin share this source.`}
      />
      <div className="overflow-x-auto rounded-2xl border border-subtle">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-elevated text-[11px] uppercase tracking-wide text-muted-color">
            <tr>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Kind</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Owner</th>
              <th className="px-4 py-3">Telemetry</th>
              <th className="px-4 py-3">Limitation</th>
            </tr>
          </thead>
          <tbody>
            {ALL_CAPABILITIES.map((item) => (
              <tr key={item.id} className="border-t border-subtle">
                <td className="px-4 py-3">
                  <p className="font-medium text-primary-color">{item.name}</p>
                  <p className="text-xs text-muted-color">{item.summary}</p>
                </td>
                <td className="px-4 py-3 text-secondary-color">{item.kind}</td>
                <td className="px-4 py-3">
                  <StatusBadge status={item.status} />
                </td>
                <td className="px-4 py-3 text-secondary-color">{item.owner}</td>
                <td className="px-4 py-3 text-xs uppercase text-muted-color">{item.telemetry.replace("_", " ")}</td>
                <td className="max-w-sm px-4 py-3 text-xs text-muted-color">{item.limitation}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section>
        <h2 className="mb-3 text-sm font-semibold text-primary-color">Integrations</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {INTEGRATIONS.map((item) => (
            <article key={item.id} className="rounded-xl border border-subtle bg-surface p-4">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-medium text-primary-color">{item.name}</h3>
                <StatusBadge status={item.status} kind="integration" />
              </div>
              <p className="mt-2 text-xs text-muted-color">{item.summary}</p>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
