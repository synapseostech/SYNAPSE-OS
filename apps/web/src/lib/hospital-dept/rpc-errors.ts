/**
 * True when PostgREST reports that an RPC does not exist yet (migration not
 * applied), so the caller can fall back to its pre-migration path.
 * PGRST202: function not found in the schema cache. 42883: undefined_function.
 */
export function isMissingRpc(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  return error.code === 'PGRST202' || error.code === '42883'
}

/**
 * Domain errors raised by the hospital_* RPCs (`raise exception 'CODE'`) come
 * back as the message. Maps them to an HTTP status; anything else is a 500.
 */
const RPC_ERROR_STATUS: Record<string, number> = {
  INVOICE_NOT_FOUND: 404,
  PATIENT_NOT_FOUND: 404,
  ENCOUNTER_NOT_FOUND: 404,
  BED_NOT_FOUND: 404,
  ADMISSION_NOT_FOUND: 404,
  POLICY_NOT_FOUND: 404,
  INVOICE_ALREADY_PAID: 409,
  AMOUNT_EXCEEDS_BALANCE: 409,
  COVER_EXCEEDS_BALANCE: 409,
  CLAIM_ALREADY_SUBMITTED: 409,
  BED_OCCUPIED: 409,
  BED_UNAVAILABLE: 409,
  ALREADY_ADMITTED: 409,
  ALREADY_DISCHARGED: 409,
  INVOICE_VOID: 409,
  INVALID_AMOUNT: 400,
  POLICY_REQUIRED: 400,
  POLICY_INACTIVE: 422,
  INVOICE_HAS_NO_PATIENT: 422,
}

export function rpcDomainError(error: { message?: string | null } | null | undefined): { code: string; status: number } {
  const code = String(error?.message ?? '').trim()
  const status = RPC_ERROR_STATUS[code]
  return status ? { code, status } : { code: 'internal_error', status: 500 }
}
