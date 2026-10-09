// Accepts a bare hostname; strips scheme/path/port and lowercases.
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  // Hostnames are <= 253 chars; cap before any parsing (CodeQL js/polynomial-redos #2).
  if (raw.length > 2048) return null
  let h = raw.trim().toLowerCase()
  if (!h) return null
  h = h.replace(/^https?:\/\//, '')
  const slash = h.indexOf('/')
  if (slash !== -1) h = h.slice(0, slash)
  h = h.split(':')[0]!.trim()
  // Basic FQDN sanity: labels of [a-z0-9-] separated by dots, TLD >= 2 chars.
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) {
    return null
  }
  return h
}
