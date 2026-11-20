import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { validateSession, verifyToken } from '@synapse/auth'
import { SESSION_COOKIE } from '@synapse/config/constants'

/**
 * Who a personal-health request is about: always the signed-in person.
 *
 * Personal health is owner-private for every account kind, patients and facility
 * staff alike. The owner comes from the verified session subject and nothing
 * else: no query parameter, body field, role, admin flag or tenant can widen it.
 * A pharmacy admin calling these routes gets their own health, never a
 * colleague's.
 */
export type HealthOwner = { ownerId: string }

function unauthorized(message: string) {
  return NextResponse.json({ error: message }, { status: 401 })
}

async function ownerFromToken(token: string | null): Promise<HealthOwner | NextResponse> {
  if (!token) return unauthorized('Unauthorized')
  const payload = await verifyToken(token).catch(() => null)
  const sub = typeof payload?.sub === 'string' ? payload.sub.trim() : ''
  if (!sub) return unauthorized('Invalid token')
  const { valid } = await validateSession(token)
  if (!valid) return unauthorized('Session expired')
  return { ownerId: sub }
}

/** Mobile app: `Authorization: Bearer <token>`. */
export async function requireMobileHealthOwner(req: NextRequest): Promise<HealthOwner | NextResponse> {
  const header = req.headers.get('authorization') ?? ''
  return ownerFromToken(header.startsWith('Bearer ') ? header.slice(7) : null)
}

/** Web portal: the session cookie. */
export async function requireWebHealthOwner(): Promise<HealthOwner | NextResponse> {
  const store = await cookies()
  return ownerFromToken(store.get(SESSION_COOKIE)?.value ?? null)
}

export function isHealthOwner(value: HealthOwner | NextResponse): value is HealthOwner {
  return !(value instanceof NextResponse)
}
