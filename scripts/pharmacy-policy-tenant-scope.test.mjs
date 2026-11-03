import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * pharmacy-policy-tenant-scope.test.mjs — static contract for pharmacy row
 * security and for the account columns that decide who may act at all.
 *
 * History this pins:
 *
 *   PR-011 (20261102120000) removed the `profiles.is_admin` branch from the 19
 *   `*_tenant_isolation` policies. It left twenty-seven other pharmacy policies
 *   defaulting to PUBLIC, four policies still resolving tenancy through an
 *   inline `profiles` subquery, two row-secured tables with no policy at all,
 *   and an anonymous SELECT over the invitation table.
 *
 *   20261102130000 rewrote every one of them to ask
 *   `public.pharmacy_caller_tenants()`, which is the only place that knows a
 *   person can work at more than one pharmacy and can be deactivated at one of
 *   them.
 *
 *   20261102130100 stopped the JWT subject from rewriting its own `role` on
 *   `profiles`, which would otherwise pass every `is_platform_admin()` bypass.
 *
 * The behavioural proof is apps/pharmacy/lib/pharmacy-rls-tenant-isolation.integration.test.ts,
 * which runs only against a disposable database. A skip there is not evidence,
 * and nothing in this file claims otherwise.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const SNAPSHOT = "supabase/bootstrap/canonical_public_schema.sql"
const SCOPE_MIGRATION = "supabase/migrations/20261102120000_pharmacy_policy_tenant_scope.sql"
const HARDENING = "supabase/migrations/20261102130000_pharmacy_tenant_access_hardening.sql"
const PROFILE_GUARD = "supabase/migrations/20261102130100_profiles_privileged_column_guard.sql"
const MIGRATIONS_DIR = "supabase/migrations"

const read = (path) => readFileSync(join(root, path), "utf8")
const snapshot = read(SNAPSHOT)
const scopeMigration = read(SCOPE_MIGRATION)
const hardening = read(HARDENING)
const profileGuard = read(PROFILE_GUARD)

const SCOPED_POLICIES = [
  "pharmacy_audit_logs_tenant_isolation",
  "pharmacy_clients_tenant_isolation",
  "pharmacy_customers_tenant_isolation",
  "pharmacy_inquiries_tenant_isolation",
  "pharmacy_order_items_tenant_isolation",
  "pharmacy_orders_tenant_isolation",
  "pharmacy_product_batches_tenant_isolation",
  "pharmacy_product_packages_tenant_isolation",
  "pharmacy_products_tenant_isolation",
  "pharmacy_purchase_order_items_tenant_isolation",
  "pharmacy_purchase_orders_tenant_isolation",
  "pharmacy_settings_tenant_isolation",
  "pharmacy_stock_adjustments_tenant_isolation",
  "pharmacy_suppliers_tenant_isolation",
  "pharmacy_transaction_edits_tenant_isolation",
  "pharmacy_transaction_items_tenant_isolation",
  "pharmacy_transactions_tenant_isolation",
  "pharmacy_user_settings_tenant_isolation",
  "pharmacy_notifications_own_or_admin",
]

// ---------------------------------------------------------------------------
// A small policy reader. The previous one only understood `CREATE POLICY`, so
// an `ALTER POLICY` — the shape both repair migrations use — was invisible to
// it and every "effective definition" assertion silently read the snapshot.
// ---------------------------------------------------------------------------

function balancedInner(text, openIdx) {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i]
    if (c === "(") depth += 1
    else if (c === ")") {
      depth -= 1
      if (depth === 0) return text.slice(openIdx + 1, i)
    }
  }
  return null
}

function statementEnd(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (c === "(") depth += 1
    else if (c === ")") depth -= 1
    else if (c === ";" && depth === 0) return i
  }
  return text.length
}

// A keyword is only a clause keyword at paren depth zero, so `USING` inside a
// subquery cannot be mistaken for the policy's own USING.
function findKeyword(text, sticky) {
  let depth = 0
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (c === "(") depth += 1
    else if (c === ")") depth -= 1
    else if (depth === 0) {
      sticky.lastIndex = i
      const m = sticky.exec(text)
      if (m) return { index: i, length: m[0].length }
    }
  }
  return null
}

function parsePolicyBody(body) {
  const parsed = {}
  const to = findKeyword(body, /\bTO\b/iy)
  const using = findKeyword(body, /\bUSING\b/iy)
  const withCheck = findKeyword(body, /\bWITH\s+CHECK\b/iy)

  if (to) {
    const stops = [using?.index, withCheck?.index].filter((n) => n !== undefined)
    const end = stops.length ? Math.min(...stops) : body.length
    parsed.roles = body
      .slice(to.index + to.length, end)
      .split(",")
      .map((role) => role.trim().replace(/^"|"$/g, "").toLowerCase())
      .filter(Boolean)
  }
  if (using) {
    const inner = balancedInner(body, body.indexOf("(", using.index))
    if (inner !== null) parsed.qual = inner.replace(/\s+/g, " ").trim()
  }
  if (withCheck) {
    const inner = balancedInner(body, body.indexOf("(", withCheck.index))
    if (inner !== null) parsed.withCheck = inner.replace(/\s+/g, " ").trim()
  }
  return parsed
}

/**
 * The repair migrations alter policies inside a `do $$ ... $$` loop, building
 * the statement with format(). The reader cannot execute that, so it expands
 * the same arrays the migration does and applies the same predicate.
 */
function expandAlterLoop(sql) {
  const predicate = /v_predicate constant text :=\s*'([^']*)'/i.exec(sql)
  const loopShape = /alter policy %I on public\.%I to authenticated using \(%s\) with check \(%s\)/i
  if (!predicate || !loopShape.test(sql)) return []

  const arrayOf = (name) => {
    const m = new RegExp(`${name}\\s+text\\[\\]\\s*:=\\s*array\\[([\\s\\S]*?)\\]`, "i").exec(sql)
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  }

  const policies = arrayOf("v_policies")
  const tables = arrayOf("v_tables")
  const extras = arrayOf("v_extra_tables")

  assert.equal(
    policies.length,
    tables.length,
    "the repair migration's policy and table arrays must line up, or the loop alters the wrong pair",
  )

  const ops = policies.map((name, i) => ({
    kind: "alter",
    name,
    table: tables[i],
    roles: ["authenticated"],
    qual: predicate[1],
    withCheck: predicate[1],
  }))
  for (const table of extras) {
    ops.push({
      kind: "alter",
      name: "tenant_isolation",
      table,
      roles: ["authenticated"],
      qual: predicate[1],
      withCheck: predicate[1],
    })
  }
  return ops
}

function operationsIn(sql) {
  const ops = []
  const read = (m, kind, table) => {
    const end = statementEnd(sql, m.index + m[0].length)
    const body = sql.slice(m.index + m[0].length, end)
    ops.push({ offset: m.index, kind, name: m[1], table, ...parsePolicyBody(body) })
  }
  // A policy name is unique per table, not per schema, and these migrations
  // write both `"public"."t"` (the snapshot's dump format) and `public.t`.
  for (const m of sql.matchAll(/CREATE POLICY "([^"]+)"\s*ON (?:"public"|public)\.(?:"([^"]+)"|(\w+))/gi)) {
    read(m, "define", m[2] ?? m[3])
  }
  for (const m of sql.matchAll(/ALTER POLICY "([^"]+)"\s*ON (?:"public"|public)\.(?:"([^"]+)"|(\w+))/gi)) {
    read(m, "alter", m[2] ?? m[3])
  }
  for (const m of sql.matchAll(
    /DROP POLICY (?:IF EXISTS )?"([^"]+)"\s*ON (?:"public"|public)\.(?:"([^"]+)"|(\w+))/gi,
  )) {
    ops.push({ offset: m.index, kind: "drop", name: m[1], table: m[2] ?? m[3] })
  }
  for (const op of expandAlterLoop(sql)) ops.push({ offset: Number.MAX_SAFE_INTEGER, ...op })
  return ops.sort((a, b) => a.offset - b.offset)
}

const policyKey = (table, name) => `${table}.${name}`

/** Replays the snapshot and then every migration in filename order. */
function effectivePolicies() {
  const state = new Map()
  const files = [
    { source: SNAPSHOT, sql: snapshot },
    ...readdirSync(join(root, MIGRATIONS_DIR))
      .filter((file) => file.endsWith(".sql"))
      .sort()
      .map((file) => ({ source: `${MIGRATIONS_DIR}/${file}`, sql: read(`${MIGRATIONS_DIR}/${file}`) })),
  ]

  for (const { source, sql } of files) {
    for (const op of operationsIn(sql)) {
      const key = policyKey(op.table, op.name)
      if (op.kind === "drop") {
        state.delete(key)
        continue
      }
      const previous = state.get(key) ?? {}
      // CREATE resets a policy; ALTER only replaces the clauses it names.
      const next =
        op.kind === "define"
          ? { ...op, roles: op.roles ?? ["public"], source }
          : { ...previous, ...op, table: previous.table ?? op.table, source }
      state.set(key, next)
    }
  }
  return state
}

const effective = effectivePolicies()
const pharmacyPolicies = [...effective.values()].filter((p) => p.table?.startsWith("pharmacy_"))

// ---------------------------------------------------------------------------
// Snapshot state, as PR-011 left it.
// ---------------------------------------------------------------------------

test("the snapshot gives every pharmacy policy a tenant predicate", () => {
  const unscoped = []
  for (const match of snapshot.matchAll(
    /CREATE POLICY "([^"]+)" ON "public"\."(pharmacy_[^"]+)"(.*?);/gs,
  )) {
    if (/\bis_admin\b/.test(match[3])) unscoped.push(`${match[2]}.${match[1]}`)
  }
  assert.deepEqual(
    unscoped,
    [],
    `a pharmacy policy still tests profiles.is_admin, which is a tenant administrator flag, not the platform administrator flag: ${unscoped.join(", ")}`,
  )
})

test("PR-011 scoped its nineteen policies to current_tenant_id", () => {
  const statements = new Map()
  for (const op of operationsIn(snapshot)) {
    if (op.kind === "define") statements.set(op.name, op)
  }
  for (const name of SCOPED_POLICIES) {
    const policy = statements.get(name)
    assert.notEqual(policy, undefined, `${name} is missing from the snapshot`)
    assert.deepEqual(policy.roles, ["authenticated"], `${name} must not be reachable by anon`)
    assert.match(policy.qual ?? "", /current_tenant_id/, `${name} must scope to the caller's tenant`)
    assert.match(policy.qual ?? "", /is_platform_admin/, `${name} must keep platform reach explicit`)
    assert.match(policy.withCheck ?? "", /current_tenant_id/, `${name} must constrain writes`)
  }
})

test("the PR-011 migration touches every policy it claims to", () => {
  for (const name of SCOPED_POLICIES) {
    assert.ok(
      scopeMigration.includes(`'${name}'`),
      `${name} must be in the repair migration's policy list, or a database upgraded rather than rebuilt keeps the bypass`,
    )
  }
  assert.match(scopeMigration, /alter policy %I on public\.%I to authenticated/i)
  assert.match(
    scopeMigration,
    /using \(tenant_id = public\.current_tenant_id\(\) or public\.is_platform_admin\(\)\)/i,
  )
  assert.match(
    scopeMigration,
    /with check \(tenant_id = public\.current_tenant_id\(\) or public\.is_platform_admin\(\)\)/i,
  )
})

// ---------------------------------------------------------------------------
// Effective state after every migration has been replayed.
// ---------------------------------------------------------------------------

test("every pharmacy policy is reachable only by authenticated callers", () => {
  const open = pharmacyPolicies
    .filter((p) => !(p.roles?.length === 1 && p.roles[0] === "authenticated"))
    .map((p) => `${p.table}.${p.name} -> ${JSON.stringify(p.roles)}`)
  assert.deepEqual(
    open,
    [],
    `a policy without TO defaults to PUBLIC, which includes anon: ${open.join(", ")}`,
  )
})

test("no pharmacy policy resolves identity through a predicate of its own", () => {
  const stray = pharmacyPolicies
    .filter((p) => {
      const text = `${p.qual ?? ""} ${p.withCheck ?? ""}`
      return /\bis_admin\b|\bsame_tenant\b|current_tenant_id|'platform_admin'/.test(text)
    })
    .map((p) => `${p.table}.${p.name}`)
  assert.deepEqual(
    stray,
    [],
    `each of these answers "which tenant" somewhere other than pharmacy_caller_tenants(), so it cannot see a second pharmacy or withdraw a deactivated one: ${stray.join(", ")}`,
  )
})

test("every pharmacy policy answers membership or platform reach through a helper", () => {
  const withoutTenant = pharmacyPolicies
    .filter(
      (p) =>
        !/pharmacy_caller_tenants|is_platform_admin/.test(`${p.qual ?? ""} ${p.withCheck ?? ""}`),
    )
    .map((p) => `${p.table}.${p.name}`)
  assert.deepEqual(
    withoutTenant,
    [],
    `these policies have no membership predicate at all: ${withoutTenant.join(", ")}`,
  )
})

test("the snapshot's forty-eight pharmacy policies are all still policed", () => {
  const declared = new Set(
    [...snapshot.matchAll(/CREATE POLICY "([^"]+)" ON "public"\."(pharmacy_[^"]+)"/g)].map(
      (m) => `${m[2]}.${m[1]}`,
    ),
  )
  const alive = new Set(pharmacyPolicies.map((p) => `${p.table}.${p.name}`))
  const dropped = [...declared].filter((pair) => !alive.has(pair))
  assert.deepEqual(
    dropped,
    ["pharmacy_onboarding.public_invite_lookup"],
    `only the anonymous invitation lookup may be dropped; these lost their policy instead: ${dropped.join(", ")}`,
  )
})

// ---------------------------------------------------------------------------
// pharmacy_caller_tenants() — the single source of membership.
// ---------------------------------------------------------------------------

test("pharmacy_caller_tenants() is security definer and not callable by anon", () => {
  assert.match(
    hardening,
    /create or replace function public\.pharmacy_caller_tenants\(\)[\s\S]*?security definer/i,
    "a policy helper reads row-secured tables, so it must run as its owner",
  )
  assert.match(
    hardening,
    /revoke all on function public\.pharmacy_caller_tenants\(\) from public/i,
    "PUBLIC execute would let anon call it through PostgREST",
  )
  assert.match(
    hardening,
    /grant execute on function public\.pharmacy_caller_tenants\(\) to authenticated/i,
  )
  assert.match(
    hardening,
    /grant execute on function public\.pharmacy_caller_tenants\(\) to service_role/i,
  )
})

test("membership covers every place a pharmacy role is recorded", () => {
  const fn = /create or replace function public\.pharmacy_caller_tenants\(\)[\s\S]*?\$function\$;/.exec(
    hardening,
  )
  assert.notEqual(fn, null, "pharmacy_caller_tenants() is missing from the hardening migration")
  assert.match(fn[0], /pharmacy_user_settings/, "a pharmacy staff row decides pharmacy access")
  assert.match(fn[0], /staff_scope_assignments/, "the canonical multi-facility model must count")
  assert.match(fn[0], /pharmacy_stores/, "a site-scoped assignment names its tenant through the store")
  assert.match(fn[0], /is_active is false|is_active = false/, "an inactive staff row must withdraw access")
  assert.match(fn[0], /coalesce\(p?\.?is_deleted, false\) = false/, "a deleted profile is not a member")
  assert.match(fn[0], /auth\.uid\(\)/, "membership is the caller's, resolved from the request JWT")
})

// ---------------------------------------------------------------------------
// Account standing.
// ---------------------------------------------------------------------------

test("deleted accounts are excluded wherever a pharmacy decision is made", () => {
  for (const [fn, pattern] of [
    ["public.current_tenant_id()", /create or replace function public\.current_tenant_id\(\)[\s\S]*?\$\$;/],
    ["public.is_platform_admin()", /create or replace function public\.is_platform_admin\(\)[\s\S]*?\$\$;/],
    ["public.custom_access_token_hook", /create or replace function public\.custom_access_token_hook\([\s\S]*?\$\$;/],
    ["public.pharmacy_assert_actor", /create or replace function public\.pharmacy_assert_actor\([\s\S]*?\$function\$;/],
  ]) {
    const body = pattern.exec(hardening)
    assert.notEqual(body, null, `${fn} is not hardened by the migration`)
    assert.match(body[0], /is_deleted/, `${fn} must not honour an archived profile`)
  }
})

test("a deactivated pharmacy staff row outranks the home tenant pointer", () => {
  const body = /create or replace function public\.pharmacy_assert_actor\([\s\S]*?\$function\$;/.exec(hardening)
  assert.notEqual(body, null)
  assert.match(
    body[0],
    /is deactivated for this pharmacy/,
    "the staff row must be read first, or a deactivated pharmacist passes on profiles.tenant_id alone",
  )
})

test("an anonymous caller cannot read the invitation table", () => {
  assert.match(
    hardening,
    /drop policy if exists "public_invite_lookup" on public\.pharmacy_onboarding/i,
  )
  assert.match(hardening, /revoke all on table public\.pharmacy_onboarding from anon/i)
})

test("the two row-secured tables without a policy are given one", () => {
  for (const table of ["pharmacy_receipt_reprints", "pharmacy_sale_idempotency"]) {
    const policy = pharmacyPolicies.find((p) => p.table === table)
    assert.notEqual(policy, undefined, `${table} has row security and no policy, so every read is denied incorrectly labelled`)
    assert.match(policy.qual ?? "", /pharmacy_caller_tenants/, `${table} must be tenant-scoped`)
  }
})

test("the hardening migration fails closed", () => {
  assert.match(hardening, /raise exception 'expected pharmacy policies are missing: %/i)
  assert.match(hardening, /raise exception 'pharmacy policies still reachable by anon or PUBLIC: %/i)
  assert.match(hardening, /raise exception 'pharmacy policies still use a non-tenant predicate: %/i)
  assert.match(hardening, /has_function_privilege\('anon', 'public\.pharmacy_caller_tenants\(\)', 'execute'\)/i)
})

// ---------------------------------------------------------------------------
// profiles — the columns that decide everything above.
// ---------------------------------------------------------------------------

test("a JWT subject cannot rewrite its own role or standing", () => {
  assert.match(profileGuard, /create trigger "profiles_guard_privileged_columns"/i)
  assert.match(profileGuard, /before insert or update on public\.profiles/i)
  for (const column of [
    "role",
    "is_admin",
    "platform_control_role",
    "tenant_id",
    "is_deleted",
  ]) {
    assert.match(
      profileGuard,
      new RegExp(`new\\.${column}\\b`),
      `${column} decides authorization elsewhere, so the guard must cover it`,
    )
  }
  assert.match(
    profileGuard,
    /if auth\.uid\(\) is null then\s*return new;/i,
    "the service role carries no user JWT and must keep writing profiles",
  )
  assert.match(
    profileGuard,
    /if public\.is_platform_admin\(\) then\s*return new;/i,
    "a platform administrator must keep appointing and suspending accounts",
  )
})
