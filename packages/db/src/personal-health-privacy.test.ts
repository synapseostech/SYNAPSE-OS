import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Contract for owner-private personal health (wearables). A facility admin must
 * never reach a staff member's readings, so these tables carry no tenant column
 * and every policy is owner = (select auth.uid()). This runs on every CI build; the
 * engine-level proof is scripts/db-tests/personal-health-rls.pglite.mjs.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")
const migrationsDir = join(root, "supabase/migrations")
const TABLES = ["personal_wearable_connections", "personal_wearable_daily"]

const all = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }))

function statementsFor(table: string) {
  return all.flatMap(({ name, sql }) =>
    sql
      .split(";")
      .filter((stmt) => new RegExp(`\\bpublic\\.${table}\\b`, "i").test(stmt))
      .map((stmt) => ({ name, stmt: stmt.replace(/--.*$/gm, "").trim() })),
  )
}

describe("personal health tables stay owner-private", () => {
  for (const table of TABLES) {
    const statements = statementsFor(table)

    it(`${table}: has no tenant column`, () => {
      const create = statements.find(({ stmt }) => /create table/i.test(stmt))
      assert.ok(create, `${table} create statement`)
      assert.doesNotMatch(create.stmt, /tenant/i, `${table} must not carry a tenant column`)
      for (const { name, stmt } of statements) {
        assert.doesNotMatch(stmt, /add\s+column[^;]*tenant/i, `${name} adds a tenant column to ${table}`)
      }
    })

    it(`${table}: RLS enabled and forced`, () => {
      assert.ok(statements.some(({ stmt }) => /enable row level security/i.test(stmt)))
      assert.ok(statements.some(({ stmt }) => /force row level security/i.test(stmt)))
    })

    it(`${table}: anon and PUBLIC hold nothing`, () => {
      assert.ok(statements.some(({ stmt }) => /revoke all on table[^;]*from anon/i.test(stmt)))
      assert.ok(statements.some(({ stmt }) => /revoke all on table[^;]*from public/i.test(stmt)))
      for (const { name, stmt } of statements) {
        assert.doesNotMatch(stmt, /grant[^;]*to\s+(anon|public)\b/i, `${name} grants ${table} to anon/public`)
      }
    })

    it(`${table}: every policy is owner-only`, () => {
      const policies = statements.filter(({ stmt }) => /create policy/i.test(stmt))
      assert.ok(policies.length > 0, `${table} has a policy`)
      for (const { name, stmt } of policies) {
        assert.match(stmt, /to authenticated/i, `${name}: policy must target authenticated only`)
        assert.match(stmt, /owner_profile_id = \(select auth\.uid\(\)\)/i, `${name}: policy must be owner = (select auth.uid())`)
        assert.doesNotMatch(
          stmt,
          /tenant|is_admin|role|current_setting|is_platform|security definer/i,
          `${name}: policy on ${table} must not widen access by tenant, role or admin`,
        )
      }
    })
  }

  it("readings cascade away when consent is withdrawn", () => {
    const daily = statementsFor("personal_wearable_daily").find(({ stmt }) => /create table/i.test(stmt))
    assert.match(
      daily?.stmt ?? "",
      /references public\.personal_wearable_connections\(owner_profile_id, provider\)\s+on delete cascade/i,
    )
  })

  it("introduces no SECURITY DEFINER function over personal health", () => {
    for (const { name, sql } of all) {
      if (!TABLES.some((t) => sql.includes(t))) continue
      assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /security\s+definer/i, `${name} adds a definer function near personal health`)
    }
  })
})
