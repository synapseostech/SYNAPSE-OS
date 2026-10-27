import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { analyseSources, dynamicRlsEnabled, stripComments } from "./check-security-gates.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function migration(source, name = "20261099120000_synthetic.sql") {
  return { name, source }
}

function rulesFor(source) {
  return analyseSources([migration(source)]).map((failure) => failure.rule)
}

// --- RLS detection -------------------------------------------------------

test("a table with a literal enable statement passes", () => {
  const sql = `
    create table public.widgets (id uuid primary key);
    alter table public.widgets enable row level security;
  `
  assert.deepEqual(rulesFor(sql), [])
})

test("a table enabled inside a table-array DO block passes", () => {
  const sql = `
    create table if not exists public.widgets (id uuid primary key);
    do $$
    declare v_table text;
    begin
      foreach v_table in array array['widgets', 'gadgets'] loop
        execute format('alter table public.%I enable row level security', v_table);
        execute format('revoke all on public.%I from public, anon, authenticated', v_table);
      end loop;
    end $$;
  `
  assert.equal(dynamicRlsEnabled(stripComments(sql), "widgets"), true)
  assert.deepEqual(rulesFor(sql), [])
})

test("a DO block that enables RLS for a different table does not cover this one", () => {
  const sql = `
    create table public.widgets (id uuid primary key);
    do $$
    declare v_table text;
    begin
      foreach v_table in array array['gadgets'] loop
        execute format('alter table public.%I enable row level security', v_table);
      end loop;
    end $$;
  `
  assert.deepEqual(rulesFor(sql), ["create_table_missing_rls"])
})

test("a DO block that mentions RLS but never enables it dynamically does not count", () => {
  const sql = `
    create table public.widgets (id uuid primary key);
    do $$
    begin
      -- remember to add RLS for widgets later
      execute format('grant select on public.%I to service_role', 'widgets');
    end $$;
  `
  assert.deepEqual(rulesFor(sql), ["create_table_missing_rls"])
})

test("an un-enabled new table fails", () => {
  assert.deepEqual(rulesFor("create table public.widgets (id uuid primary key);"), [
    "create_table_missing_rls",
  ])
})

test("an explicit allow-no-rls annotation is honoured", () => {
  const sql = `
    -- security-gate: allow-no-rls (queue drained by a single service worker)
    create table public.widgets (id uuid primary key);
  `
  assert.deepEqual(rulesFor(sql), [])
})

test("every real migration after the cutoff satisfies the RLS rule", () => {
  // Guards the false positive fixed in Batch D: the accounting ledger enables
  // RLS through a table-array DO block rather than per-table ALTER statements.
  const ledger = readFileSync(
    join(root, "supabase/migrations/20261022160000_pharmacy_accounting_ledger.sql"),
    "utf8",
  )
  const failures = analyseSources([{ name: "20261022160000_pharmacy_accounting_ledger.sql", source: ledger }])
  assert.deepEqual(failures.filter((f) => f.rule === "create_table_missing_rls"), [])
})

// --- EXECUTE grants ------------------------------------------------------

test("EXECUTE to anon or public fails", () => {
  for (const role of ["anon", "public"]) {
    const sql = `grant execute on function public.do_thing(uuid) to ${role};`
    assert.deepEqual(rulesFor(sql), ["execute_grant_public_or_anon"])
  }
})

test("EXECUTE to authenticated fails unless the helper is allowlisted", () => {
  assert.deepEqual(rulesFor("grant execute on function public.do_thing(uuid) to authenticated;"), [
    "execute_grant_authenticated_unexpected",
  ])
  assert.deepEqual(rulesFor("grant execute on function public.current_tenant_id() to authenticated;"), [])
})

// --- profiles column grants ---------------------------------------------

test("privileged profiles columns cannot be granted to API roles", () => {
  const sql = "grant update (full_name, role) on public.profiles to authenticated;"
  assert.deepEqual(rulesFor(sql), ["privileged_profile_column_grant"])
  assert.deepEqual(rulesFor("grant update (full_name, phone) on public.profiles to authenticated;"), [])
})

test("a blanket profiles update grant fails", () => {
  assert.deepEqual(rulesFor("grant update on public.profiles to authenticated;"), [
    "broad_profiles_update_grant",
  ])
})

// --- policies ------------------------------------------------------------

test("permissive policies need a service_role scope or an annotation", () => {
  assert.deepEqual(rulesFor("create policy p on public.widgets for select to authenticated using (true);"), [
    "permissive_policy",
  ])
  assert.deepEqual(rulesFor("create policy p on public.widgets for select to service_role using (true);"), [])
  assert.deepEqual(
    rulesFor("-- security-gate: allow-permissive (public catalogue)\ncreate policy p on public.widgets for select to authenticated using (true);"),
    [],
  )
})

test("a real predicate is not treated as permissive", () => {
  assert.deepEqual(
    rulesFor("create policy p on public.widgets for select to authenticated using (tenant_id = current_tenant_id());"),
    [],
  )
})

test("a self-referential tenant predicate fails (SEC-01 shape)", () => {
  const broken = `
    create policy "tenant_isolation" on public.widgets
      using (("tenant_id" = ( select "widgets"."tenant_id" from public.profiles
               where profiles.id = auth.uid() )));
  `
  assert.deepEqual(rulesFor(broken), ["self_referential_tenant_policy"])
})

test("the repaired tenant predicate passes", () => {
  const repaired = `
    create policy "tenant_isolation" on public.widgets
      using (tenant_id = public.current_tenant_id())
      with check (tenant_id = public.current_tenant_id());
  `
  assert.deepEqual(rulesFor(repaired), [])
})

test("a correlated subquery against a different table is not a tautology", () => {
  const scoped = `
    create policy "parent_scope" on public.widgets
      using (tenant_id = ( select "tenants"."id" from public.tenants
               where tenants.id = auth.uid() ));
  `
  assert.deepEqual(rulesFor(scoped), [])
})

// --- browser surface -----------------------------------------------------

test("browser pages that write profiles are rejected, missing pages are reported", () => {
  const failures = analyseSources(
    [],
    [
      { path: "apps/web/src/app/admin/hr/payroll/page.tsx", source: "client.from('profiles').update({ role: 'admin' })" },
      { path: "apps/web/src/app/admin/staff/invite/page.tsx", source: null },
    ],
  )
  assert.deepEqual(
    failures.map((f) => f.rule),
    ["browser_profiles_write", "browser_page_missing"],
  )
})
