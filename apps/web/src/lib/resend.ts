import { Resend } from 'resend'

let resendClient: Resend | null = null

type ResendSendArgs = Parameters<Resend['emails']['send']>
type ResendSendPayload = {
  from?: string
  to?: string | string[]
}
type ResendSendResult = {
  data?: { id?: string } | null
  error?: { name?: string; message?: string } | null
}

export function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    throw new Error('RESEND_API_KEY is not configured')
  }
  resendClient ??= new Resend(apiKey)
  return resendClient
}

function domainFromAddress(value: string | undefined): string | null {
  if (!value) return null
  const match = value.match(/@([^>\s]+)>?$/)
  return match?.[1]?.toLowerCase() ?? null
}

function toDomains(to: ResendSendPayload['to']): string[] {
  const recipients = Array.isArray(to) ? to : to ? [to] : []
  return Array.from(new Set(recipients.map(domainFromAddress).filter(Boolean) as string[]))
}

function formatResendError(error: NonNullable<ResendSendResult['error']>): string {
  return [error.name, error.message].filter(Boolean).join(': ') || 'Unknown Resend error'
}

function formatLogDomains(payload: ResendSendPayload | undefined): string {
  const fromDomain = domainFromAddress(payload?.from) ?? 'unknown'
  const recipientDomains = toDomains(payload?.to).join(',') || 'unknown'
  return `fromDomain=${fromDomain} toDomains=${recipientDomains}`
}

export const resend = {
  emails: {
    send: async (...args: ResendSendArgs) => {
      const payload = args[0] as ResendSendPayload | undefined
      let result: ResendSendResult

      try {
        result = (await getResend().emails.send(...args)) as ResendSendResult
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(`[resend] email send threw error="${message}" ${formatLogDomains(payload)}`)
        throw error
      }

      if (result.error) {
        const message = formatResendError(result.error)
        console.error(`[resend] email rejected error="${message}" ${formatLogDomains(payload)}`)
        throw new Error(`Resend rejected email: ${message}`)
      }

      console.info(
        `[resend] email accepted id="${result.data?.id ?? 'unknown'}" ${formatLogDomains(payload)}`
      )

      return result
    },
  },
}

export const NOTIFY_EMAILS = ['synapseostech@gmail.com']
export const FROM_EMAIL    = process.env.RESEND_FROM_EMAIL ?? 'noreply@synapseos.tech'
export const FROM_NAME     = 'Synapse OS'
/**
 * Organisation postal address for email footers, from config only
 * (EMAIL_ORGANIZATION_POSTAL_ADDRESS). Never hardcode a personal/residential
 * address. When unset, the footer omits the address line.
 */
export function organizationPostalAddress(env: NodeJS.Dict<string> = process.env): string | null {
  const v = env.EMAIL_ORGANIZATION_POSTAL_ADDRESS?.trim()
  return v ? v.slice(0, 300) : null
}

export function escapeEmailHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

export function organizationFooterLine(env: NodeJS.Dict<string> = process.env): string {
  const address = organizationPostalAddress(env)
  return `Synapse Health Technologies Ltd${address ? ` &middot; ${escapeEmailHtml(address)}` : ''}`
}
export const DEFAULT_UNSUBSCRIBE_URL =
  process.env.NEXT_PUBLIC_UNSUBSCRIBE_URL ?? 'https://synapseos.tech/unsubscribed'
export const LOGO_URL = process.env.NEXT_PUBLIC_EMAIL_LOGO_URL ?? 'https://synapseos.tech/synapse-logo.png'

/* Branded HTML wrapper.
 * Pass unsubscribeUrl for marketing emails (newsletter) - required by CAN-SPAM.
 * Omit for transactional emails (OTP, welcome, confirmation). */
export function brandedEmail({
  subject,
  body,
  unsubscribeUrl,
}: {
  subject: string
  body: string
  unsubscribeUrl?: string
}): string {
  const unsubscribeHref = unsubscribeUrl ?? DEFAULT_UNSUBSCRIBE_URL
  const footer = `<p style="margin:0 0 6px;font-size:12px;color:#60607A;">
      ${organizationFooterLine()}<br/>
      <a href="https://synapseos.tech" style="color:#F97316;text-decoration:none;">synapseos.tech</a>
      &nbsp;&middot;&nbsp;
      <a href="https://synapseos.tech/contact" style="color:#60607A;text-decoration:none;">Contact us</a>
    </p>
    <p style="margin:0;font-size:11px;color:#40405A;">
      Email preferences: <a href="${unsubscribeHref}" style="color:#60607A;text-decoration:underline;">Unsubscribe</a>
    </p>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#07070A;font-family:'DM Sans',Arial,sans-serif;color:#F5F5F7;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#07070A;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="background:#111117;border-radius:16px;border:1px solid rgba(255,255,255,0.1);overflow:hidden;max-width:600px;">
          <!-- Top gradient bar -->
          <tr><td style="background:linear-gradient(135deg,#F97316,#E8B84B);padding:4px 0;"></td></tr>
          <!-- Header + body -->
          <tr>
            <td style="padding:32px 40px 24px;">
              <div style="margin-bottom:24px;">
                <img src="${LOGO_URL}" alt="Synapse OS" width="40" height="40"
                  style="border-radius:9px;display:inline-block;vertical-align:middle;margin-right:10px;" />
                <span style="font-size:22px;font-weight:800;letter-spacing:-0.02em;vertical-align:middle;">
                  <span style="color:#F97316;">Synapse</span><span style="color:#E8B84B;">OS</span>
                </span>
              </div>
              ${body}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.06);">
              ${footer}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
}

/* Transactional: OTP verification code email */
export async function sendOtpEmail(email: string, otp: string): Promise<void> {
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: `${otp} - Your Synapse OS verification code`,
    html: brandedEmail({
      subject: `Your Synapse OS verification code`,
      body: `
        <h2 style="margin:0 0 8px;font-size:18px;font-weight:700;color:#F5F5F7;">Your verification code</h2>
        <p style="font-size:14px;line-height:1.6;color:#A0A0B0;margin:0 0 28px;">
          Use this code to sign in to Synapse OS. It expires in <strong style="color:#F5F5F7;">10 minutes</strong>.
        </p>
        <div style="background:rgba(249,115,22,0.08);border:1px solid rgba(249,115,22,0.25);border-radius:12px;padding:28px 20px;text-align:center;margin-bottom:28px;">
          <span style="font-family:'IBM Plex Mono',monospace,Courier;font-size:42px;font-weight:700;letter-spacing:0.25em;color:#F97316;">${otp}</span>
        </div>
        <p style="font-size:13px;color:#60607A;margin:0;">
          Never share this code. Synapse OS will never ask for it by phone or chat.<br/>
          If you didn't request this, you can safely ignore this email.
        </p>
      `,
    }),
  })
}

/* Transactional: welcome email after successful onboarding */
export async function sendWelcomeEmail(email: string, name: string): Promise<void> {
  const firstName = name.split(' ')[0]
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: `Welcome to Synapse OS, ${firstName}`,
    html: brandedEmail({
      subject: `Welcome to Synapse OS`,
      body: `
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">
          Welcome, ${firstName}. Your account is ready.
        </h2>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 20px;">
          You have successfully joined Synapse OS - Africa's sovereign AI-powered health platform.
          Your hospital's clinical workflows, records, and analytics are now at your fingertips.
        </p>
        <a href="https://synapseos.tech/health/dashboard"
          style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;font-size:13px;padding:12px 24px;border-radius:8px;text-decoration:none;">
          Open Dashboard
        </a>
      `,
    }),
  })
}

/* Transactional: email activation after account creation */
export async function sendActivationEmail(email: string, name: string, activationUrl: string): Promise<void> {
  const firstName = name.split(' ')[0] || 'there'
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: `Activate your Synapse OS account`,
    html: brandedEmail({
      subject: `Activate your Synapse OS account`,
      body: `
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">
          Confirm your email, ${firstName}.
        </h2>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 22px;">
          Your Synapse OS account has been created, but it is locked until this email address is activated.
          Use the secure link below to activate your account. This link expires in 24 hours.
        </p>
        <a href="${activationUrl}"
          style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;font-size:13px;padding:12px 24px;border-radius:8px;text-decoration:none;">
          Activate Account
        </a>
        <p style="font-size:13px;color:#60607A;margin:22px 0 0;">
          If you did not create this account, you can safely ignore this email.
        </p>
      `,
    }),
  })
}

/* Transactional: password reset */
export async function sendPasswordResetEmail(email: string, name: string, resetUrl: string): Promise<void> {
  const firstName = name.split(' ')[0] || 'there'
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: `Reset your Synapse OS password`,
    html: brandedEmail({
      subject: `Reset your Synapse OS password`,
      body: `
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">
          Reset your password, ${firstName}.
        </h2>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 22px;">
          Use the secure link below to set a new Synapse OS password. This link expires in 15 minutes.
        </p>
        <a href="${resetUrl}"
          style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;font-size:13px;padding:12px 24px;border-radius:8px;text-decoration:none;">
          Reset Password
        </a>
        <p style="font-size:13px;color:#60607A;margin:22px 0 0;">
          If you didn't request this, you can safely ignore this email.
        </p>
      `,
    }),
  })
}

export async function sendPharmacyInviteEmail({
  to,
  pharmacyName,
  adminName,
  inviteToken,
}: {
  to: string
  pharmacyName: string
  adminName: string
  inviteToken: string
}): Promise<void> {
  const pharmacyAppUrl = process.env.NEXT_PUBLIC_PHARMACY_APP_URL ?? "https://pharm.synapseos.tech"
  const inviteUrl = `${pharmacyAppUrl.replace(/\/$/, "")}/invite/${inviteToken}`
  const firstName = adminName.split(' ')[0] || 'there'
  await resend.emails.send({
    from: `Synapse Health <${FROM_EMAIL}>`,
    to: [to],
    subject: `You have been enrolled on Synapse Pharmacy - ${pharmacyName}`,
    html: brandedEmail({
      subject: `You've been enrolled on Synapse Pharmacy`,
      body: `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#F5F5F7;">
          Welcome to Synapse Pharmacy, ${firstName}.
        </h2>
        <p style="font-size:14px;line-height:1.7;color:#A0A0B0;margin:0 0 8px;">
          <strong style="color:#F5F5F7;">${pharmacyName}</strong> has been enrolled on
          Synapse Health Technologies. You are the pharmacy administrator.
        </p>
        <p style="font-size:14px;line-height:1.7;color:#A0A0B0;margin:0 0 24px;">
          Click below to set up your account and get started.
        </p>
        <a href="${inviteUrl}"
          style="display:inline-block;background:#F97316;color:#fff;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
          Set Up Your Account
        </a>
        <p style="font-size:12px;color:#60607A;margin:20px 0 0;">
          This link expires in 7 days. If you didn't expect this email, you can safely ignore it.
        </p>
      `,
    }),
  })
}

export async function sendHospitalStaffInviteEmail({
  to,
  hospitalName,
  staffName,
  role,
  inviteUrl,
}: {
  to: string
  hospitalName: string
  staffName: string
  role: string
  /** Single-use, hashed, expiring facility invitation link. Passwords are never emailed. */
  inviteUrl: string
}): Promise<void> {
  if (!inviteUrl || !/^(?:https:\/\/|http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/)/.test(inviteUrl)) {
    throw new Error('invite_url_required')
  }
  const setupUrl = escapeEmailHtml(inviteUrl)
  const firstName = escapeEmailHtml(staffName.split(' ')[0] || 'there')
  const safeHospital = escapeEmailHtml(hospitalName)
  const safeRole = escapeEmailHtml(role.replace(/_/g, ' '))
  const credentialBlock = `
        <p style="font-size:14px;line-height:1.7;color:#A0A0B0;margin:0 0 20px;">
          Use the secure single-use link below to choose your password and activate your account.
        </p>
        <a href="${setupUrl}"
          style="display:inline-block;background:#F97316;color:#fff;font-weight:700;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none;">
          Set Up Your Account
        </a>
        <p style="font-size:12px;color:#60607A;margin:20px 0 0;">
          This link expires in 7 days and can only be used once.
        </p>`

  await resend.emails.send({
    from: `Synapse Health <${FROM_EMAIL}>`,
    to: [to],
    subject: `You've been invited to ${hospitalName} on Synapse OS`,
    html: brandedEmail({
      subject: `You've been invited to ${safeHospital}`,
      body: `
        <h2 style="margin:0 0 8px;font-size:20px;font-weight:700;color:#F5F5F7;">
          Welcome to ${safeHospital}, ${firstName}.
        </h2>
        <p style="font-size:14px;line-height:1.7;color:#A0A0B0;margin:0 0 20px;">
          You have been invited as <strong style="color:#F5F5F7;">${safeRole}</strong>
          on Synapse Health Technologies.
        </p>
        ${credentialBlock}
      `,
    }),
  })
}

/* Transactional: waitlist confirmation for APK download */
export async function sendWaitlistEmail(email: string): Promise<void> {
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: "You're on the Synapse OS app waitlist",
    html: brandedEmail({
      subject: "You're on the Synapse OS app waitlist",
      body: `
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">You're on the list.</h2>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 16px;">
          We'll notify you as soon as the Synapse OS mobile app is available for download.
          You'll be among the first to access real-time clinical tools on mobile.
        </p>
        <a href="https://synapseos.tech"
          style="display:inline-block;background:rgba(255,255,255,0.08);color:#F5F5F7;font-weight:600;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;border:1px solid rgba(255,255,255,0.12);">
          Learn more at synapseos.tech
        </a>
      `,
    }),
  })
}
