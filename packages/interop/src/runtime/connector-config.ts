/**
 * Connector registry, resolved from `public.synapse_adapters` rows.
 *
 * The table, as it exists, has three properties that shape this file:
 *
 *   - It has no tenant column. Connector identity in the table is global, so the
 *     tenant must be supplied by the caller and the descriptor is built by
 *     pairing the two. Treating a row as tenant-scoped would be a fiction.
 *   - It records no direction. There is no column saying whether an adapter
 *     pulls, pushes or both, so capabilities are NOT inferred from the row. They
 *     are declared by the deployment, and the default is `health` only — meaning
 *     an adapter row, on its own, moves no clinical data.
 *   - It defaults to `simulation = true` and `status = 'simulation'`. Therefore
 *     an adapter is live only when BOTH fields independently say so. A row that
 *     has been flipped halfway through a rollout fails safe.
 */

import type { ConnectorCapability, ConnectorDescriptor, ConnectorKind } from "./contract"

/** A subset of `synapse_adapters` columns, typed as they arrive from Postgres. */
export interface AdapterRow {
  id: string
  name: string
  system: string
  mode: string
  simulation: boolean | null
  version: string
  status: string | null
  last_success_at?: string | null
  last_failure_at?: string | null
  messages_today?: number | null
  failed_today?: number | null
}

export type AdapterIssueCode =
  | "ADAPTER_ID_INVALID"
  | "ADAPTER_SYSTEM_UNSUPPORTED"
  | "ADAPTER_MODE_UNSUPPORTED"
  | "ADAPTER_TENANT_REQUIRED"
  | "ADAPTER_VERSION_MISSING"

export interface AdapterIssue {
  code: AdapterIssueCode
  detail: string
}

export type AdapterResolution =
  | { ok: true; descriptor: ConnectorDescriptor; live: boolean }
  | { ok: false; issues: AdapterIssue[] }

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/

const SYSTEM_ALIASES: Record<string, ConnectorKind> = {
  tally: "tally",
  tallyprime: "tally",
  tallyerp9: "tally",
  dhis2: "dhis2",
  dhis: "dhis2",
  fhir: "fhir",
  hl7fhir: "fhir",
  hl7: "hl7v2",
  hl7v2: "hl7v2",
  openmrs: "openmrs",
  ugandaemr: "ugandaemr",
  rest: "rest",
  http: "rest",
  webhook: "rest",
}

const MODES = new Set(["native", "overlay", "network"])

function normaliseSystem(system: string): ConnectorKind | null {
  const key = system.toLowerCase().replace(/[^a-z0-9]/g, "")
  return SYSTEM_ALIASES[key] ?? null
}

/**
 * Resolve one row plus its tenant into a descriptor.
 *
 * `capabilities` must be declared by the deployment — see the note above on why
 * the row cannot supply them. It defaults to `["health"]`, which is safe: the
 * relay treats a connector without `push` as nothing to deliver.
 */
export function resolveAdapter(
  row: AdapterRow,
  tenantId: string,
  capabilities: ConnectorCapability[] = ["health"],
): AdapterResolution {
  const issues: AdapterIssue[] = []

  if (!tenantId || !tenantId.trim()) {
    issues.push({ code: "ADAPTER_TENANT_REQUIRED", detail: "tenant_id must be supplied by the caller" })
  }
  if (!ID_PATTERN.test(row.id ?? "")) {
    issues.push({
      code: "ADAPTER_ID_INVALID",
      detail: `id ${JSON.stringify(row.id)} must be 3–64 chars of [a-z0-9._-]`,
    })
  }
  const kind = normaliseSystem(row.system ?? "")
  if (!kind) {
    issues.push({
      code: "ADAPTER_SYSTEM_UNSUPPORTED",
      detail: `system ${JSON.stringify(row.system)} has no connector kind`,
    })
  }
  if (!MODES.has(row.mode ?? "")) {
    issues.push({
      code: "ADAPTER_MODE_UNSUPPORTED",
      detail: `mode ${JSON.stringify(row.mode)} is not one of native|overlay|network`,
    })
  }
  if (!row.version || !row.version.trim()) {
    issues.push({ code: "ADAPTER_VERSION_MISSING", detail: "version is required for schema negotiation" })
  }

  if (issues.length > 0 || !kind) return { ok: false, issues }

  // Both must say live. Anything else is simulation, including null.
  const live = row.simulation === false && row.status === "live"

  return {
    ok: true,
    live,
    descriptor: {
      id: row.id,
      tenantId: tenantId.trim(),
      kind,
      displayName: row.name?.trim() || row.id,
      capabilities: [...new Set(capabilities)],
    },
  }
}

/** Resolve many rows, separating the usable from the rejected. */
export function resolveAdapters(
  rows: AdapterRow[],
  tenantId: string,
  capabilitiesFor: (row: AdapterRow) => ConnectorCapability[] = () => ["health"],
): { descriptors: ConnectorDescriptor[]; rejected: Array<{ id: string; issues: AdapterIssue[] }> } {
  const descriptors: ConnectorDescriptor[] = []
  const rejected: Array<{ id: string; issues: AdapterIssue[] }> = []
  for (const row of rows) {
    const resolved = resolveAdapter(row, tenantId, capabilitiesFor(row))
    if (resolved.ok) descriptors.push(resolved.descriptor)
    else rejected.push({ id: row.id, issues: resolved.issues })
  }
  return { descriptors, rejected }
}
