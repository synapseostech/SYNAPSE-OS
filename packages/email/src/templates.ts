// packages/email/src/templates.ts
import { brandedHtml } from './client'

const ORANGE = '#F97316'
const MUTED = '#A0A0B0'
const DIM = '#60607A'

export function otpHtml(params: {
  name: string
  otp: string
  purpose: 'login' | 'verify' | 'reset'
  expiryMinutes?: number
}): string {
  const verb = { login: 'sign in', verify: 'verify your email', reset: 'reset your password' }[params.purpose]
  return brandedHtml(`
    <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;color:#F5F5F7;">Your verification code</h2>
    <p style="font-size:14px;line-height:1.6;color:${MUTED};margin:0 0 28px;">
      Hello ${params.name || 'there'},<br/>
      Use this code to ${verb}. It expires in
      <strong style="color:#F5F5F7;">${params.expiryMinutes ?? 10} minutes</strong>.
    </p>
    <div style="background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.25);
                border-radius:12px;padding:28px 20px;text-align:center;margin-bottom:28px;">
      <span style="font-family:monospace;font-size:42px;font-weight:700;
                   letter-spacing:0.25em;color:${ORANGE};">${params.otp}</span>
    </div>
    <p style="font-size:13px;color:${DIM};margin:0;">
      Never share this code. Synapse will never ask for it by phone or chat.<br/>
      If you didn't request this, you can safely ignore this email.
    </p>
  `)
}

export function inviteHtml(params: {
  name: string
  facilityName: string
  role: string
  inviteUrl: string
}): string {
  // Invitations carry only a single-use setup link. Passwords are never emailed.
  return brandedHtml(`
    <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#F5F5F7;">
      You've been added to ${params.facilityName}
    </h2>
    <p style="font-size:14px;line-height:1.7;color:${MUTED};margin:0 0 8px;">
      Hello ${params.name},<br/>
      You have been enrolled as a <strong style="color:${ORANGE};">${params.role}</strong>
      at <strong style="color:#F5F5F7;">${params.facilityName}</strong> on the Synapse Health platform.
    </p>
    <div style="background:#1A1A24;border:1px solid rgba(255,255,255,0.08);border-radius:10px;
                padding:20px;margin:20px 0;">
      <a href="${params.inviteUrl}"
         style="display:inline-block;background:${ORANGE};color:#07070A;font-weight:700;
                font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
        Set Up Your Account →
      </a>
      <p style="color:${DIM};font-size:12px;margin:12px 0 0;">This link expires in 48 hours.</p>
    </div>
  `)
}

export function passwordResetHtml(params: { name: string; resetUrl: string }): string {
  return brandedHtml(`
    <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#F5F5F7;">Reset your password</h2>
    <p style="font-size:14px;line-height:1.7;color:#A0A0B0;margin:0 0 24px;">
      Hello ${params.name || 'there'},<br/>
      We received a request to reset your Synapse password.
    </p>
    <a href="${params.resetUrl}"
       style="display:inline-block;background:${ORANGE};color:#07070A;font-weight:700;
              font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
      Reset Password →
    </a>
    <p style="color:#60607A;font-size:12px;margin:16px 0 0;">
      This link expires in 15 minutes. If you didn't request this, ignore this email.
    </p>
  `)
}

export function welcomeHtml(params: {
  name: string
  product?: string
  ctaUrl?: string
  ctaLabel?: string
}): string {
  const product = params.product ?? 'Synapse OS'
  const ctaUrl = params.ctaUrl ?? 'https://synapseos.tech/health/dashboard'
  const ctaLabel = params.ctaLabel ?? 'Open Dashboard →'
  return brandedHtml(`
    <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">
      Welcome, ${params.name.split(' ')[0]}. Your account is ready.
    </h2>
    <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 20px;">
      You've successfully joined ${product} — built for Ugandan pharmacies and health facilities.
    </p>
    <a href="${ctaUrl}"
       style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;
              font-size:13px;padding:12px 24px;border-radius:8px;text-decoration:none;">
      ${ctaLabel}
    </a>
  `)
}

// ── Billing lifecycle notices (Workstream C) ─────────────────────────────────

export type BillingNoticeParams = {
  name: string
  pharmacyName: string
  heading: string
  /** pre-rendered inner HTML lines (already escaped by callers — values are server-derived) */
  bodyHtml: string
  ctaUrl: string
  ctaLabel: string
  tone?: 'info' | 'warning' | 'critical'
}

export function billingNoticeHtml(params: BillingNoticeParams): string {
  const toneColor =
    params.tone === 'critical' ? '#EF4444' : params.tone === 'warning' ? '#E8B84B' : ORANGE
  return brandedHtml(`
    <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;color:#F5F5F7;">${params.heading}</h2>
    <p style="font-size:14px;line-height:1.7;color:${MUTED};margin:0 0 8px;">
      Hello ${params.name || 'there'},
    </p>
    <div style="border-left:3px solid ${toneColor};padding:4px 0 4px 14px;margin:16px 0;
                font-size:14px;line-height:1.7;color:${MUTED};">
      ${params.bodyHtml}
    </div>
    <a href="${params.ctaUrl}"
       style="display:inline-block;background:${toneColor};color:#07070A;font-weight:700;
              font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;margin:8px 0 20px;">
      ${params.ctaLabel}
    </a>
    <p style="font-size:12px;color:${DIM};margin:0;">
      ${params.pharmacyName} · Synapse Pharm · Pay via MTN MoMo, Airtel Money, or card.<br/>
      Questions? Reply to this email or write to support@synapseos.tech.
    </p>
  `)
}

// ── Official receipts (payment + free trial) ─────────────────────────────────

export type ReceiptLine = { label: string; value: string }

export type ReceiptHtmlParams = {
  receiptNo: string
  kind: 'payment' | 'trial'
  customerName: string
  customerEmail: string
  facilityName: string
  planName: string
  amountLabel: string
  currency?: string
  periodLabel?: string | null
  issuedAtLabel: string
  methodLabel?: string | null
  lines?: ReceiptLine[]
  ctaUrl?: string
  ctaLabel?: string
}

/** Clear, printable-style receipt with Synapse logo (via branded shell). */
export function receiptHtml(params: ReceiptHtmlParams): string {
  const isTrial = params.kind === 'trial'
  const title = isTrial ? 'Free trial confirmation' : 'Payment receipt'
  const badge = isTrial ? 'TRIAL' : 'PAID'
  const badgeColor = isTrial ? '#E8B84B' : '#22C55E'
  const extraRows = (params.lines ?? [])
    .map(
      (line) => `
      <tr>
        <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">${line.label}</td>
        <td style="padding:8px 0;font-size:13px;color:#F5F5F7;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${line.value}</td>
      </tr>`,
    )
    .join('')

  const cta =
    params.ctaUrl && params.ctaLabel
      ? `<a href="${params.ctaUrl}"
         style="display:inline-block;background:${ORANGE};color:#07070A;font-weight:700;
                font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;margin-top:8px;">
         ${params.ctaLabel}
       </a>`
      : ''

  return brandedHtml(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px;">
      <h2 style="margin:0;font-size:20px;font-weight:700;color:#F5F5F7;">${title}</h2>
      <span style="display:inline-block;font-size:11px;font-weight:700;letter-spacing:0.12em;
                   color:${badgeColor};border:1px solid ${badgeColor}55;border-radius:999px;padding:4px 10px;">
        ${badge}
      </span>
    </div>
    <p style="font-size:13px;color:${DIM};margin:0 0 20px;font-family:monospace;">
      ${params.receiptNo} · Issued ${params.issuedAtLabel}
    </p>
    <p style="font-size:14px;line-height:1.7;color:${MUTED};margin:0 0 20px;">
      Hello ${params.customerName || 'there'},<br/>
      ${
        isTrial
          ? `Your free trial of <strong style="color:#F5F5F7;">Synapse Pharm</strong> for
             <strong style="color:#F5F5F7;">${params.facilityName}</strong> is active.`
          : `Thank you. We received your subscription payment for
             <strong style="color:#F5F5F7;">${params.facilityName}</strong>.`
      }
    </p>
    <div style="background:#1A1A24;border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:20px;margin:0 0 20px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
        <tr>
          <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">Facility</td>
          <td style="padding:8px 0;font-size:13px;color:#F5F5F7;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${params.facilityName}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">Plan</td>
          <td style="padding:8px 0;font-size:13px;color:#F5F5F7;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${params.planName}</td>
        </tr>
        <tr>
          <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">Amount</td>
          <td style="padding:8px 0;font-size:18px;font-weight:700;color:${ORANGE};text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${params.amountLabel}</td>
        </tr>
        ${
          params.periodLabel
            ? `<tr>
          <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">Period</td>
          <td style="padding:8px 0;font-size:13px;color:#F5F5F7;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${params.periodLabel}</td>
        </tr>`
            : ''
        }
        ${
          params.methodLabel
            ? `<tr>
          <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">Method</td>
          <td style="padding:8px 0;font-size:13px;color:#F5F5F7;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${params.methodLabel}</td>
        </tr>`
            : ''
        }
        <tr>
          <td style="padding:8px 0;font-size:13px;color:${MUTED};border-bottom:1px solid rgba(255,255,255,0.06);">Billed to</td>
          <td style="padding:8px 0;font-size:13px;color:#F5F5F7;text-align:right;border-bottom:1px solid rgba(255,255,255,0.06);">${params.customerEmail}</td>
        </tr>
        ${extraRows}
      </table>
    </div>
    ${cta}
    <p style="font-size:12px;color:${DIM};margin:20px 0 0;">
      Synapse Health Technologies Ltd · Official receipt<br/>
      Keep this email for your records. Questions? support@synapseos.tech
    </p>
  `)
}
