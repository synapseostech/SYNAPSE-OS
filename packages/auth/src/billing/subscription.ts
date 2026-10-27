import { supabaseAdmin } from '@synapse/db/admin'
import { resolveEffectiveSubscription, type EffectiveSubscription, type ManualGrantInput } from './entitlement'
import { initFlutterwavePayment, verifyFlutterwaveTransaction } from './flutterwave'
import { type EntitlementResult } from './entitlement'

// ── Kampala time + billing-cycle helpers ─────────────────────────────────────
// Kampala is UTC+3 year-round (no DST), so a fixed offset is safe.
const KAMPALA_OFFSET_MS = 3 * 60 * 60 * 1000

function kampalaDateParts(date: Date = new Date()): { y: string; m: string; d: string; hh: string; mm: string; ss: string } {
  const k = new Date(date.getTime() + KAMPALA_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    y: String(k.getUTCFullYear()),
    m: pad(k.getUTCMonth() + 1),
    d: pad(k.getUTCDate()),
    hh: pad(k.getUTCHours()),
    mm: pad(k.getUTCMinutes()),
    ss: pad(k.getUTCSeconds()),
  }
}

/** yyyymmddhhmmss in Africa/Kampala — used for tx_ref stamps */
export function kampalaStamp(date: Date = new Date()): string {
  const p = kampalaDateParts(date)
  return `${p.y}${p.m}${p.d}${p.hh}${p.mm}${p.ss}`
}

/** YYYYMMDD in Africa/Kampala — used for invoice numbers */
export function kampalaDateYMD(date: Date = new Date()): string {
  const p = kampalaDateParts(date)
  return `${p.y}${p.m}${p.d}`
}

/** UTC instant of midnight (00:00) Africa/Kampala for the given date's Kampala day */
export function kampalaMidnightUtc(date: Date = new Date()): Date {
  const k = new Date(date.getTime() + KAMPALA_OFFSET_MS)
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - KAMPALA_OFFSET_MS)
}

export type BillingCycle = 'monthly' | 'quarterly' | 'yearly'

export function billingCycleMonths(cycle: string | null | undefined): number {
  if (cycle === 'yearly') return 12
  if (cycle === 'quarterly') return 3
  return 1
}

export function addBillingCycle(from: Date, cycle: string | null | undefined): Date {
  const d = new Date(from)
  d.setMonth(d.getMonth() + billingCycleMonths(cycle))
  return d
}

export type SubscriptionStatus = {
  status: string
  planSlug: string | null
  planName: string | null
  priceUgx: number | null
  billingCycle: string | null
  trialEnds: string | null
  currentPeriodEnd: string | null
  graceUntil: string | null
  lastPaymentAt: string | null
  cancelAtPeriodEnd: boolean
}

export type PaymentRow = {
  id: string
  tenant_id: string
  amount_ugx: number
  status: string
  method: string | null
  provider_tx_ref: string | null
  provider_tx_id: string | null
  created_at: string
  confirmed_at: string | null
}

function db() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return supabaseAdmin as any
}

export async function getSubscriptionStatus(tenantId: string): Promise<SubscriptionStatus | null> {
  const { data, error } = await db()
    .from('tenant_subscriptions')
    .select(`
      status, trial_ends, current_period_end, grace_until, last_payment_at, cancel_at_period_end,
      subscription_plans ( slug, name, price_ugx, billing_cycle )
    `)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error || !data) return null

  const plan = data.subscription_plans as { slug?: string; name?: string; price_ugx?: number; billing_cycle?: string } | null
  return {
    status: data.status,
    planSlug: plan?.slug ?? null,
    planName: plan?.name ?? null,
    priceUgx: plan?.price_ugx ?? null,
    billingCycle: plan?.billing_cycle ?? null,
    trialEnds: data.trial_ends,
    currentPeriodEnd: data.current_period_end,
    graceUntil: data.grace_until,
    lastPaymentAt: data.last_payment_at,
    cancelAtPeriodEnd: Boolean(data.cancel_at_period_end),
  }
}

export type ActivePlanRow = {
  slug: string
  name: string
  price_ugx: number | null
  billing_cycle: string
}

/** Canonical pharmacy self-serve checkout slug (UGX 240,000 / year). */
export const PHARMACY_SELF_SERVE_PLAN_SLUG = 'synapse_pharmacy_annual'

/** Active pharmacy plans offered in-app — yearly only (canonical annual preferred). */
export async function listActivePharmacyPlans(): Promise<ActivePlanRow[]> {
  const { data: canonical } = await db()
    .from('subscription_plans')
    .select('slug, name, price_ugx, billing_cycle')
    .eq('slug', PHARMACY_SELF_SERVE_PLAN_SLUG)
    .eq('is_active', true)
    .maybeSingle()

  if (canonical) return [canonical as ActivePlanRow]

  const { data } = await db()
    .from('subscription_plans')
    .select('slug, name, price_ugx, billing_cycle')
    .eq('facility_type', 'pharmacy')
    .eq('is_active', true)
    .eq('billing_cycle', 'yearly')
    .order('price_ugx', { ascending: true })

  const rows = (data ?? []) as ActivePlanRow[]
  // Prefer a single yearly card — avoid duplicate "Pharm Yearly" + "SYNAPSE Pharmacy" rows.
  return rows.slice(0, 1)
}

/**
 * DB-backed entitlement check — single source of truth for whether a tenant may
 * use the pharmacy module. Reads tenant_subscriptions and delegates the policy
 * decision to the pure evaluateEntitlement() so middleware (Edge) and route
 * handlers (Node) stay in lockstep.
 */
export async function isTenantEntitled(tenantId: string): Promise<EntitlementResult> {
  if (!tenantId) return { entitled: true, reason: 'no_tenant', status: null }
  const { data, error } = await db()
    .from('tenant_subscriptions')
    .select('status, current_period_end, grace_until')
    .eq('tenant_id', tenantId)
    .maybeSingle()

  // On query error, fail-open so we never lock a tenant out due to infra issues.
  if (error) return { entitled: true, reason: 'query_error_failopen', status: null }

  const { data: grants } = await db()
    .from('subscription_grants')
    .select('id, starts_at, ends_at, status, reason, subscription_plans(slug, name)')
    .eq('tenant_id', tenantId)
    .in('status', ['SCHEDULED', 'ACTIVE'])
  const effective = resolveEffectiveSubscription(
    data ? { status: data.status, current_period_end: data.current_period_end, grace_until: data.grace_until } : null,
    (grants ?? []).map((grant: Record<string, unknown>) => {
      const plan = Array.isArray(grant.subscription_plans) ? grant.subscription_plans[0] : grant.subscription_plans as Record<string, unknown> | null
      return { id: String(grant.id), starts_at: String(grant.starts_at), ends_at: String(grant.ends_at), status: String(grant.status), reason: String(grant.reason), planSlug: plan?.slug as string | null, planName: plan?.name as string | null } satisfies ManualGrantInput
    }),
  )
  return {
    entitled: effective.entitled,
    reason: effective.reason,
    status: effective.status,
  }
}

export async function getEffectiveSubscription(tenantId: string): Promise<EffectiveSubscription> {
  const { data } = await db().from('tenant_subscriptions').select('status, current_period_end, grace_until, trial_ends, subscription_plans(slug, name)').eq('tenant_id', tenantId).maybeSingle()
  const plan = data?.subscription_plans as { slug?: string; name?: string } | null
  const { data: grants } = await db().from('subscription_grants').select('id, starts_at, ends_at, status, reason, subscription_plans(slug, name)').eq('tenant_id', tenantId).in('status', ['SCHEDULED', 'ACTIVE'])
  return resolveEffectiveSubscription(
    data ? { status: data.status, current_period_end: data.current_period_end, grace_until: data.grace_until, trial_ends: data.trial_ends, planSlug: plan?.slug, planName: plan?.name } : null,
    (grants ?? []).map((grant: Record<string, unknown>) => {
      const grantPlan = Array.isArray(grant.subscription_plans) ? grant.subscription_plans[0] : grant.subscription_plans as Record<string, unknown> | null
      return { id: String(grant.id), starts_at: String(grant.starts_at), ends_at: String(grant.ends_at), status: String(grant.status), reason: String(grant.reason), planSlug: grantPlan?.slug as string | null, planName: grantPlan?.name as string | null }
    }),
  )
}

export async function listSubscriptionPayments(tenantId: string, limit = 20): Promise<PaymentRow[]> {
  const { data } = await db()
    .from('subscription_payments')
    .select('id, tenant_id, amount_ugx, status, method, provider_tx_ref, provider_tx_id, created_at, confirmed_at')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit)
  return (data ?? []) as PaymentRow[]
}

export async function listAllPayments(limit = 100): Promise<(PaymentRow & { tenant_name?: string })[]> {
  const { data } = await db()
    .from('subscription_payments')
    .select(`
      id, tenant_id, amount_ugx, status, method, provider_tx_ref, provider_tx_id, created_at, confirmed_at,
      tenants ( name )
    `)
    .order('created_at', { ascending: false })
    .limit(limit)

  return ((data ?? []) as Array<PaymentRow & { tenants?: { name?: string } }>).map((row) => ({
    ...row,
    tenant_name: row.tenants?.name,
  }))
}

export type InitSubscribeInput = {
  tenantId: string
  planSlug: string
  email: string
  name: string
  phone?: string
  redirectUrl: string
}

export type InitSubscribeResult = {
  paymentId: string
  txRef: string
  paymentLink: string
  amountUgx: number
}

/** Client-safe checkout rejection (message is shown to the user; never a raw DB error). */
export class SubscriptionPlanError extends Error {
  readonly code: 'PLAN_INVALID' | 'PLAN_FACILITY_MISMATCH' | 'PLAN_CYCLE'
  constructor(message: string, code: 'PLAN_INVALID' | 'PLAN_FACILITY_MISMATCH' | 'PLAN_CYCLE') {
    super(message)
    this.name = 'SubscriptionPlanError'
    this.code = code
  }
}

const HOSPITAL_LIKE = new Set(['hospital', 'clinic', 'health_centre', 'health_center', 'hospital_os'])
function facilityFamily(value: unknown): string | null {
  const v = String(value ?? '').trim().toLowerCase()
  if (!v) return null
  if (HOSPITAL_LIKE.has(v)) return 'hospital'
  if (v === 'lab' || v === 'laboratory') return 'laboratory'
  return v
}

/**
 * A tenant may only buy plans for its own facility type (a pharmacy cannot buy the
 * OS / Lab plans and vice versa). Unknown tenant facility types are allowed so legacy
 * tenants without facility_type are not locked out.
 */
export function assertPlanMatchesFacility(planFacility: unknown, tenantFacility: unknown): void {
  const plan = facilityFamily(planFacility)
  const tenant = facilityFamily(tenantFacility)
  if (plan && tenant && plan !== tenant) {
    throw new SubscriptionPlanError('This plan is not available for your facility type.', 'PLAN_FACILITY_MISMATCH')
  }
}

/** Pharmacy purchases (by plan or tenant facility) must be the annual plan. */
export function assertPharmacyPlanOfferable(planSlug: unknown, planFacility: unknown, tenantFacility: unknown): void {
  const pharmacyPurchase = facilityFamily(planFacility) === 'pharmacy' || facilityFamily(tenantFacility) === 'pharmacy'
  if (pharmacyPurchase && String(planSlug ?? '') !== PHARMACY_SELF_SERVE_PLAN_SLUG) {
    throw new SubscriptionPlanError('New pharmacy subscriptions are on the Synapse Pharmacy annual plan only', 'PLAN_CYCLE')
  }
}

export async function initiateSubscriptionPayment(input: InitSubscribeInput): Promise<InitSubscribeResult> {
  const { data: plan, error: planErr } = await db()
    .from('subscription_plans')
    .select('id, slug, name, price_ugx, billing_cycle, is_active, facility_type')
    .eq('slug', input.planSlug)
    .eq('is_active', true)
    .maybeSingle()

  if (planErr || !plan) throw new SubscriptionPlanError('Invalid or inactive plan', 'PLAN_INVALID')
  if (!plan.price_ugx || plan.price_ugx <= 0) throw new SubscriptionPlanError('Plan price not configured', 'PLAN_INVALID')

  const { data: tenantRow } = await db()
    .from('tenants')
    .select('facility_type')
    .eq('id', input.tenantId)
    .maybeSingle()
  assertPlanMatchesFacility((plan as { facility_type?: unknown }).facility_type, tenantRow?.facility_type)
  // Pharmacy: the annual plan is the ONLY plan a pharmacy can buy (legacy
  // pharm_monthly/quarterly/yearly rows stay for existing subscribers' history).
  assertPharmacyPlanOfferable(plan.slug, (plan as { facility_type?: unknown }).facility_type, tenantRow?.facility_type)
  // Pharmacy portal self-serve: yearly only (monthly/quarterly are platform/historical).
  const cycle = String(plan.billing_cycle ?? '').toLowerCase()
  if (cycle !== 'yearly' && cycle !== 'annual' && plan.slug !== PHARMACY_SELF_SERVE_PLAN_SLUG) {
    throw new SubscriptionPlanError('Only the yearly Pharmacy subscription can be purchased in-app', 'PLAN_CYCLE')
  }

  const { data: sub } = await db()
    .from('tenant_subscriptions')
    .select('id, status, current_period_end')
    .eq('tenant_id', input.tenantId)
    .maybeSingle()

  const now = new Date()
  // Early renewal on an active subscription extends from the existing period end,
  // never from now() — the tenant keeps the days they already paid for.
  const existingEnd = sub?.current_period_end ? new Date(sub.current_period_end) : null
  const extendsExisting =
    sub?.status === 'active' && existingEnd != null && !Number.isNaN(existingEnd.getTime()) && existingEnd > now

  const txRef = `SUB-${input.tenantId}-${kampalaStamp(now)}`
  const periodStart = extendsExisting ? existingEnd : now
  const periodEnd = addBillingCycle(periodStart, plan.billing_cycle)

  const { data: payment, error: payErr } = await db()
    .from('subscription_payments')
    .insert({
      tenant_id: input.tenantId,
      subscription_id: sub?.id ?? null,
      plan_id: plan.id,
      amount_ugx: plan.price_ugx,
      currency: 'UGX',
      provider: 'flutterwave',
      provider_tx_ref: txRef,
      status: 'pending',
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
    })
    .select('id')
    .single()

  if (payErr || !payment) throw new Error(payErr?.message ?? 'Failed to create payment record')

  const fw = await initFlutterwavePayment({
    txRef,
    amountUgx: Number(plan.price_ugx),
    email: input.email,
    name: input.name,
    phone: input.phone,
    title: `Synapse — ${plan.name}`,
    description: `${plan.billing_cycle ?? 'monthly'} subscription (${plan.slug})`,
    redirectUrl: input.redirectUrl,
  })

  return {
    paymentId: payment.id,
    txRef,
    paymentLink: fw.link,
    amountUgx: Number(plan.price_ugx),
  }
}

// ── Payment confirmation (shared by webhook + redirect-verify) ───────────────

export type PaymentRecord = {
  id: string
  tenant_id: string
  plan_id: string | null
  status: string
  amount_ugx: number
  provider_tx_ref: string | null
  period_start: string | null
  period_end: string | null
  raw_payload: Record<string, unknown> | null
}

export type ConfirmPaymentInput = {
  /** Flutterwave numeric transaction id (from webhook data.id or redirect ?transaction_id=) */
  transactionId: string
  /** our tx_ref — preferred lookup key */
  txRef?: string | null
  /** scope lookup to a tenant (redirect-verify path); webhook passes nothing */
  tenantId?: string | null
  actor: string
  /** raw webhook payload to persist for audit; redirect path omits it */
  rawPayload?: unknown
  method?: string | null
}

export type ConfirmPaymentResult = {
  ok: boolean
  idempotent?: boolean
  reason: string
  planName?: string | null
  invoiceNo?: string | null
}

/**
 * Verify a Flutterwave transaction server-to-server and, only if it checks out,
 * activate the matching pending subscription payment.
 *
 * Security invariants (never relaxed):
 *  - the webhook payload / redirect query params are NEVER trusted for money facts;
 *    amount, currency and tx_ref come from Flutterwave's verify endpoint
 *  - currency must be UGX and verified amount must cover the payment row's amount
 *    (which was computed server-side from subscription_plans at checkout)
 *  - the verified tx_ref must match the payment row, so a cheap successful
 *    transaction cannot activate someone else's (or a pricier) pending payment
 *  - replays are no-ops: an already-successful payment short-circuits
 */
export async function confirmSubscriptionPayment(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
  let query = db()
    .from('subscription_payments')
    .select('id, tenant_id, plan_id, status, amount_ugx, provider_tx_ref, period_start, period_end, raw_payload')
  query = input.txRef
    ? query.eq('provider_tx_ref', input.txRef)
    : query.eq('provider_tx_id', input.transactionId)
  if (input.tenantId) query = query.eq('tenant_id', input.tenantId)

  const { data: payment, error } = (await query.maybeSingle()) as {
    data: PaymentRecord | null
    error: { message: string } | null
  }
  if (error || !payment) return { ok: false, reason: 'payment_not_found' }
  if (payment.status === 'successful') return { ok: true, idempotent: true, reason: 'already_activated' }

  const v = await verifyFlutterwaveTransaction(input.transactionId)
  if (!v.ok) return { ok: false, reason: 'flutterwave_verification_failed' }
  if ((v.currency ?? '').toUpperCase() !== 'UGX') return { ok: false, reason: 'currency_mismatch' }
  if (v.amount == null || v.amount < Number(payment.amount_ugx)) {
    return { ok: false, reason: 'amount_below_plan_price' }
  }
  if (v.txRef && payment.provider_tx_ref && v.txRef !== payment.provider_tx_ref) {
    return { ok: false, reason: 'tx_ref_mismatch' }
  }

  const updates: Record<string, unknown> = { provider_tx_id: String(input.transactionId) }
  if (input.method != null) updates.method = input.method
  if (input.rawPayload != null) updates.raw_payload = input.rawPayload
  await db().from('subscription_payments').update(updates).eq('id', payment.id)

  const { data: result, error: actErr } = await db().rpc('activate_subscription_payment', {
    p_payment_id: payment.id,
    p_actor: input.actor,
  })
  if (actErr) return { ok: false, reason: actErr.message }
  if (!result?.ok) return { ok: false, reason: result?.error ?? 'activation_failed' }
  // A concurrent confirmation (webhook + redirect verify, or a retried webhook) already
  // activated this payment inside the row-locked RPC: no second invoice or receipt.
  if (result.idempotent) return { ok: true, idempotent: true, reason: 'already_activated' }

  const invoiceNo = await recordSubscriptionInvoice(payment).catch(() => null)

  let planName: string | null = null
  if (payment.plan_id) {
    const { data: plan } = await db().from('subscription_plans').select('name').eq('id', payment.plan_id).maybeSingle()
    planName = plan?.name ?? null
  }

  if (invoiceNo) {
    void dispatchPaymentReceipt({
      payment,
      invoiceNo,
      planName,
      method: input.method ?? null,
    }).catch((err) => console.error('[billing] payment receipt failed:', err))
  }

  return { ok: true, reason: 'activated', planName, invoiceNo }
}

/**
 * Issue a Kampala-numbered invoice (INV-YYYYMMDD-####) for a confirmed payment.
 *
 * Writes to subscription_invoices when the table exists. Until that migration is
 * applied to the live project, falls back to stamping invoice_no into the payment's
 * raw_payload so the number is never lost. Best-effort by design — activation must
 * never fail because invoicing did.
 */
export async function recordSubscriptionInvoice(payment: PaymentRecord): Promise<string | null> {
  const ymd = kampalaDateYMD()

  // Concurrent confirmations of the same payment must not double-invoice.
  const { data: existing, error: existErr } = await db()
    .from('subscription_invoices')
    .select('invoice_no')
    .eq('payment_id', payment.id)
    .maybeSingle()
  if (!existErr && existing?.invoice_no) return existing.invoice_no

  const { count, error: countErr } = await db()
    .from('subscription_invoices')
    .select('id', { count: 'exact', head: true })
    .like('invoice_no', `INV-${ymd}-%`)

  if (!countErr) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const invoiceNo = `INV-${ymd}-${String((count ?? 0) + 1 + attempt).padStart(4, '0')}`
      const { error: insErr } = await db().from('subscription_invoices').insert({
        tenant_id: payment.tenant_id,
        payment_id: payment.id,
        plan_id: payment.plan_id,
        invoice_no: invoiceNo,
        amount_ugx: payment.amount_ugx,
        currency: 'UGX',
        period_start: payment.period_start,
        period_end: payment.period_end,
        metadata: { type: 'subscription_payment' },
      })
      if (!insErr) return invoiceNo
      if (insErr.code !== '23505') break // only retry unique-collision; else fall through
      // One invoice per payment (subscription_invoices_payment_id_uidx): a concurrent
      // confirmation won the race — return its number instead of minting another.
      const { data: raced } = await db()
        .from('subscription_invoices')
        .select('invoice_no')
        .eq('payment_id', payment.id)
        .maybeSingle()
      if (raced?.invoice_no) return raced.invoice_no
    }
  }

  // Fallback: table missing (or insert failed) — number from today's confirmed payments
  const stamped = payment.raw_payload?.invoice_no
  if (typeof stamped === 'string' && stamped) return stamped
  const sinceMidnight = kampalaMidnightUtc().toISOString()
  const { count: paidToday } = await db()
    .from('subscription_payments')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'successful')
    .gte('confirmed_at', sinceMidnight)
  const invoiceNo = `INV-${ymd}-${String((paidToday ?? 0) + 1).padStart(4, '0')}`
  const mergedPayload = { ...(payment.raw_payload ?? {}), invoice_no: invoiceNo }
  await db().from('subscription_payments').update({ raw_payload: mergedPayload }).eq('id', payment.id)
  return invoiceNo
}

function formatUgx(n: number): string {
  return `UGX ${Math.round(n).toLocaleString('en-UG')}`
}

function kampalaDateLabel(iso: string | null | undefined): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Kampala',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

async function resolveTenantBillingContact(tenantId: string): Promise<{
  email: string | null
  name: string
  facilityName: string
}> {
  const { data: tenant } = await db().from('tenants').select('name').eq('id', tenantId).maybeSingle()
  const facilityName = (tenant?.name as string | null) ?? 'Facility'

  const { data: admin } = await db()
    .from('profiles')
    .select('email, full_name, first_name, last_name')
    .eq('tenant_id', tenantId)
    .or('is_admin.eq.true,role.eq.pharmacy_admin')
    .order('is_admin', { ascending: false })
    .limit(1)
    .maybeSingle()

  const joined = [admin?.first_name, admin?.last_name].filter(Boolean).join(' ')
  const name = (admin?.full_name as string | null) || joined || 'Customer'
  const email = (admin?.email as string | null) ?? null
  return { email, name, facilityName }
}

async function dispatchPaymentReceipt(input: {
  payment: PaymentRecord
  invoiceNo: string
  planName: string | null
  method: string | null
}): Promise<void> {
  const contact = await resolveTenantBillingContact(input.payment.tenant_id)
  if (!contact.email) return

  const periodLabel =
    input.payment.period_start && input.payment.period_end
      ? `${kampalaDateLabel(input.payment.period_start)} – ${kampalaDateLabel(input.payment.period_end)}`
      : null

  const { sendPaymentReceipt } = await import('@synapse/email')
  await sendPaymentReceipt({
    to: contact.email,
    receiptNo: input.invoiceNo,
    customerName: contact.name,
    customerEmail: contact.email,
    facilityName: contact.facilityName,
    planName: input.planName ?? 'Subscription',
    amountLabel: formatUgx(Number(input.payment.amount_ugx ?? 0)),
    periodLabel,
    issuedAtLabel: kampalaDateLabel(new Date().toISOString()),
    methodLabel: input.method ?? 'Flutterwave',
    ctaUrl: 'https://pharm.synapseos.tech/portal/billing',
    ctaLabel: 'View billing →',
  })

  await db()
    .from('subscription_invoices')
    .update({
      metadata: {
        type: 'subscription_payment',
        customer_email: contact.email,
        customer_name: contact.name,
        facility_name: contact.facilityName,
        plan_name: input.planName,
        method: input.method ?? 'Flutterwave',
      },
    })
    .eq('invoice_no', input.invoiceNo)
}

export type TrialReceiptInput = {
  tenantId: string
  planId: string | null
  planName: string
  trialEnds: string
  customerName: string
  customerEmail: string
  facilityName: string
}

/**
 * Issue a TRIAL-YYYYMMDD-#### receipt for successful free-trial registration
 * and email it. Best-effort — registration must never fail because of this.
 */
export async function recordAndSendTrialReceipt(input: TrialReceiptInput): Promise<string | null> {
  const ymd = kampalaDateYMD()
  let receiptNo: string | null = null

  const { count, error: countErr } = await db()
    .from('subscription_invoices')
    .select('id', { count: 'exact', head: true })
    .like('invoice_no', `TRIAL-${ymd}-%`)

  if (!countErr) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `TRIAL-${ymd}-${String((count ?? 0) + 1 + attempt).padStart(4, '0')}`
      const { error: insErr } = await db().from('subscription_invoices').insert({
        tenant_id: input.tenantId,
        payment_id: null,
        plan_id: input.planId,
        invoice_no: candidate,
        amount_ugx: 0,
        currency: 'UGX',
        period_start: new Date().toISOString(),
        period_end: input.trialEnds,
        metadata: {
          type: 'free_trial',
          customer_email: input.customerEmail,
          customer_name: input.customerName,
          facility_name: input.facilityName,
          plan_name: input.planName,
        },
      })
      if (!insErr) {
        receiptNo = candidate
        break
      }
      if (insErr.code !== '23505') break
    }
  }

  if (!receiptNo) {
    receiptNo = `TRIAL-${ymd}-${String(Date.now()).slice(-4)}`
  }

  try {
    const { sendTrialReceipt } = await import('@synapse/email')
    await sendTrialReceipt({
      to: input.customerEmail,
      receiptNo,
      customerName: input.customerName,
      customerEmail: input.customerEmail,
      facilityName: input.facilityName,
      planName: input.planName,
      periodLabel: `Trial ends ${kampalaDateLabel(input.trialEnds)}`,
      issuedAtLabel: kampalaDateLabel(new Date().toISOString()),
      lines: [{ label: 'Status', value: 'Free trial active' }],
      ctaUrl: 'https://pharm.synapseos.tech/portal/dashboard',
      ctaLabel: 'Open pharmacy dashboard →',
    })
  } catch (err) {
    console.error('[billing] trial receipt email failed:', err)
  }

  return receiptNo
}

export type SubscriptionInvoiceRow = {
  id: string
  tenant_id: string
  payment_id: string | null
  plan_id: string | null
  invoice_no: string
  amount_ugx: number
  currency: string
  period_start: string | null
  period_end: string | null
  issued_at: string
  metadata: Record<string, unknown>
  tenant_name?: string
  plan_name?: string | null
}

export async function listSubscriptionInvoices(limit = 200): Promise<SubscriptionInvoiceRow[]> {
  const { data } = await db()
    .from('subscription_invoices')
    .select(`
      id, tenant_id, payment_id, plan_id, invoice_no, amount_ugx, currency,
      period_start, period_end, issued_at, metadata,
      tenants ( name ),
      subscription_plans ( name )
    `)
    .order('issued_at', { ascending: false })
    .limit(limit)

  return ((data ?? []) as Array<
    SubscriptionInvoiceRow & {
      tenants?: { name?: string }
      subscription_plans?: { name?: string } | null
    }
  >).map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    payment_id: row.payment_id,
    plan_id: row.plan_id,
    invoice_no: row.invoice_no,
    amount_ugx: Number(row.amount_ugx ?? 0),
    currency: row.currency,
    period_start: row.period_start,
    period_end: row.period_end,
    issued_at: row.issued_at,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    tenant_name: row.tenants?.name,
    plan_name: row.subscription_plans?.name ?? (row.metadata?.plan_name as string | undefined) ?? null,
  }))
}

export async function getSubscriptionInvoice(id: string): Promise<SubscriptionInvoiceRow | null> {
  const { data } = await db()
    .from('subscription_invoices')
    .select(`
      id, tenant_id, payment_id, plan_id, invoice_no, amount_ugx, currency,
      period_start, period_end, issued_at, metadata,
      tenants ( name ),
      subscription_plans ( name )
    `)
    .eq('id', id)
    .maybeSingle()

  if (!data) return null
  const row = data as SubscriptionInvoiceRow & {
    tenants?: { name?: string }
    subscription_plans?: { name?: string } | null
  }
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    payment_id: row.payment_id,
    plan_id: row.plan_id,
    invoice_no: row.invoice_no,
    amount_ugx: Number(row.amount_ugx ?? 0),
    currency: row.currency,
    period_start: row.period_start,
    period_end: row.period_end,
    issued_at: row.issued_at,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
    tenant_name: row.tenants?.name,
    plan_name: row.subscription_plans?.name ?? (row.metadata?.plan_name as string | undefined) ?? null,
  }
}

export async function handleFlutterwaveWebhook(payload: {
  event?: string
  data?: {
    status?: string
    tx_ref?: string
    id?: number | string
    payment_type?: string
    amount?: number
    customer?: { email?: string; name?: string }
  }
}): Promise<{ ok: boolean; idempotent?: boolean; error?: string }> {
  const event = payload.event
  const data = payload.data

  // Handle subscription.cancelled — Flutterwave does NOT send a tx_ref for this event.
  // We look up the tenant via the customer email and mark cancel_at_period_end = true
  // so they retain access until their current period ends, then transition to cancelled.
  if (event === 'subscription.cancelled') {
    const email = data?.customer?.email
    if (email) {
      const { data: profile } = await db()
        .from('profiles')
        .select('tenant_id')
        .eq('email', email)
        .maybeSingle()
      if (profile?.tenant_id) {
        await db()
          .from('tenant_subscriptions')
          .update({ cancel_at_period_end: true, updated_at: new Date().toISOString() })
          .eq('tenant_id', profile.tenant_id)
        await db().from('subscription_events').insert({
          tenant_id: profile.tenant_id,
          from_status: null,
          to_status: null,
          reason: 'subscription_cancelled_via_flutterwave',
          actor: 'webhook',
          metadata: { email },
        })
      }
    }
    // Always return ok to stop Flutterwave retry loop — even if email lookup failed
    return { ok: true }
  }

  if (!data?.tx_ref) return { ok: false, error: 'missing_tx_ref' }

  const claimsSuccess = event === 'charge.completed' && data.status === 'successful'

  const { data: payment, error } = await db()
    .from('subscription_payments')
    .select('id, status, provider_tx_ref')
    .eq('provider_tx_ref', data.tx_ref)
    .maybeSingle()

  if (error || !payment) return { ok: false, error: 'payment_not_found' }
  if (payment.status === 'successful') {
    // Replayed webhook for an already-confirmed payment — no-op, ack with 200.
    return { ok: true, idempotent: true }
  }

  if (!claimsSuccess) {
    await db()
      .from('subscription_payments')
      .update({
        status: 'failed',
        raw_payload: payload,
        provider_tx_id: data.id != null ? String(data.id) : null,
        method: data.payment_type ?? null,
      })
      .eq('id', payment.id)
    return { ok: true }
  }

  if (data.id == null) return { ok: false, error: 'missing_transaction_id' }

  // Never trust the webhook payload alone — confirm re-verifies with Flutterwave
  // (status/currency/amount/tx_ref) before activating.
  const result = await confirmSubscriptionPayment({
    transactionId: String(data.id),
    txRef: data.tx_ref,
    actor: 'webhook',
    rawPayload: payload,
    method: data.payment_type ?? null,
  })

  if (!result.ok) return { ok: false, error: result.reason }
  return { ok: true, idempotent: result.idempotent }
}
