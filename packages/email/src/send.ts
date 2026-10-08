// packages/email/src/send.ts
import { getResend, FROM_ADDRESS } from './client'
import {
  otpHtml,
  inviteHtml,
  passwordResetHtml,
  welcomeHtml,
  billingNoticeHtml,
  receiptHtml,
  type ReceiptHtmlParams,
} from './templates'

type EmailPayload = Parameters<ReturnType<typeof getResend>['emails']['send']>[0]

// Resend reports rejected sends (bad key, unverified sender domain, invalid recipient)
// in the resolved value rather than by throwing.
async function deliver(payload: EmailPayload): Promise<void> {
  const { error } = await getResend().emails.send(payload)
  if (error) throw new Error(`[SYNAPSE] email not accepted by Resend: ${error.name ?? 'error'}: ${error.message}`)
}

export async function sendOTP(params: {
  to: string
  name: string
  otp: string
  purpose: 'login' | 'verify' | 'reset'
}): Promise<void> {
  const subjects = {
    login: 'Your Synapse sign-in code',
    verify: 'Verify your Synapse account',
    reset: 'Reset your Synapse password',
  }
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: subjects[params.purpose],
    html: otpHtml(params),
  })
}

export async function sendInvite(params: {
  to: string
  name: string
  facilityName: string
  role: string
  inviteUrl: string
}): Promise<void> {
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: `You've been enrolled on Synapse — ${params.facilityName}`,
    html: inviteHtml(params),
  })
}

export async function sendPasswordReset(params: {
  to: string
  name: string
  resetUrl: string
}): Promise<void> {
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: 'Reset your Synapse password',
    html: passwordResetHtml(params),
  })
}

export async function sendWelcome(params: {
  to: string
  name: string
  product?: string
  ctaUrl?: string
  ctaLabel?: string
}): Promise<void> {
  const product = params.product ?? 'Synapse OS'
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: `Welcome to ${product}, ${params.name.split(' ')[0]}`,
    html: welcomeHtml(params),
  })
}

// ── Billing lifecycle notices (Workstream C) ─────────────────────────────────

function ugx(n: number): string {
  return `UGX ${Math.round(n).toLocaleString('en-UG')}`
}

function kampalaDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Kampala',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
}

export async function sendRenewalReminder(params: {
  to: string
  name: string
  pharmacyName: string
  planName: string
  amountUgx: number
  periodEnd: string
  payUrl: string
  /** 'trial' when the date is a trial expiry rather than a paid-period end */
  kind?: 'renewal' | 'trial'
}): Promise<void> {
  const isTrial = params.kind === 'trial'
  const when = kampalaDate(params.periodEnd)
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: isTrial
      ? `Your Synapse Pharm trial ends ${when}`
      : `Your Synapse Pharm subscription renews ${when}`,
    html: billingNoticeHtml({
      name: params.name,
      pharmacyName: params.pharmacyName,
      heading: isTrial ? 'Your free trial is ending soon' : 'Renewal coming up',
      bodyHtml: isTrial
        ? `The free trial for <strong style="color:#F5F5F7;">${params.pharmacyName}</strong> ends on
           <strong style="color:#F5F5F7;">${when}</strong>. Subscribe to <strong style="color:#F5F5F7;">${params.planName}</strong>
           (${ugx(params.amountUgx)}) to keep selling without interruption.`
        : `The <strong style="color:#F5F5F7;">${params.planName}</strong> subscription for
           <strong style="color:#F5F5F7;">${params.pharmacyName}</strong> ends on
           <strong style="color:#F5F5F7;">${when}</strong>. Renew for ${ugx(params.amountUgx)} to keep full access.`,
      ctaUrl: params.payUrl,
      ctaLabel: isTrial ? 'Subscribe now' : 'Renew now',
      tone: 'info',
    }),
  })
}

export async function sendPastDueNotice(params: {
  to: string
  name: string
  pharmacyName: string
  graceUntil: string | null
  payUrl: string
}): Promise<void> {
  const graceLine = params.graceUntil
    ? `You have a grace period until <strong style="color:#F5F5F7;">${kampalaDate(params.graceUntil)}</strong> —
       after that, POS and inventory are paused until payment.`
    : 'Pay now to avoid your POS and inventory being paused.'
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: `Payment overdue — ${params.pharmacyName} on Synapse Pharm`,
    html: billingNoticeHtml({
      name: params.name,
      pharmacyName: params.pharmacyName,
      heading: 'Your subscription payment is overdue',
      bodyHtml: `The subscription for <strong style="color:#F5F5F7;">${params.pharmacyName}</strong> has expired.
                 ${graceLine} Your data is safe either way.`,
      ctaUrl: params.payUrl,
      ctaLabel: 'Pay now',
      tone: 'warning',
    }),
  })
}

export async function sendSuspensionNotice(params: {
  to: string
  name: string
  pharmacyName: string
  payUrl: string
}): Promise<void> {
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: `Account suspended — ${params.pharmacyName} on Synapse Pharm`,
    html: billingNoticeHtml({
      name: params.name,
      pharmacyName: params.pharmacyName,
      heading: 'Your Synapse Pharm access is suspended',
      bodyHtml: `The grace period for <strong style="color:#F5F5F7;">${params.pharmacyName}</strong> has ended and
                 operational features (POS, inventory, reports) are paused.
                 <strong style="color:#F5F5F7;">Nothing has been deleted</strong> — all sales, stock and staff data
                 are intact. Pay to reactivate instantly.`,
      ctaUrl: params.payUrl,
      ctaLabel: 'Reactivate now',
      tone: 'critical',
    }),
  })
}

// ── Receipts ─────────────────────────────────────────────────────────────────

export async function sendPaymentReceipt(
  params: Omit<ReceiptHtmlParams, 'kind'> & { to: string },
): Promise<void> {
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: `Receipt ${params.receiptNo} — ${params.facilityName}`,
    html: receiptHtml({ ...params, kind: 'payment' }),
  })
}

export async function sendTrialReceipt(
  params: Omit<ReceiptHtmlParams, 'kind' | 'amountLabel'> & {
    to: string
    amountLabel?: string
  },
): Promise<void> {
  await deliver({
    from: FROM_ADDRESS,
    to: params.to,
    subject: `Trial confirmation ${params.receiptNo} — ${params.facilityName}`,
    html: receiptHtml({
      ...params,
      kind: 'trial',
      amountLabel: params.amountLabel ?? 'UGX 0 (free trial)',
    }),
  })
}
