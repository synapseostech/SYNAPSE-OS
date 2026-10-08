/** Escape text for HTML element/attribute content in server-rendered emails. */
export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  )
}

const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i

/**
 * Allow only inline raster images (data:image/...;base64) or https/relative
 * URLs for <img src> in print documents. Anything else (javascript:, data:text/html,
 * svg, quotes) is rejected and the logo is simply omitted.
 */
export function safeImageSrc(value: unknown): string | null {
  if (typeof value !== "string") return null
  const v = value.trim()
  if (!v || v.length > 2_000_000) return null
  if (v.startsWith("data:")) return SAFE_DATA_IMAGE.test(v) ? v : null
  if (v.startsWith("/") && !v.startsWith("//")) return escapeHtml(v)
  try {
    const u = new URL(v)
    return u.protocol === "https:" ? escapeHtml(u.toString()) : null
  } catch {
    return null
  }
}
