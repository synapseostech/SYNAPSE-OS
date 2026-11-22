import 'server-only'

import { createHash } from 'node:crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { verifyToken } from '@synapse/auth/tokens'
import { supabaseAdmin } from '@synapse/db/admin'
import { SESSION_COOKIE } from '@synapse/config/constants'
import type { HospitalContext } from '../hospital-shared/context'

/**
 * One round trip for every guard a lab route needs.
 *
 * The JWT is verified locally (no database), then `lab_access()` checks, in
 * one call: the session row (not revoked, not expired, same subject), the
 * profile and tenant, that the facility is a hospital or laboratory, the
 * hospital row, the `lab.<resource>.<action>` capability, that the lab module
 * is switched on and that the subscription includes it. Before this, a lab
 * route made 5–7 separate calls for the same checks.
 */

export type LabCapability =
  | 'order.read' | 'order.create' | 'order.cancel'
  | 'specimen.collect'
  | 'result.read' | 'result.enter' | 'result.verify'
  | 'report.read' | 'report.notify'
  | 'catalog.manage'
  | 'billing.charge'
  | 'qc.record' | 'qc.manage'

export interface LabContext extends HospitalContext {
  facilityName: string | null
}

type AccessRow = {
  ok: boolean
  status?: number
  error?: string
  capability?: string
  module_key?: string
  message?: string
  feature?: string
  ctx?: LabContext
}

export function isLabContextError(value: LabContext | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}

export async function labAccessForToken(token: string | null | undefined, capability: LabCapability | null): Promise<LabContext | NextResponse> {
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })

  const [resource, action] = capability ? capability.split('.') : [null, null]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db.rpc('lab_access', {
    p_token_hash: createHash('sha256').update(token).digest('hex'),
    p_profile_id: payload.sub,
    p_resource: resource,
    p_action: action,
  })
  if (error) return NextResponse.json({ error: 'Laboratory access check failed' }, { status: 503 })
  const row = data as AccessRow | null
  if (!row?.ok || !row.ctx) {
    const status = row?.status ?? 403
    const body: Record<string, unknown> = { error: row?.error ?? 'Forbidden' }
    if (row?.capability) body.capability = row.capability
    if (row?.module_key) body.module_key = row.module_key
    if (row?.message) body.message = row.message
    if (row?.feature) body.feature = row.feature
    return NextResponse.json(body, { status })
  }
  return row.ctx
}

/**
 * The signed claims of the cookie session, verified locally with no database
 * call. Only used to route platform operators to the simulation engine before
 * the real (one-call) access check; never as authorisation on its own.
 */
export async function peekLabSessionClaims(): Promise<{ sub: string; role: string | null; email: string | null } | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) return null
  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return null
  return { sub: payload.sub, role: (payload.role as string | undefined) ?? null, email: (payload.email as string | undefined) ?? null }
}

/** Cookie session (web console). */
export async function requireLabAccess(capability: LabCapability | null): Promise<LabContext | NextResponse> {
  const cookieStore = await cookies()
  return labAccessForToken(cookieStore.get(SESSION_COOKIE)?.value, capability)
}

/** Bearer session (APK). */
export async function requireLabAccessFromRequest(request: Request, capability: LabCapability | null): Promise<LabContext | NextResponse> {
  const auth = request.headers.get('authorization') ?? ''
  return labAccessForToken(auth.startsWith('Bearer ') ? auth.slice(7) : null, capability)
}

/** Which capability each workflow action needs. */
export function capabilityForLabAction(action: string): LabCapability | null {
  switch (action) {
    case 'collect':
    case 'receive':
    case 'reject':
      return 'specimen.collect'
    case 'enter_result':
      return 'result.enter'
    case 'verify':
    case 'release':
    case 'authorise':
    case 'amend':
    case 'acknowledge':
      return 'result.verify'
    default:
      return null
  }
}
