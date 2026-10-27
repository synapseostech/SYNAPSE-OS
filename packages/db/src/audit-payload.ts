/**
 * Row builders for public.audit_log and public.phi_access_log.
 *
 * `logAudit` / `logPHIAccess` used to spread their input straight into the
 * insert (actor_id, resource_type, before_state… / accessor_id, record_type…),
 * none of which exist on the real tables, so every write failed with PGRST204
 * and was swallowed by the "audit must never break the caller" catch.
 */

import type { Database, Json } from "./types"

type AuditLogInsert = Database["public"]["Tables"]["audit_log"]["Insert"]
type PhiAccessInsert = Database["public"]["Tables"]["phi_access_log"]["Insert"]

export interface AuditEntry {
  actor_id?: string
  actor_email?: string
  action: string
  resource_type: string
  resource_id?: string
  resource_name?: string
  tenant_id?: string
  before_state?: Record<string, unknown>
  after_state?: Record<string, unknown>
  ip_address?: string
  user_agent?: string
  app_surface?: "web" | "pharmacy" | "mobile" | "api"
}

export interface PhiAccessEntry {
  accessor_id: string
  accessor_role: string
  patient_id: string
  record_type: string
  access_reason?: string
  tenant_id: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const asUuid = (value: unknown): string | null =>
  typeof value === "string" && UUID_RE.test(value) ? value : null

export function auditLogInsertPayload(entry: AuditEntry): AuditLogInsert {
  const userId = asUuid(entry.actor_id)
  const meta: Record<string, unknown> = {}
  if (entry.actor_id && !userId) meta.actor = entry.actor_id
  if (entry.actor_email) meta.actor_email = entry.actor_email
  if (entry.resource_name) meta.resource_name = entry.resource_name
  if (entry.ip_address) meta.ip_address = entry.ip_address
  if (entry.user_agent) meta.user_agent = entry.user_agent
  if (entry.app_surface) meta.app_surface = entry.app_surface
  const hasMeta = Object.keys(meta).length > 0
  const newValue = (entry.after_state || hasMeta ? { ...(entry.after_state ?? {}), ...(hasMeta ? { _audit: meta } : {}) } : null) as Json | null
  // created_by FKs auth.users(id); actor identity lives on user_id (no FK).
  return {
    tenant_id: asUuid(entry.tenant_id),
    user_id: userId,
    action: entry.action,
    table_name: entry.resource_type,
    record_id: entry.resource_id ?? null,
    old_value: (entry.before_state ?? null) as Json | null,
    new_value: newValue,
    created_at: new Date().toISOString(),
  }
}

export function phiAccessInsertPayload(entry: PhiAccessEntry): PhiAccessInsert {
  const subject = asUuid(entry.patient_id)
  return {
    tenant_id: asUuid(entry.tenant_id),
    actor_id: asUuid(entry.accessor_id),
    actor_role: entry.accessor_role ?? null,
    patient_id: subject,
    resource_id: subject,
    resource_type: entry.record_type,
    access_type: "view",
    purpose: entry.access_reason ?? null,
    accessed_at: new Date().toISOString(),
  }
}

/** phi_access_log.actor_id -> profiles, patient_id -> patients. MPI person ids may not be patients. */
export function phiAccessFkFallback(row: PhiAccessInsert): PhiAccessInsert {
  return { ...row, actor_id: null, patient_id: null }
}
