/**
 * Regression guard: every console page and every platform API read names the
 * capability it needs, on the server.
 *
 * mutation-gates.test.ts covers writes. This covers reads: a page that only
 * called requirePlatformAdmin() opened for ANY platform role (an investor
 * observer could read the audit log, receipts and every user's email), and the
 * sidebar map was only used to hide links. Now each page calls
 * requirePlatformPage("<its own route>"), which resolves the capability from
 * NAV_CAPABILITY_MAP, and client-component pages are gated by a server
 * layout.tsx beside them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { NAV_CAPABILITY_MAP, PLATFORM_CAPABILITIES, navRequiresCapability } from '../../lib/platform/rbac'

const PLATFORM = fileURLToPath(new URL('.', import.meta.url))
const API = fileURLToPath(new URL('../api/platform', import.meta.url))

/** Pages any signed-in (or not yet signed-in) person must reach. */
const PUBLIC_PAGES = new Set(['/platform/login', '/platform/mfa', '/platform/mfa-verify', '/platform/invite/[token]', '/platform/account'])

/** GET handlers that serve the caller only. */
const SELF_SERVICE_GETS = new Set(['me/route.ts'])

function walk(dir: string, match: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, match, out)
    else if (match(name)) out.push(p)
  }
  return out
}

function routeOf(pageFile: string): string {
  const rel = relative(PLATFORM, pageFile).split('\\').join('/').replace(/\/?page\.tsx$/, '')
  return rel ? `/platform/${rel}` : '/platform'
}

const isRedirectStub = (src: string) => /\bredirect\(/.test(src) && !/require[A-Z]\w*\(/.test(src) && src.length < 400
const isClient = (src: string) => /^\s*['"]use client['"]/.test(src)

/** The gate this page is protected by: its own call, or the nearest gated layout. */
function gateFor(pageFile: string): { file: string; path: string | null; bare: boolean } | null {
  const src = readFileSync(pageFile, 'utf8')
  const own = src.match(/requirePlatformPage\(\s*['"]([^'"]+)['"]\s*\)/)
  if (own && !isClient(src)) return { file: pageFile, path: own[1]!, bare: false }
  if (/requirePlatformAdmin\(\s*\)/.test(src)) return { file: pageFile, path: null, bare: true }
  const layout = join(pageFile, '..', 'layout.tsx')
  if (existsSync(layout)) {
    const l = readFileSync(layout, 'utf8').match(/requirePlatformPage\(\s*['"]([^'"]+)['"]\s*\)/)
    if (l) return { file: layout, path: l[1]!, bare: false }
  }
  return null
}

describe('console page gates', () => {
  const pages = walk(PLATFORM, (n) => n === 'page.tsx')
  const guarded = pages.filter((p) => !PUBLIC_PAGES.has(routeOf(p)) && !isRedirectStub(readFileSync(p, 'utf8')))

  it('finds the console pages (scanner sanity)', () => {
    const routes = guarded.map(routeOf)
    expect(routes).toEqual(expect.arrayContaining(['/platform', '/platform/audit-log', '/platform/tenants', '/platform/tenants/[id]', '/platform/test-center', '/platform/health']))
    expect(guarded.length).toBeGreaterThan(50)
  })

  it('every page is gated by requirePlatformPage with its own route', () => {
    const bad = guarded
      .map((p) => ({ route: routeOf(p), gate: gateFor(p) }))
      .filter(({ route, gate }) => !gate || gate.bare || gate.path !== route)
      .map(({ route, gate }) => `${route}: ${gate ? (gate.bare ? 'bare requirePlatformAdmin()' : `gated as ${gate.path}`) : 'no server gate'}`)
    expect(bad).toEqual([])
  })

  it('every gated route resolves to a real capability, and observers are kept out of sensitive areas', () => {
    const known = new Set<string>(PLATFORM_CAPABILITIES)
    for (const p of guarded) expect(known.has(navRequiresCapability(routeOf(p))), routeOf(p)).toBe(true)
    for (const cap of Object.values(NAV_CAPABILITY_MAP)) expect(known.has(cap)).toBe(true)
    // Spot-check the areas that leaked before.
    expect(navRequiresCapability('/platform/audit-log')).toBe('audit.read')
    expect(navRequiresCapability('/platform/receipts/abc/edit')).toBe('finance_summary.read')
    expect(navRequiresCapability('/platform/tenants/abc')).toBe('tenant.read')
    expect(navRequiresCapability('/platform/tenants/provision')).toBe('tenant.manage')
    expect(navRequiresCapability('/platform/hospitals/new')).toBe('tenant.manage')
    expect(navRequiresCapability('/platform/database')).toBe('system_health.read')
  })

  it('every sidebar link has an entry in the page map', () => {
    const layout = readFileSync(join(PLATFORM, 'layout.tsx'), 'utf8')
    const hrefs = Array.from(layout.matchAll(/\{\s*href:\s*"([^"]+)"/g)).map((m) => m[1]!)
    expect(hrefs.length).toBeGreaterThan(30)
    expect(hrefs.filter((h) => !(h in NAV_CAPABILITY_MAP))).toEqual([])
  })
})

describe('platform API read gates', () => {
  it('every GET handler names a known capability', () => {
    const known = new Set<string>(PLATFORM_CAPABILITIES)
    const bad: string[] = []
    for (const file of walk(API, (n) => n === 'route.ts')) {
      const rel = relative(API, file).split('\\').join('/')
      if (SELF_SERVICE_GETS.has(rel)) continue
      const src = readFileSync(file, 'utf8')
      const m = /export async function GET\s*\(/.exec(src)
      if (!m) continue
      const rest = src.slice(m.index)
      const end = rest.slice(1).search(/\nexport\s+async\s+function\s/)
      const body = end === -1 ? rest : rest.slice(0, end + 1)
      const gate = body.match(/require(?:PlatformAdminApi|PlatformAccess)\(\s*['"]([^'"]+)['"]\s*\)/)
      if (!gate || !known.has(gate[1]!)) bad.push(rel)
    }
    expect(bad).toEqual([])
  })
})
