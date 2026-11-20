/**
 * Minimal in-memory PostgREST/supabase-js adapter for route and server-action tests.
 * Supports the builder subset used by the platform user lifecycle code:
 * select (count/head), eq, neq, in, is, not(col,'is'|'in',v), or(), ilike, order,
 * range, limit, single, maybeSingle, insert, update, delete, upsert.
 * `or()` understands `col.op.value` terms joined by commas with ops eq, ilike,
 * is, in.(a,b) and not.in.(a,b), which is what the user directory emits.
 */
type Row = Record<string, any>
type Pred = (r: Row) => boolean

function likeToRegExp(pattern: string) {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*')
  return new RegExp(`^${esc}$`, 'i')
}

function parseValue(v: string): any {
  if (v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  return v
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0, cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function termPredicate(term: string): Pred {
  const m = term.match(/^([a-z_]+)\.(not\.)?(eq|ilike|is|in)\.(.*)$/)
  if (!m) throw new Error(`memory-postgrest: unsupported or() term ${term}`)
  const col = m[1] as string
  const not = m[2]
  const op = m[3] as string
  const raw = m[4] as string
  let p: Pred
  if (op === 'eq') p = r => String(r[col]) === raw
  else if (op === 'ilike') { const re = likeToRegExp(raw); p = r => r[col] != null && re.test(String(r[col])) }
  else if (op === 'is') { const v = parseValue(raw); p = r => (r[col] ?? null) === v }
  else { const list = raw.replace(/^\(|\)$/g, '').split(','); p = r => r[col] != null && list.includes(String(r[col])) }
  return not ? r => !p(r) && (op !== 'in' || r[col] != null) : p
}

export function createMemoryDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map(r => ({ ...r }))
  const log: Array<{ table: string; op: string; payload?: unknown }> = []

  function from(table: string) {
    const rows = (tables[table] ??= [])
    const preds: Pred[] = []
    let mode: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select'
    let payload: any
    let single: 'none' | 'single' | 'maybe' = 'none'
    let countMode = false, head = false
    let sorts: Array<[string, boolean]> = []
    let lo = 0, hi = Infinity

    const q: any = {
      select(_cols?: string, opts?: { count?: string; head?: boolean }) {
        if (opts?.count) countMode = true
        if (opts?.head) head = true
        return q
      },
      eq(c: string, v: unknown) { preds.push(r => r[c] === v); return q },
      neq(c: string, v: unknown) { preds.push(r => r[c] !== v); return q },
      gt(c: string, v: any) { preds.push(r => r[c] != null && r[c] > v); return q },
      gte(c: string, v: any) { preds.push(r => r[c] != null && r[c] >= v); return q },
      lt(c: string, v: any) { preds.push(r => r[c] != null && r[c] < v); return q },
      lte(c: string, v: any) { preds.push(r => r[c] != null && r[c] <= v); return q },
      in(c: string, v: unknown[]) { preds.push(r => v.includes(r[c])); return q },
      is(c: string, v: unknown) { preds.push(r => (r[c] ?? null) === v); return q },
      not(c: string, op: string, v: unknown) {
        if (op === 'in') {
          // PostgREST form: not('col', 'in', '(a,b)'). SQL NOT IN excludes NULLs.
          const list = String(v).replace(/^\(|\)$/g, '').split(',').filter(Boolean)
          preds.push(r => r[c] != null && !list.includes(String(r[c]))); return q
        }
        if (op !== 'is') throw new Error('memory-postgrest: only not(col, "is"|"in", value)')
        preds.push(r => (r[c] ?? null) !== v); return q
      },
      ilike(c: string, pattern: string) { const re = likeToRegExp(pattern); preds.push(r => r[c] != null && re.test(String(r[c]))); return q },
      or(expr: string) { const ps = splitTopLevel(expr).map(termPredicate); preds.push(r => ps.some(p => p(r))); return q },
      order(c: string, o?: { ascending?: boolean }) { sorts.push([c, o?.ascending ?? true]); return q },
      limit(n: number) { hi = lo + n - 1; return q },
      range(a: number, b: number) { lo = a; hi = b; return q },
      single() { single = 'single'; return q },
      maybeSingle() { single = 'maybe'; return q },
      insert(v: any) { mode = 'insert'; payload = v; return q },
      update(v: any) { mode = 'update'; payload = v; return q },
      upsert(v: any) { mode = 'upsert'; payload = v; return q },
      delete() { mode = 'delete'; return q },
      then(resolve: (v: any) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject)
      },
    }

    function run() {
      if (mode === 'insert' || mode === 'upsert') {
        const list = (Array.isArray(payload) ? payload : [payload]).map((v: Row) => ({ id: crypto.randomUUID(), created_at: new Date().toISOString(), ...v }))
        rows.push(...list)
        log.push({ table, op: mode, payload })
        if (single === 'single') {
          return list[0]
            ? { data: { ...list[0] }, error: null, count: null }
            : { data: null, error: { code: 'PGRST116', message: 'no rows' }, count: null }
        }
        if (single === 'maybe') return { data: list[0] ? { ...list[0] } : null, error: null, count: null }
        return { data: list, error: null, count: null }
      }
      let matched = rows.filter(r => preds.every(p => p(r)))
      if (mode === 'update') {
        matched.forEach(r => Object.assign(r, payload))
        log.push({ table, op: 'update', payload })
        // PostgREST returns one object for update().select().single().
        if (single !== 'none') {
          const first = matched[0]
          if (!first) return single === 'single' ? { data: null, error: { code: 'PGRST116', message: 'no rows' }, count: null } : { data: null, error: null, count: null }
          return { data: { ...first }, error: null, count: null }
        }
        return { data: matched, error: null, count: null }
      }
      if (mode === 'delete') {
        for (const r of matched) rows.splice(rows.indexOf(r), 1)
        log.push({ table, op: 'delete' })
        return { data: matched, error: null, count: null }
      }
      for (const [c, asc] of [...sorts].reverse()) {
        matched = [...matched].sort((a, b) => (a[c] === b[c] ? 0 : (a[c] > b[c] ? 1 : -1) * (asc ? 1 : -1)))
      }
      const total = matched.length
      const page = matched.slice(lo, hi === Infinity ? undefined : hi + 1)
      if (single !== 'none') {
        if (page.length === 0) {
          return single === 'single'
            ? { data: null, error: { code: 'PGRST116', message: 'no rows' }, count: null }
            : { data: null, error: null, count: null }
        }
        return { data: { ...page[0] }, error: null, count: null }
      }
      return { data: head ? null : page.map(r => ({ ...r })), error: null, count: countMode ? total : null }
    }
    return q
  }

  return { tables, log, from, rpc: async () => ({ data: null, error: null }) }
}
