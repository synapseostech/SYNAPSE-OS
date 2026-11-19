export const dynamic = "force-dynamic"

import { requirePlatformPage } from "../../../lib/platform/auth"
import { PlatformPageHeader } from "../_components/platform-page-header"
import { safeCount, safeRows } from "../_lib/platform-data"

const MODULES = ["Clinical", "Lab", "Pharm", "Pathways", "Imaging", "Claims", "DHIS2"] as const

export default async function ModuleMatrixPage() {
  await requirePlatformPage("/platform/modules")
  const tenants = await safeRows<{ id?: string; name?: string; facility_type?: string | null; environment?: string | null; is_synthetic?: boolean | null }>(
    "tenants",
    "id, name, facility_type, environment, is_synthetic",
    { orderBy: "name", ascending: true, limit: 40 },
  )
  const matrix = await safeRows<{ tenant_id?: string; module_key?: string; state?: string }>(
    "platform_module_matrix",
    "tenant_id, module_key, state",
    { limit: 500 },
  )
  const byTenant = new Map<string, Record<string, string>>()
  for (const row of matrix) {
    if (!row.tenant_id || !row.module_key) continue
    const current = byTenant.get(row.tenant_id) ?? {}
    current[row.module_key] = row.state ?? "Disabled"
    byTenant.set(row.tenant_id, current)
  }

  return (
    <div className="space-y-6">
      <PlatformPageHeader
        eyebrow="Module matrix"
        title="What each facility is allowed to run"
        description="States are Enabled, Disabled, Pilot, Demo, Development, or Unsupported. Feature flags do not replace authorization."
      />
      <p className="text-xs text-muted-color">{await safeCount("tenants")} tenant records visible.</p>
      <div className="overflow-x-auto rounded-2xl border border-subtle">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-elevated text-[11px] uppercase tracking-wide text-muted-color">
            <tr>
              <th className="px-4 py-3">Facility</th>
              {MODULES.map((module) => (
                <th key={module} className="px-4 py-3">
                  {module}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-sm text-muted-color" colSpan={MODULES.length + 1}>
                  No facilities loaded. Create a demo tenant in Simulation Lab to exercise the matrix locally.
                </td>
              </tr>
            ) : (
              tenants.map((tenant) => (
                <tr key={tenant.id} className="border-t border-subtle">
                  <td className="px-4 py-3">
                    <p className="font-medium text-primary-color">{tenant.name}</p>
                    <p className="text-xs text-muted-color">
                      {tenant.facility_type ?? "facility"} · {tenant.environment ?? "unclassified"}
                      {tenant.is_synthetic ? " · synthetic" : ""}
                    </p>
                  </td>
                  {MODULES.map((module) => (
                    <td key={module} className="px-4 py-3 text-xs text-muted-color">
                      {byTenant.get(tenant.id ?? "")?.[module] ?? (tenant.is_synthetic ? "Demo" : "Development")}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
