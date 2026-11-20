import { canDo } from './capability-map'
import { isMobilePharmacyAdmin, type MobileAuth } from './mobile-pharmacy-auth'

/** Mirror portal pos.refund: store managers, admins/CEO, finance. */
const REFUND_ROLES = new Set([
  'pharmacy_admin',
  'pharmacy_ceo',
  'pharmacy_store_manager',
  'finance',
])

/**
 * Whether this phone user may void a completed sale. Shared by the refund
 * route (which enforces it) and the receipt route (which reports it, so the
 * receipt screen does not offer a cashier a button the server will refuse).
 */
export function mobileCanRefund(auth: MobileAuth): boolean {
  if (isMobilePharmacyAdmin(auth)) return true
  if (REFUND_ROLES.has(auth.role)) return true
  return canDo(auth.role, 'pos', 'refund', 'write')
}
