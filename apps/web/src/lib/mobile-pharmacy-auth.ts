import { NextRequest, NextResponse } from 'next/server'
import {
  verifyToken,
  validateSession,
  roleHasCapability,
  isTenantEntitled,
  type PharmacyCapability,
} from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'

const PHARMACY_ROLES = new Set([
  'pharmacist',
  'pharmacy_admin',
  'pharmacy_store_manager',
  'pharmacy_cashier',
  'cashier',
  'pharmacy_staff',
  'pharmacy_ceo',
  'inventory_officer',
])

export type MobileAuth = {
  userId: string
  tenantId: string
  role: string
  token: string
}

const ADMIN_ROLES = new Set(['pharmacy_admin', 'pharmacy_ceo', 'pharmacist'])

const SUBSCRIPTION_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Prefixes a lapsed tenant may still POST to. Billing has to stay reachable so
 * the tenant can pay, and the interaction checker is a POST that only reads.
 */
const SUSPENDED_WRITE_ALLOWED = [
  '/api/mobile/pharmacy/billing',
  '/api/mobile/pharmacy/interactions',
]

/**
 * True when an unpaid tenant is attempting to change data. Reads stay open —
 * the pharmacy portal degrades the same way, so historical and safety records
 * remain available after a subscription lapses.
 */
function isSubscriptionWriteBlocked(req: NextRequest): boolean {
  if (!SUBSCRIPTION_WRITE_METHODS.has(req.method.toUpperCase())) return false
  const pathname = req.nextUrl?.pathname ?? ''
  return !SUSPENDED_WRITE_ALLOWED.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
}

export function isMobilePharmacyAdmin(auth: MobileAuth): boolean {
  return ADMIN_ROLES.has(auth.role) || roleHasCapability(auth.role, 'settings.manage')
}

export function mobileHasPharmacyCapability(auth: MobileAuth, capability: PharmacyCapability): boolean {
  return roleHasCapability(auth.role, capability)
}

export function canWriteMobilePharmacyInventory(auth: MobileAuth): boolean {
  return roleHasCapability(auth.role, 'inventory.adjust') || roleHasCapability(auth.role, 'inventory.write')
}

export async function requireMobilePharmacyAuth(
  req: NextRequest,
): Promise<MobileAuth | NextResponse> {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const { valid } = await validateSession(token)
  if (!valid) return NextResponse.json({ error: 'Session expired' }, { status: 401 })

  const role = String(payload.role ?? '')
  if (!PHARMACY_ROLES.has(role)) {
    return NextResponse.json({ error: 'Pharmacy role required' }, { status: 403 })
  }

  const tenantId = String(payload.tenant_id ?? '')
  if (!tenantId) {
    return NextResponse.json({ error: 'No tenant context' }, { status: 403 })
  }

  // Deactivated pharmacy staff are refused server-side even with a still-valid session.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settings } = await (supabaseAdmin as any)
    .from('pharmacy_user_settings')
    .select('is_active')
    .eq('profile_id', payload.sub)
    .maybeSingle()
  if (settings?.is_active === false) {
    return NextResponse.json({ error: 'Account deactivated', code: 'ACCOUNT_INACTIVE' }, { status: 403 })
  }

  // Checked last so authentication failures keep their own status codes.
  // isTenantEntitled fails open, and a tenant with no subscription row stays
  // reachable, which is how the portal behaves too.
  if (isSubscriptionWriteBlocked(req)) {
    const entitlement = await isTenantEntitled(tenantId).catch(() => null)
    if (entitlement && !entitlement.entitled) {
      return NextResponse.json(
        {
          error: 'subscription_required',
          message:
            'This facility’s subscription is not active. Records stay readable; changes need a renewed subscription.',
          subscription_status: entitlement.status,
          reactivate_url: '/portal/billing',
        },
        { status: 402 },
      )
    }
  }

  return {
    userId: payload.sub as string,
    tenantId,
    role,
    token,
  }
}

export function isMobileAuth(value: MobileAuth | NextResponse): value is MobileAuth {
  return !(value instanceof NextResponse) && 'userId' in value
}
