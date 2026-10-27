// packages/db/src/audit.ts
import { supabaseAdmin } from './admin'
import { auditLogInsertPayload, phiAccessFkFallback, phiAccessInsertPayload, type AuditEntry, type PhiAccessEntry } from './audit-payload'

export type { AuditEntry, PhiAccessEntry } from './audit-payload'

export async function logAudit(entry: AuditEntry): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('audit_log').insert(auditLogInsertPayload(entry))
    if (error) console.error('[AUDIT FAILED]', entry.action, error)
  } catch (error) {
    // Audit failure must never break the calling operation
    console.error('[AUDIT FAILED]', entry.action, error)
  }
}

export async function logPHIAccess(params: PhiAccessEntry): Promise<void> {
  try {
    const db = supabaseAdmin
    const row = phiAccessInsertPayload(params)
    let { error } = await db.from('phi_access_log').insert(row)
    if (error?.code === '23503') {
      ;({ error } = await db.from('phi_access_log').insert(phiAccessFkFallback(row)))
    }
    if (error) console.error('[PHI AUDIT FAILED]', params.record_type, error)
  } catch (error) {
    console.error('[PHI AUDIT FAILED]', params.record_type, error)
  }
}
