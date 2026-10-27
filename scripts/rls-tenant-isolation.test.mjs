import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * SEC-01 pin: ten `tenant_isolation` policies reduce to `tenant_id = tenant_id`
 * because the policy's subquery selects the row's own column from profiles.
 *
 * These tests read the canonical schema snapshot (the artefact that currently
 * encodes the defect) and the prepared repair migration. They are static
 * evidence only: they prove the migration targets the right ten policies with a
 * non-tautological predicate. They do NOT prove the repair works on production —
 * that requires scripts/db-tests/run-rls-isolation.sh against a disposable
 * database, which passed on a disposable PostgreSQL 16 database on 2026-10-25;
 * production remains unverified.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const snapshot = readFileSync(join(root, "supabase/bootstrap/canonical_public_schema.sql"), "utf8")
const repair = readFileSync(
  join(root, "supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql"),
  "utf8",
)

const KNOWN_TAUTOLOGIES = [
  "encounter_orders",
  "encounters",
  "gas_cylinders",
  "hospital_drug_orders",
  "order_items",
  "products",
  "sync_conflicts",
  "telemedicine_intake_cases",
  "telemedicine_intake_messages",
  "vitals",
].sort()

/** Every `tenant_isolation` policy in the snapshot, keyed by table. */
function snapshotTenantIsolationPolicies(sql) {
  const policies = new Map()
  const pattern =
    /CREATE POLICY "tenant_isolation" ON "public"\."([a-zA-Z0-9_]+)"([\s\S]*?);/g
  let match
  while ((match = pattern.exec(sql))) {
    policies.set(match[1], match[2])
  }
  return policies
}

/** The defect shape: `tenant_id = ( SELECT <own table>.tenant_id FROM profiles ...)`. */
function isSelfReferential(table, bodys) {
  const qualifiedColumn = new RegExp(`SELECT\\s+"${table}"\\."tenant_id"`, "i")
  return qualifiedColumn.test(bodys) && /FROM\s+"public"\."profiles"/i.test(bodys)
}

test("the snapshot's self-referential tenant_isolation policies are exactly the known ten", () => {
  const policies = snapshotTenantIsolationPolicies(snapshot)
  const broken = [...policies.entries()]
    .filter(([table, body]) => isSelfReferential(table, body))
    .map(([table]) => table)
    .sort()

  assert.deepEqual(broken, KNOWN_TAUTOLOGIES)
})

test("no tenant_isolation policy reaches `tenant_id = tenant_id` literally", () => {
  for (const [table, body] of snapshotTenantIsolationPolicies(snapshot)) {
    assert.doesNotMatch(
      body.replace(/\s+/g, " "),
      /tenant_id"?\s*=\s*"?tenant_id"?\s*\)/i,
      `${table} has a literal self-comparison`,
    )
  }
})

test("the repair migration names exactly the ten affected tables", () => {
  const listMatch = repair.match(/v_tables\s+text\[\]\s*:=\s*array\[([\s\S]*?)\]/i)
  assert.ok(listMatch, "repair migration must declare the table array")
  const tables = [...listMatch[1].matchAll(/'([a-zA-Z0-9_]+)'/g)].map((m) => m[1]).sort()
  assert.deepEqual(tables, KNOWN_TAUTOLOGIES)
})

test("the repair replaces the tautology with the tenant-scoped helper on both read and write", () => {
  const code = repair.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")
  assert.match(code, /alter policy "tenant_isolation" on public\.%I/i)
  assert.match(code, /using \(tenant_id = public\.current_tenant_id\(\)\)/)
  assert.match(code, /with check \(tenant_id = public\.current_tenant_id\(\)\)/)
  // The predicate may not name the row's own table anywhere in executable SQL.
  assert.doesNotMatch(code, /%I["']?\."tenant_id"/i)
})

test("the repair scopes the policy to authenticated, never to PUBLIC or anon", () => {
  // The predicate calls public.current_tenant_id(), which `anon` deliberately
  // cannot EXECUTE (20260613104742_lock_down_auth_rls_helpers_anon_execute.sql).
  // A policy left at the implicit PUBLIC default would raise
  // `permission denied for function current_tenant_id()` for anonymous readers of
  // `products` instead of denying cleanly, so the role clause is part of the fix.
  const code = repair.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")
  assert.match(code, /alter policy "tenant_isolation" on public\.%I to authenticated/i)
  assert.match(code, /raise exception 'tenant_isolation on public\.% still applies to/i)
  assert.match(code, /not \('authenticated' = any \(r\.roles\)\)/i)
  // The wrong fix: granting anon EXECUTE to make a PUBLIC policy evaluable.
  assert.doesNotMatch(code, /grant\s+execute[\s\S]{0,80}\bto\s+(anon|public)\b/i)
})

test("the repair alters existing policies and never creates one", () => {
  const statements = repair
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .toLowerCase()
  assert.doesNotMatch(statements, /drop\s+policy\s+"tenant_isolation"/)
  // Fail closed instead of inventing: a missing expected policy aborts the
  // migration, so there is no CREATE branch left to get wrong.
  assert.doesNotMatch(statements, /create\s+policy/)
  assert.match(repair, /raise exception 'tenant_isolation is absent on public\.%/)
  assert.match(repair, /array_to_string\(v_missing/)
})

test("the repair refuses to finish if a self-referential predicate survives", () => {
  assert.match(repair, /raise exception 'tenant_isolation on public\.% is still self-referential/i)
  assert.match(repair, /raise exception 'tenant_isolation on public\.% has no WITH CHECK/i)
})

test("the self-check requires the repaired predicate and check to call current_tenant_id", () => {
  // A negative check alone would accept `USING (true)`: it does not mention the
  // table's own column and it has a WITH CHECK. Requiring the helper is what
  // makes the check actually verify the repair.
  const code = repair.replace(/--[^\n]*/g, "").replace(/\s+/g, " ")
  assert.match(code, /position\('current_tenant_id' in r\.qual\) = 0/)
  assert.match(code, /position\('current_tenant_id' in r\.with_check\) = 0/)
  assert.match(code, /raise exception 'tenant_isolation on public\.% does not reference public\.current_tenant_id\(\)/i)
})

test("the alterations and the self-check are one statement, so a failure rolls them back", () => {
  const code = repair.replace(/--[^\n]*/g, "")
  assert.equal(
    [...code.matchAll(/^\s*do\s+\$\$/gim)].length,
    1,
    "the repair must be a single DO block, which is atomic under every applier",
  )
  // Explicit transaction control would end early the transaction that
  // the Supabase CLI already wraps around each migration file.
  assert.doesNotMatch(code, /^\s*(begin|commit|rollback)\s*;/im)
})

test("the snapshot's public-read policies are dropped by a later migration in the chain", () => {
  // Keeps the two states apart: the snapshot (which every fresh environment is
  // built from) still carries these USING (true) policies, and a migration at
  // or after the security cutoff removes them. Saying "products is public"
  // without naming the state would be wrong in one direction or the other.
  const guard = readFileSync(
    join(root, "supabase/migrations/20261003160000_profiles_privileged_columns_guard.sql"),
    "utf8",
  )
  for (const policy of ["Public read products", "queue_read_by_token", "Public read restaurants"]) {
    assert.match(
      guard,
      new RegExp(`drop policy if exists "${policy}"`, "i"),
      `${policy} must be dropped by the guard migration`,
    )
    assert.match(snapshot, new RegExp(`CREATE POLICY "${policy}"`), `${policy} must still be in the snapshot`)
  }

  // And the harness must not present the snapshot state as the current one.
  const sql = readFileSync(join(root, "scripts/db-tests/rls-tenant-isolation.sql"), "utf8")
  assert.match(sql, /20261003160000_profiles_privileged_columns_guard\.sql drops it/)
  assert.match(sql, /is UNVERIFIED here/)
})

test("the harness expects a clean anon denial before the repair, not a function-permission error", () => {
  const sql = readFileSync(join(root, "scripts/db-tests/rls-tenant-isolation.sql"), "utf8")
  const revokeAt = sql.indexOf("revoke all on function public.current_tenant_id() from anon;")
  const applyAt = sql.indexOf("\\i supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql")
  assert.ok(revokeAt > 0, "harness must mirror the anon EXECUTE revoke")
  assert.ok(applyAt > 0, "harness must apply the tracked migration itself")
  assert.ok(revokeAt < applyAt, "the revoke must precede the repair")
  // The original policies inline the profile subquery, so anon gets zero rows
  // rather than a 42501. Expecting the function error before the repair would
  // encode a state that never existed and fail the harness for the wrong reason.
  assert.match(sql, /clean zero-row denial on nine tables/)
  assert.doesNotMatch(
    sql,
    /anon read encounters without error/,
    "the pre-repair anon assertion must expect a denial, not an error",
  )
  // Guard against running on a database that already has the app schema.
  assert.match(sql, /refusing to run: public\.profiles already exists/)
  // The residual SEC-02 exposure must be asserted, not assumed away.
  assert.match(sql, /v_expected := 2/)
  assert.match(sql, /Public read products/)
})

test("every anon block clears the JWT subject, because SET ROLE does not reset it", () => {
  // auth.uid() reads request.jwt.claim.sub, a session-scoped custom setting.
  // `SET ROLE anon` leaves it set, so a block that only switches role runs as
  // whichever user the previous step authenticated as. That produced a real
  // false failure at step 5b on PostgreSQL 16: "anon" still resolved to tenant A,
  // the tautology matched, and the harness reported a defect that was its own.
  const sql = readFileSync(join(root, "scripts/db-tests/rls-tenant-isolation.sql"), "utf8")
  const blocks = [...sql.matchAll(/set role anon;/g)]
  assert.ok(blocks.length >= 2, "the harness must exercise anon more than once")
  for (const m of blocks) {
    const after = sql.slice(m.index, m.index + 200)
    assert.match(
      after,
      /set_config\('request\.jwt\.claim\.sub', '', false\)/,
      "an anon block must clear request.jwt.claim.sub before asserting",
    )
  }
})

test("the harness demonstrates the admin and staff-role bypasses it does not fix", () => {
  const sql = readFileSync(join(root, "scripts/db-tests/rls-tenant-isolation.sql"), "utf8")
  // The fixture must model the policies, not merely mention them.
  assert.match(sql, /create policy "Admins full access items"/)
  assert.match(sql, /create policy "telemedicine_intake_cases_user_read"/)
  assert.match(sql, /create policy "telemedicine_intake_messages_user_read"/)
  // profiles.is_admin has to exist for those policies to be evaluable at all.
  assert.match(sql, /is_admin boolean not null default false/)
  // And each bypass must be asserted, not narrated.
  assert.match(sql, /admin bypass reproduced/)
  assert.match(sql, /staff-role bypass reproduced/)
  // The patient-initiated write is the one the migration header singles out:
  // user_insert has no tenant clause, so the repair cannot constrain it.
  assert.match(sql, /patient intake write is unconstrained/)
})

test("the harness SQL is structurally intact", () => {
  const sql = readFileSync(join(root, "scripts/db-tests/rls-tenant-isolation.sql"), "utf8")
  const fences = [...sql.matchAll(/\$\$/g)].length
  assert.equal(fences % 2, 0, "unbalanced $$ block fences")
  assert.equal(
    [...sql.matchAll(/\$\$;/g)].length,
    fences / 2,
    "every $$ block must be terminated by `$$;`",
  )
  assert.match(sql, /\\set ON_ERROR_STOP on/)
})

test("the runner cannot silently test the wrong server", () => {
  const runner = readFileSync(join(root, "scripts/db-tests/run-rls-isolation.sh"), "utf8")
  assert.match(runner, /export PGHOST=127\.0\.0\.1/)
  assert.match(runner, /unset DATABASE_URL/)
  assert.match(runner, /CANNOT PROVE: docker published no port/)
  assert.match(runner, /CANNOT PROVE: disposable PostgreSQL did not become ready/)
  assert.match(runner, /SYNAPSE_ALLOW_IMAGE_PULL/)
  // Readiness must be an explicit assertion, not a loop that can fall through.
  assert.match(runner, /if \[ "\$ready" != true \]/)
})

test("the disposable-DB harness fails closed when it cannot run", () => {
  // PATH without docker: the runner must say the proof did not run, not exit 0.
  // Absolute interpreter path: the child gets a PATH without docker on purpose.
  const result = spawnSync("/bin/bash", ["scripts/db-tests/run-rls-isolation.sh"], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: "/nonexistent", HOME: process.env.HOME ?? "" },
  })
  assert.notEqual(result.status, 0, "an unprovable run must not report success")
  assert.match(result.stderr, /CANNOT PROVE/)
})

test("no workflow applies the repair to a remote or production database", () => {
  const read = (name) => readFileSync(join(root, ".github/workflows", name), "utf8")

  // Reaching production needs a manual dispatch, an explicit PRODUCTION
  // confirmation, a RECONCILED attestation and a pinned 40-char SHA, and the
  // apply job only runs when both booleans are set that way.
  const dbProd = read("db-production.yml")
  assert.match(dbProd, /workflow_dispatch:/)
  assert.doesNotMatch(dbProd, /^\s{2}(push|pull_request):/m, "db-production.yml must not trigger on push")
  assert.match(dbProd, /CONFIRMATION" != "PRODUCTION"/)
  assert.match(dbProd, /RECONCILIATION_CONFIRMATION" != "RECONCILED"/)
  assert.match(dbProd, /\^\[0-9a-f\]\{40\}\$/)

  // deploy.yml DOES apply post-snapshot migrations automatically — but only to
  // the disposable stack it starts on the runner. Claiming otherwise would be a
  // false statement about a security control.
  const deploy = read("deploy.yml")
  assert.match(deploy, /psql -h 127\.0\.0\.1 -p 54322/)
  assert.doesNotMatch(deploy, /supabase\s+db\s+push/)
  assert.doesNotMatch(deploy, /--linked/)
  assert.doesNotMatch(deploy, /SUPABASE_DB_URL/)
})

test("the intake-ownership and admin-policy migrations are each a single atomic DO block", () => {
  for (const name of [
    "20261026120000_telemedicine_intake_tenant_ownership.sql",
    "20261026130000_scope_admin_policies_to_tenant.sql",
  ]) {
    const code = readFileSync(join(root, "supabase/migrations", name), "utf8")
    assert.equal(
      [...code.matchAll(/^\s*do\s+\$\$/gim)].length,
      1,
      `${name} must be a single DO block (atomic under every applier)`,
    )
    assert.doesNotMatch(
      code,
      /^\s*(begin|commit|rollback)\s*;/im,
      `${name} must not use top-level transaction control`,
    )
  }
})

test("the admin-policy migration scopes every policy to authenticated and current_tenant_id in both clauses", () => {
  const code = readFileSync(
    join(root, "supabase/migrations/20261026130000_scope_admin_policies_to_tenant.sql"),
    "utf8",
  )
  // The ALTER is emitted once through a format() template applied to five tables.
  assert.match(code, /to authenticated/)
  assert.match(code, /using \(tenant_id = public\.current_tenant_id\(\)/)
  assert.match(code, /with check \(tenant_id = public\.current_tenant_id\(\)/)
  assert.match(code, /p\.id = auth\.uid\(\) and p\.is_admin/)
  assert.match(code, /platform_admin_bypass/)
})

test("the staff-policy migration is HELD, lives outside the applied chain, and keeps ALTER inside its DO block", () => {
  // It must NOT sit in supabase/migrations: deploy.yml applies every
  // supabase/migrations/[0-9]*_*.sql above the snapshot cutoff on push to main,
  // and the Supabase CLI applies the whole directory — a HELD file there is
  // documentation, not a control.
  assert.ok(
    existsSync(join(root, "supabase/held/scope_staff_intake_policies_to_tenant.sql")),
    "held staff-policy migration must exist under supabase/held",
  )
  assert.ok(
    !existsSync(join(root, "supabase/migrations/20261026140000_scope_staff_intake_policies_to_tenant.sql")),
    "held staff-policy migration must not sit in supabase/migrations (it would be auto-applied)",
  )

  const code = readFileSync(
    join(root, "supabase/held/scope_staff_intake_policies_to_tenant.sql"),
    "utf8",
  )
  assert.match(code, /HELD — DO NOT APPLY WITHOUT OWNER SIGN-OFF/)
  assert.match(code, /raise exception 'expected staff intake policies are missing/)
  const doStart = code.indexOf("do $$")
  const doEnd = code.indexOf("$$;", doStart)
  assert.ok(doStart > 0 && doEnd > doStart, "staff migration must be a DO block")
  for (const m of code.matchAll(/alter policy/gi)) {
    assert.ok(
      m.index > doStart && m.index < doEnd,
      "alter policy must be inside the DO block",
    )
  }
})

test("the nulls preflight is read-only and counts NULL tenants", () => {
  const code = readFileSync(join(root, "scripts/db-tests/nulls-preflight.sql"), "utf8")
  const stripped = code
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .toLowerCase()
  for (const verb of ["insert", "update", "delete", "alter", "drop", "create", "truncate"]) {
    assert.doesNotMatch(stripped, new RegExp(`\\b${verb}\\b`), `preflight must not contain ${verb}`)
  }
  assert.match(code, /count\(\*\) filter \(where tenant_id is null\)/)
})
