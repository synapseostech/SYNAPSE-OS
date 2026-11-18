/**
 * Emails each new APK, with its direct download link, to the people who run a
 * facility on Synapse and to anyone who asked for release news.
 *
 * Recipients: every facility or pharmacy admin with an email address, plus
 * everyone opted in (the APK waitlist and app_release_email_preferences),
 * minus everyone who unsubscribed — an admin who opts out is not emailed.
 *
 * Exactly once per release and address: before sending, each address is
 * claimed as a row in app_release_email_deliveries, unique per (release,
 * email). Only addresses this call managed to claim are sent to, so a webhook
 * EAS delivers twice, the workflow reporting the same build, or two servers
 * racing each send nothing the other already claimed. A send that fails is
 * marked failed and not retried automatically, so no one gets it twice.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import type { StoredRelease } from "./record"

export interface ReleaseEmailStore {
  adminEmails(): Promise<string[]>
  optedInEmails(): Promise<string[]>
  optedOutEmails(): Promise<string[]>
  /** Claims each address for this release; returns only those newly claimed. */
  claim(releaseId: string, emails: string[]): Promise<string[]>
  markSent(releaseId: string, email: string, providerId: string | null): Promise<void>
  markFailed(releaseId: string, email: string, error: string): Promise<void>
}

export type ReleaseEmailMessage = {
  to: string
  subject: string
  html: string
  text: string
  headers: Record<string, string>
}

export type SendReleaseEmail = (message: ReleaseEmailMessage) => Promise<{ id: string | null }>

export type ReleaseEmailRender = (input: {
  subject: string
  body: string
  unsubscribeUrl: string
}) => string

export type AnnounceOutcome = { recipients: number; claimed: number; sent: number; failed: number }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normaliseEmail(value: unknown): string | null {
  const email = typeof value === "string" ? value.trim().toLowerCase() : ""
  return EMAIL.test(email) && email.length <= 254 ? email : null
}

export function releaseRecipients(admins: string[], optedIn: string[], optedOut: string[]): string[] {
  const out = new Set(optedOut.map(normaliseEmail).filter((email): email is string => Boolean(email)))
  const recipients = new Set<string>()
  for (const candidate of [...admins, ...optedIn]) {
    const email = normaliseEmail(candidate)
    if (email && !out.has(email)) recipients.add(email)
  }
  return [...recipients].sort()
}

// ---------------------------------------------------------------------------
// Unsubscribe links: the address plus an HMAC of it, so a link opts out only
// the address it was sent to and cannot be forged for someone else's.
// ---------------------------------------------------------------------------

function unsubscribeSignature(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`app-release-unsubscribe:${email}`).digest("base64url")
}

export function unsubscribeToken(email: string, secret: string): string {
  return `${Buffer.from(email, "utf8").toString("base64url")}.${unsubscribeSignature(email, secret)}`
}

/** The address a token opts out, or null when it was not signed by `secret`. */
export function verifyUnsubscribeToken(token: string | null | undefined, secret: string | undefined): string | null {
  if (!token || !secret) return null
  const [encoded, signature, extra] = token.split(".")
  if (!encoded || !signature || extra !== undefined) return null
  const email = normaliseEmail(Buffer.from(encoded, "base64url").toString("utf8"))
  if (!email) return null
  const expected = Buffer.from(unsubscribeSignature(email, secret))
  const received = Buffer.from(signature)
  return expected.length === received.length && timingSafeEqual(expected, received) ? email : null
}

export function unsubscribeUrl(baseUrl: string, email: string, secret: string): string {
  const url = new URL("/api/mobile/app-releases/unsubscribe", baseUrl)
  url.searchParams.set("t", unsubscribeToken(email, secret))
  return url.toString()
}

// ---------------------------------------------------------------------------
// The message.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )
}

export function releaseEmailContent(
  release: Pick<StoredRelease, "version" | "apkUrl" | "notes">,
  optOutUrl: string,
  render: ReleaseEmailRender,
): Pick<ReleaseEmailMessage, "subject" | "html" | "text"> {
  const subject = `Synapse ${release.version} for Android is ready to install`
  const href = escapeHtml(release.apkUrl)
  const notes = release.notes ? escapeHtml(release.notes) : null
  const body = `
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">Synapse ${escapeHtml(release.version)} is ready</h2>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 20px;">
          A new version of the Synapse Android app is available for your team.${notes ? ` ${notes}` : ""}
        </p>
        <a href="${href}"
          style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;font-size:13px;padding:12px 24px;border-radius:8px;text-decoration:none;">
          Download the APK
        </a>
        <p style="font-size:13px;line-height:1.6;color:#60607A;margin:20px 0 0;">
          Open the link on the Android phone or tablet that runs Synapse, then tap the downloaded file and Install.
          It updates the app in place; data on the device stays where it is. Installed copies will also show this
          update the next time they open.
        </p>
        <p style="font-size:12px;line-height:1.6;color:#60607A;margin:12px 0 0;word-break:break-all;">
          Direct link: <a href="${href}" style="color:#F97316;">${href}</a>
        </p>
      `
  const text = [
    `Synapse ${release.version} for Android is ready.`,
    release.notes ?? "",
    "",
    `Download the APK: ${release.apkUrl}`,
    "",
    "Open the link on the Android device that runs Synapse, then tap the downloaded file and Install. Data on the device stays where it is.",
    "",
    `Stop release emails: ${optOutUrl}`,
  ]
    .filter((line, index, lines) => line !== "" || lines[index - 1] !== "")
    .join("\n")
  return { subject, html: render({ subject, body, unsubscribeUrl: optOutUrl }), text }
}

export async function announceReleaseByEmail(input: {
  release: StoredRelease
  store: ReleaseEmailStore
  send: SendReleaseEmail
  render: ReleaseEmailRender
  secret: string
  baseUrl: string
}): Promise<AnnounceOutcome> {
  const { release, store, send, render, secret, baseUrl } = input
  const [admins, optedIn, optedOut] = await Promise.all([
    store.adminEmails(),
    store.optedInEmails(),
    store.optedOutEmails(),
  ])
  const recipients = releaseRecipients(admins, optedIn, optedOut)
  const claimed = recipients.length ? await store.claim(release.id, recipients) : []

  let sent = 0
  let failed = 0
  for (const email of claimed) {
    const optOut = unsubscribeUrl(baseUrl, email, secret)
    const content = releaseEmailContent(release, optOut, render)
    try {
      const result = await send({
        to: email,
        ...content,
        headers: {
          "List-Unsubscribe": `<${optOut}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      })
      await store.markSent(release.id, email, result.id)
      sent += 1
    } catch (error) {
      failed += 1
      await store
        .markFailed(release.id, email, (error instanceof Error ? error.message : String(error)).slice(0, 500))
        .catch(() => {})
    }
  }
  return { recipients: recipients.length, claimed: claimed.length, sent, failed }
}
