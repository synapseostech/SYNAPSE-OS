// packages/email/src/client.ts
import { Resend } from 'resend'

let _client: Resend | null = null

export function getResend(): Resend {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('[SYNAPSE] RESEND_API_KEY is not set')
  _client ??= new Resend(key)
  return _client
}

export const FROM_ADDRESS = 'Synapse Health <noreply@synapseos.tech>'
export const SUPPORT_EMAIL = 'support@synapseos.tech'
/**
 * Organisation postal address for email footers, from config only
 * (EMAIL_ORGANIZATION_POSTAL_ADDRESS). Never hardcode a personal/residential
 * address. When unset the address line is omitted.
 */
export function organizationPostalAddress(env: NodeJS.Dict<string> = process.env): string | null {
  const v = env.EMAIL_ORGANIZATION_POSTAL_ADDRESS?.trim()
  return v ? v.slice(0, 300) : null
}

function escapeFooter(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

export function organizationFooterLine(env: NodeJS.Dict<string> = process.env): string {
  const address = organizationPostalAddress(env)
  return `Synapse Health Technologies Ltd${address ? ` &middot; ${escapeFooter(address)}` : ''}`
}
export const DEFAULT_UNSUBSCRIBE_URL =
  process.env.NEXT_PUBLIC_UNSUBSCRIBE_URL ?? 'https://synapseos.tech/unsubscribed'
export const LOGO_URL = process.env.NEXT_PUBLIC_EMAIL_LOGO_URL ?? 'https://synapseos.tech/synapse-logo.png'

const ORANGE = '#F97316'
const GOLD = '#E8B84B'
const DARK = '#07070A'
const SURFACE = '#111117'
const BORDER = 'rgba(255,255,255,0.1)'
const DIM = '#60607A'

export function brandedHtml(body: string, unsubscribeUrl?: string): string {
  const unsubscribeHref = unsubscribeUrl ?? DEFAULT_UNSUBSCRIBE_URL
  const footer = `<p style="margin:0 0 6px;font-size:12px;color:${DIM};">
      ${organizationFooterLine()}<br/>
      <a href="https://synapseos.tech" style="color:${ORANGE};text-decoration:none;">synapseos.tech</a>
      &nbsp;&middot;&nbsp;
      <a href="mailto:${SUPPORT_EMAIL}" style="color:${DIM};text-decoration:none;">${SUPPORT_EMAIL}</a>
     </p>
     <p style="margin:0;font-size:11px;color:${DIM};">
       Email preferences: <a href="${unsubscribeHref}" style="color:${DIM};text-decoration:underline;">Unsubscribe</a>
     </p>`

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:${DARK};font-family:Arial,sans-serif;color:#F5F5F7;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:${DARK};padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0"
        style="background:${SURFACE};border-radius:16px;border:1px solid ${BORDER};overflow:hidden;max-width:600px;">
        <tr><td style="background:linear-gradient(135deg,${ORANGE},${GOLD});padding:4px 0;"></td></tr>
        <tr>
          <td style="padding:32px 40px 24px;">
            <div style="margin-bottom:24px;">
              <img src="${LOGO_URL}" alt="Synapse OS" width="40" height="40"
                style="border-radius:9px;display:inline-block;vertical-align:middle;margin-right:10px;" />
              <span style="font-size:22px;font-weight:800;letter-spacing:0;vertical-align:middle;">
                <span style="color:${ORANGE};">Synapse</span><span style="color:${GOLD};">OS</span>
              </span>
            </div>
            ${body}
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px 28px;border-top:1px solid rgba(255,255,255,0.06);">
            ${footer}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`
}
