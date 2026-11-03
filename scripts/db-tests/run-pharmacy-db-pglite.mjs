#!/usr/bin/env node
/**
 * Real-PostgreSQL proof runner for the pharmacy chain, on an in-process engine.
 *
 * Why this exists: scripts/db-tests/run-pharmacy-db-harness.sh needs a Supabase
 * CLI stack, and `supabase start` needs a Docker daemon. Where Docker is
 * unreachable and no server binary is installed, the only PostgreSQL engine
 * available is PGlite — PostgreSQL compiled to WebAssembly, running the real
 * planner, executor, RLS machinery and constraint system. It is not a mock, but
 * it is a single-user embedded engine, so the concurrency suites cannot run
 * here and say so rather than passing vacuously.
 *
 * The engine is NOT a repository dependency. Point the runner at an extracted
 * copy (see scripts/db-tests/PGLITE-SETUP.md):
 *
 *   PGLITE_DIST=/path/to/node_modules/@electric-sql/pglite/dist \
 *     node scripts/db-tests/run-pharmacy-db-pglite.mjs chain
 *   PGLITE_DIST=... node scripts/db-tests/run-pharmacy-db-pglite.mjs isolation
 *
 * Modes:
 *   chain              apply the canonical snapshot and every migration after
 *                      SNAPSHOT_CUTOFF, report each file, stop reporting at the
 *                      end (a failing file is recorded and the run continues).
 *   isolation          chain, then the pharmacy tenant-isolation assertions.
 *   financial          chain, then the sale, tax, ledger, refund, receivable,
 *                      purchase, supplier, till and purchase-policy assertions.
 *
 * Deviations from a real Supabase database are listed in DEVIATIONS below and
 * printed at the start of every run. The runner takes no options and edits
 * nothing: what it applies is exactly what the repository contains.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DIST = process.env.PGLITE_DIST
const SNAPSHOT_CUTOFF = '20260920190000'

if (!DIST) {
  console.error(
    'CANNOT RUN: PGLITE_DIST is not set, so no database proof was produced.\n' +
      'See scripts/db-tests/PGLITE-SETUP.md for the offline procedure.',
  )
  process.exit(2)
}

const { PGlite } = await import(join(DIST, 'index.js'))
const { pgcrypto } = await import(join(DIST, 'contrib/pgcrypto.js'))
const { uuid_ossp } = await import(join(DIST, 'contrib/uuid_ossp.js'))
const { pg_trgm } = await import(join(DIST, 'contrib/pg_trgm.js'))

const DEVIATIONS = [
  'engine is PGlite (PostgreSQL compiled to WASM), not a Supabase stack',
  'pgvector is absent: "public"."vector"(n) becomes text and the two ivfflat indexes are skipped',
  'PostgreSQL 18 resolves `text[] || \'literal\'` as anyarray||anyarray; one migration is re-read with an explicit ::text cast',
]

const db = await new PGlite({ extensions: { pgcrypto, uuid_ossp, pg_trgm } })
const results = []
let failed = 0

async function exec(label, sql) {
  try {
    await db.exec(sql)
    return true
  } catch (e) {
    failed++
    const msg = String(e.message).split('\n')[0]
    results.push({ label, ok: false, msg })
    console.log(`       FAIL ${label}: ${msg}`)
    return false
  }
}

async function execCounted(label, sql) {
  const ok = await exec(label, sql)
  if (ok) results.push({ label, ok: true })
  return ok
}

/** psql gives each migration its own session; one embedded session must reset. */
async function freshSession() {
  // The snapshot ends with search_path = '' and row_security = off; each psql-run
  // migration gets the session defaults instead. row_security must come back on
  // or every non-owner read of an RLS table raises 42501 instead of filtering.
  for (const sql of ['reset search_path', 'set row_security = on']) {
    try {
      await db.exec(sql)
    } catch {
      try {
        await db.exec('rollback')
        await db.exec(sql)
      } catch {
        /* nothing left to reset */
      }
    }
  }
}

const platformShim = `
  create schema auth;
  create schema extensions;
  create extension if not exists pgcrypto with schema extensions;
  create extension if not exists "uuid-ossp" with schema extensions;
  create extension if not exists pg_trgm with schema public;
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean default false);
  create table storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text, name text, owner uuid, metadata jsonb);
  alter table storage.objects enable row level security;
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select string_to_array(name, '/') $$;
  grant usage on schema auth, storage, extensions to anon, authenticated, service_role;
  -- Supabase grants the table and lets RLS decide; without the grant a caller
  -- gets 42501 and the isolation check would pass for the wrong reason.
  grant select, insert, update, delete on storage.objects to anon, authenticated;
  grant select, insert, update, delete on storage.buckets to anon, authenticated;
`

/** pgvector is not bundled; nothing the pharmacy suites touch uses it. */
function stripPgvector(sql) {
  return sql
    .split('\n')
    .filter((line) => !(/^CREATE INDEX/.test(line) && /ivfflat/.test(line)))
    .join('\n')
    .replace(/"public"\."vector"\s*\(\s*\d+\s*\)/g, '"text"')
    .replace(/"public"\."vector"/g, '"text"')
}

/**
 * PostgreSQL 18 picks `anyarray || anyarray` for `text[] || 'literal'` and fails
 * on the literal; the migration relies on the pre-18 element-append resolution.
 * `::text` selects the same function on every version.
 */
function fixArrayLiteralResolution(sql) {
  return sql.replaceAll(
    "v_policies || 'pharmacy_notifications_own_or_admin'",
    "v_policies || 'pharmacy_notifications_own_or_admin'::text",
  )
}

function migrationFiles() {
  return readdirSync(join(ROOT, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => f.slice(0, 14) > SNAPSHOT_CUTOFF)
}

async function buildDatabase() {
  console.log(`engine: ${(await db.query('select version()')).rows[0].version}`)
  console.log('deviations from a Supabase database:')
  for (const d of DEVIATIONS) console.log(`  - ${d}`)
  console.log('')

  console.log(`[chain] platform shim ${(await exec('platform shim', platformShim)) ? 'PASS' : 'FAIL'}`)

  const snapshot = fixArrayLiteralResolution(
    stripPgvector(readFileSync(join(ROOT, 'supabase/bootstrap/canonical_public_schema.sql'), 'utf8')),
  )
  console.log(`[chain] canonical snapshot ${(await exec('canonical snapshot', snapshot)) ? 'PASS' : 'FAIL'}`)
  // The dump ends with search_path = ''; every psql-run migration starts from
  // the default instead.
  await freshSession()

  let applied = 0
  const files = migrationFiles()
  for (const file of files) {
    await freshSession()
    const sql = fixArrayLiteralResolution(readFileSync(join(ROOT, 'supabase/migrations', file), 'utf8'))
    if (await execCounted(file, sql)) applied++
  }

  console.log(`[chain] ${applied}/${files.length} post-cutoff migrations applied`)
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  FAIL ${r.label}\n       ${r.msg}`)
  }
  return { applied, total: files.length }
}

// ---------------------------------------------------------------------------

const tenants = {
  A: '11111111-1111-1111-1111-111111111111',
  B: '22222222-2222-2222-2222-222222222222',
}
const users = {
  aStaff: 'aaaaaaaa-0000-0000-0000-000000000001',
  bStaff: 'bbbbbbbb-0000-0000-0000-000000000002',
  multi: 'cccccccc-0000-0000-0000-000000000003',
  deleted: 'dddddddd-0000-0000-0000-000000000004',
  platform: 'eeeeeeee-0000-0000-0000-000000000005',
  aAdmin: 'ffffffff-0000-0000-0000-000000000006',
  deactivated: 'aaaa1111-0000-0000-0000-000000000007',
  scoped: 'bbbb2222-0000-0000-0000-000000000008',
  scopedWithdrawn: 'cccc3333-0000-0000-0000-000000000009',
}

const seed = `
  insert into public.tenants (id, slug, name) values
    ('${tenants.A}', 'tenant-a', 'Tenant A Pharmacy'),
    ('${tenants.B}', 'tenant-b', 'Tenant B Pharmacy');

  insert into public.profiles (id, email, full_name, role, tenant_id, is_admin) values
    ('${users.aStaff}', 'a@example.test', 'A Staff', 'pharmacist', '${tenants.A}', false),
    ('${users.bStaff}', 'b@example.test', 'B Staff', 'pharmacist', '${tenants.B}', false),
    ('${users.multi}', 'multi@example.test', 'Multi Staff', 'pharmacist', '${tenants.A}', false),
    ('${users.deleted}', 'gone@example.test', 'Gone Staff', 'pharmacist', '${tenants.B}', false),
    ('${users.platform}', 'platform@example.test', 'Platform Admin', 'platform_admin', null, false),
    ('${users.aAdmin}', 'admin-a@example.test', 'A Admin', 'pharmacist', '${tenants.A}', true),
    ('${users.deactivated}', 'inactive@example.test', 'Inactive Staff', 'pharmacist', '${tenants.A}', false),
    ('${users.scoped}', 'scoped@example.test', 'Scoped Staff', 'pharmacist', null, false),
    ('${users.scopedWithdrawn}', 'withdrawn@example.test', 'Withdrawn Staff', 'pharmacist', null, false);

  update public.profiles set is_deleted = true where id = '${users.deleted}';

  insert into public.pharmacy_user_settings (profile_id, tenant_id, is_active) values
    ('${users.multi}', '${tenants.B}', true),
    ('${users.deactivated}', '${tenants.B}', false);

  insert into public.staff_scope_assignments (profile_id, role, tenant_id, is_active) values
    ('${users.scoped}', 'pharmacist', '${tenants.B}', true),
    ('${users.scopedWithdrawn}', 'pharmacist', '${tenants.B}', false);

  insert into public.pharmacy_transactions
    (tenant_id, transaction_no, cashier_id, total_amount, discount, tax, net_amount, payment_method, status)
  values
    ('${tenants.A}', 'A-001', '${users.aStaff}', 100, 0, 0, 100, 'CASH', 'COMPLETED'),
    ('${tenants.B}', 'B-001', '${users.bStaff}', 200, 0, 0, 200, 'CASH', 'COMPLETED');

  insert into public.pharmacy_products (tenant_id, name, sku, price, cost_price, quantity) values
    ('${tenants.A}', 'Tenant A Item', 'A-SKU', 100, 60, 10),
    ('${tenants.B}', 'Tenant B Item', 'B-SKU', 100, 60, 10);

  insert into storage.objects (bucket_id, name, owner) values
    ('pharmacy-imports', 'tally/tenant-a.json', '${users.aStaff}');
`

/** Run SQL as a signed-in Supabase role with a JWT subject claim. */
async function asUser(userId, role, sql) {
  await db.exec('reset role')
  await db.exec(`select set_config('request.jwt.claim.sub', '${userId}', false)`)
  try {
    await db.exec(`set role ${role}`)
    return (await db.query(sql)).rows
  } catch (e) {
    return [{ error: String(e.message).split('\n')[0] }]
  } finally {
    await db.exec('reset role')
  }
}

/** Run a statement that should be stopped; returns ALLOWED or BLOCKED: msg. */
async function attempt(userId, role, sql) {
  const rows = await asUser(userId, role, sql)
  return rows.length === 1 && rows[0].error ? `BLOCKED: ${rows[0].error}` : 'ALLOWED'
}

const checks = []
function check(name, pass, detail) {
  checks.push({ name, pass, detail })
  console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}${pass || !detail ? '' : ` — ${detail}`}`)
}

async function isolationSuite() {
  await freshSession()
  console.log('\n[isolation] seeding two tenants')
  const seeded = await exec('seed', seed)
  console.log(`[isolation] seed ${seeded ? 'PASS' : 'FAIL'}`)
  if (!seeded) return

  console.log('\n[isolation] pharmacy_transactions')
  const aRows = await asUser(users.aStaff, 'authenticated', 'select transaction_no from public.pharmacy_transactions order by 1')
  check(
    'tenant A staff sees only tenant A transactions',
    aRows.length === 1 && aRows[0].transaction_no === 'A-001',
    JSON.stringify(aRows),
  )

  let crossInsert = 'ALLOWED'
  try {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${users.aStaff}', false)`)
    await db.exec('set role authenticated')
    await db.exec(
      `insert into public.pharmacy_transactions
         (tenant_id, transaction_no, transaction_type, total_amount, discount, tax, net_amount, status, payment_method)
       values ('${tenants.B}', 'A-CROSS', 'sale', 1, 0, 0, 1, 'COMPLETED', 'CASH')`,
    )
  } catch (e) {
    crossInsert = 'BLOCKED: ' + String(e.message).split('\n')[0]
  } finally {
    await db.exec('reset role')
  }
  check('tenant A staff cannot insert a tenant B transaction', crossInsert.startsWith('BLOCKED'), crossInsert)

  const multiRows = await asUser(users.multi, 'authenticated', 'select transaction_no from public.pharmacy_transactions order by 1')
  check(
    'a user with pharmacy_user_settings at the second pharmacy sees both',
    multiRows.length === 2,
    JSON.stringify(multiRows),
  )

  const deletedRows = await asUser(users.deleted, 'authenticated', 'select transaction_no from public.pharmacy_transactions')
  check('a deleted profile sees nothing', deletedRows.length === 0, JSON.stringify(deletedRows))

  const platformRows = await asUser(users.platform, 'authenticated', 'select transaction_no from public.pharmacy_transactions')
  check('a platform administrator still sees every tenant', platformRows.length === 2, JSON.stringify(platformRows))

  const anonRows = await asUser('00000000-0000-0000-0000-000000000000', 'anon', 'select transaction_no from public.pharmacy_transactions')
  check('anon sees nothing', anonRows.length === 0, JSON.stringify(anonRows))

  console.log('\n[isolation] tenant-scoped administrator')
  const adminRows = await asUser(users.aAdmin, 'authenticated', 'select sku from public.pharmacy_products order by 1')
  check(
    "a tenant administrator sees only their own tenant's products",
    adminRows.length === 1 && adminRows[0].sku === 'A-SKU',
    JSON.stringify(adminRows),
  )
  const adminCross = await attempt(
    users.aAdmin,
    'authenticated',
    `insert into public.pharmacy_products (tenant_id, name, sku, price, cost_price, quantity)
     values ('${tenants.B}', 'Cross', 'X-SKU', 1, 1, 1)`,
  )
  check('a tenant administrator cannot create a product in another tenant', adminCross.startsWith('BLOCKED'), adminCross)
  const adminMove = await attempt(
    users.aAdmin,
    'authenticated',
    `update public.pharmacy_products set tenant_id = '${tenants.B}' where sku = 'A-SKU'`,
  )
  check('a tenant administrator cannot move a row into another tenant', adminMove.startsWith('BLOCKED'), adminMove)

  console.log('\n[isolation] pharmacy membership beyond the home tenant')
  const deactivatedRows = await asUser(users.deactivated, 'authenticated', 'select sku from public.pharmacy_products order by 1')
  check(
    'an inactive staff row withdraws the second pharmacy',
    deactivatedRows.length === 1 && deactivatedRows[0].sku === 'A-SKU',
    JSON.stringify(deactivatedRows),
  )
  const scopedRows = await asUser(users.scoped, 'authenticated', 'select sku from public.pharmacy_products order by 1')
  check(
    'an active scope assignment grants that pharmacy',
    scopedRows.length === 1 && scopedRows[0].sku === 'B-SKU',
    JSON.stringify(scopedRows),
  )
  const scopedWithdrawnRows = await asUser(
    users.scopedWithdrawn,
    'authenticated',
    'select sku from public.pharmacy_products order by 1',
  )
  check('a withdrawn scope assignment grants nothing', scopedWithdrawnRows.length === 0, JSON.stringify(scopedWithdrawnRows))

  console.log('\n[isolation] profile privilege escalation')
  const promote = await attempt(
    users.aStaff,
    'authenticated',
    `update public.profiles set role = 'platform_admin' where id = '${users.aStaff}'`,
  )
  check('a user JWT cannot promote itself to platform administrator', promote.startsWith('BLOCKED'), promote)
  const moveTenant = await attempt(
    users.aStaff,
    'authenticated',
    `update public.profiles set tenant_id = '${tenants.B}' where id = '${users.aStaff}'`,
  )
  check('a user JWT cannot move itself into another tenant', moveTenant.startsWith('BLOCKED'), moveTenant)

  console.log('\n[isolation] SECURITY DEFINER surface')
  const fn = (
    await db.query(`
      select p.prosecdef,
             to_json(p.proconfig) as proconfig,
             p.proowner::regrole::text as owner,
             has_function_privilege('anon', p.oid, 'execute') as anon_can
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'pharmacy_caller_tenants'`)
  ).rows[0]
  check(
    'pharmacy_caller_tenants is SECURITY DEFINER with a pinned search_path and no anon EXECUTE',
    Boolean(fn) &&
      fn.prosecdef === true &&
      (fn.proconfig ?? []).some((c) => c.startsWith('search_path=')) &&
      fn.anon_can === false,
    fn ? JSON.stringify(fn) : 'pharmacy_caller_tenants is absent from the database',
  )

  console.log('\n[isolation] storage')
  const storedRows = await asUser(users.aStaff, 'authenticated', 'select count(*)::int as n from storage.objects')
  check('a user JWT reads no stored import object', storedRows[0]?.n === 0, JSON.stringify(storedRows))
  const storagePolicies = (await db.query(`select policyname from pg_policies where schemaname = 'storage'`)).rows
  check(
    'the storage schema carries no policy granting tenant users access',
    storagePolicies.length === 0,
    JSON.stringify(storagePolicies),
  )

  console.log('\n[isolation] purchase tables created by 20260921120000_pharmacy_purchases')
  const anonReachable = (
    await db.query(`
      select tablename || '.' || policyname as p
      from pg_policies
      where schemaname = 'public' and tablename like 'pharmacy\\_%'
        and ('public' = any (roles) or 'anon' = any (roles))
      order by 1`)
  ).rows.map((r) => r.p)
  check(
    'no pharmacy policy is reachable by anon or PUBLIC',
    anonReachable.length === 0,
    anonReachable.join(', '),
  )
}

// ---------------------------------------------------------------------------
// Financial contract. Expected figures are computed here, in JavaScript, from
// the sale inputs — never by reading them back out of the database.

const fin = {
  product: {
    std: '1a000000-0000-4000-8000-000000000001',
    exm: '1a000000-0000-4000-8000-000000000002',
    fefo: '1a000000-0000-4000-8000-000000000003',
  },
  batch: {
    std: '1b000000-0000-4000-8000-000000000001',
    exm: '1b000000-0000-4000-8000-000000000002',
    fefo1: '1b000000-0000-4000-8000-000000000003',
    fefo2: '1b000000-0000-4000-8000-000000000004',
  },
  customer: {
    part: '1c000000-0000-4000-8000-000000000001',
    credit: '1c000000-0000-4000-8000-000000000002',
    repaid: '1c000000-0000-4000-8000-000000000003',
    short: '1c000000-0000-4000-8000-000000000004',
    unposted: '1c000000-0000-4000-8000-000000000005',
  },
  supplier: {
    main: '1d000000-0000-4000-8000-000000000001',
  },
  purchase: {
    main: '1e000000-0000-4000-8000-000000000001',
  },
  till: {
    session: '1f000000-0000-4000-8000-000000000001',
  },
}

const money = (v) => Number(v)
const round2 = (v) => Math.round(v * 100) / 100
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v)

async function financialSuite() {
  await freshSession()
  console.log('\n[financial] seeding one pharmacy with VAT at 18%')
  const seeded = await exec(
    'financial seed',
    `
    insert into public.tenants (id, slug, name) values
      ('${tenants.A}', 'tenant-a', 'Tenant A Pharmacy')
      on conflict (id) do nothing;

    insert into public.profiles (id, email, full_name, role, tenant_id, is_admin) values
      ('${users.aStaff}', 'a@example.test', 'A Staff', 'pharmacist', '${tenants.A}', false)
      on conflict (id) do nothing;

    insert into public.pharmacy_settings (tenant_id, vat_enabled, vat_rate, tax_rate, currency)
      values ('${tenants.A}', true, 18, 0, 'UGX')
      on conflict (tenant_id) do nothing;

    insert into public.pharmacy_products (id, tenant_id, name, sku, price, cost_price, quantity, vat_category) values
      ('${fin.product.std}', '${tenants.A}', 'Standard Item', 'STD-1', 1000, 600, 100, 'standard'),
      ('${fin.product.exm}', '${tenants.A}', 'Exempt Item', 'EXM-1', 500, 300, 100, 'exempt'),
      ('${fin.product.fefo}', '${tenants.A}', 'Split Batch Item', 'FEFO-1', 333.33, 200, 11, 'standard');

    insert into public.pharmacy_product_batches
      (id, tenant_id, product_id, batch_number, quantity, initial_quantity,
       expiry_date, cost_price, selling_price, is_active, status)
    values
      ('${fin.batch.std}', '${tenants.A}', '${fin.product.std}', 'B-STD', 100, 100,
       '2030-01-01', 600, 1000, true, 'active'),
      ('${fin.batch.exm}', '${tenants.A}', '${fin.product.exm}', 'B-EXM', 100, 100,
       '2030-01-01', 300, 500, true, 'active'),
      ('${fin.batch.fefo1}', '${tenants.A}', '${fin.product.fefo}', 'B-F1', 1, 1,
       '2027-01-01', 200, 333.33, true, 'active'),
      ('${fin.batch.fefo2}', '${tenants.A}', '${fin.product.fefo}', 'B-F2', 10, 10,
       '2028-01-01', 200, 333.33, true, 'active');

    insert into public.pharmacy_customers (id, tenant_id, name, email, is_active) values
      ('${fin.customer.part}', '${tenants.A}', 'Part-paid customer', 'part@example.test', true),
      ('${fin.customer.credit}', '${tenants.A}', 'Credit customer', 'credit@example.test', true),
      ('${fin.customer.repaid}', '${tenants.A}', 'Part-repaid customer', 'repaid@example.test', true),
      ('${fin.customer.short}', '${tenants.A}', 'Short posting customer', 'short@example.test', true),
      ('${fin.customer.unposted}', '${tenants.A}', 'Unposted customer', 'unposted@example.test', true);

    insert into public.pharmacy_suppliers (id, tenant_id, name, email, is_active) values
      ('${fin.supplier.main}', '${tenants.A}', 'Kampala Wholesale Ltd', 'supply@example.test', true);

    -- Inserted as a draft and received below, so the ledger trigger posts once,
    -- on the RECEIVED transition, exactly as the purchase route receives it.
    insert into public.pharmacy_purchases
      (id, tenant_id, purchase_no, supplier_id, purchase_date, payment_status,
       payment_method, currency, subtotal, tax, discount, other_cost, total,
       amount_paid, balance, status, created_by, received_by)
    values
      ('${fin.purchase.main}', '${tenants.A}', 'PUR-FIN-1', '${fin.supplier.main}',
       '2026-10-01', 'PARTIAL', 'cash', 'UGX', 1000, 180, 0, 0, 1180,
       380, 800, 'DRAFT', '${users.aStaff}', '${users.aStaff}');

    insert into public.pharmacy_cashier_sessions
      (id, tenant_id, cashier_id, status, opening_float)
    values
      ('${fin.till.session}', '${tenants.A}', '${users.aStaff}', 'open', 500);
  `,
  )
  console.log(`[financial] seed ${seeded ? 'PASS' : 'FAIL'}`)
  if (!seeded) return

  // Independent expectation, from the inputs only.
  const line = {
    std: { qty: 2, price: 1000, discount: 100, cost: 600 },
    exm: { qty: 3, price: 500, discount: 0, cost: 300 },
  }
  const rate = 18
  const expected = {
    subtotal: line.std.qty * line.std.price + line.exm.qty * line.exm.price,
    discount: line.std.discount + line.exm.discount,
    stdTaxable: line.std.qty * line.std.price - line.std.discount,
    tax: round2(((line.std.qty * line.std.price - line.std.discount) * rate) / 100),
    cogs: line.std.qty * line.std.cost + line.exm.qty * line.exm.cost,
  }
  expected.total = round2(expected.subtotal - expected.discount + expected.tax)
  expected.journalTotal = round2(expected.total + expected.discount + expected.cogs)

  const items = [
    {
      product_id: fin.product.std,
      batch_id: fin.batch.std,
      quantity: line.std.qty,
      unit_price: line.std.price,
      discount_amount: line.std.discount,
      discount_reason: 'loyalty',
    },
    {
      product_id: fin.product.exm,
      batch_id: fin.batch.exm,
      quantity: line.exm.qty,
      unit_price: line.exm.price,
    },
  ]

  console.log('\n[financial] a two-line sale, one standard-rated and one exempt')
  const saleRaw = (
    await db.query(
      `select public.complete_pharmacy_sale(
         p_tenant_id => '${tenants.A}',
         p_cashier_id => '${users.aStaff}',
         p_items => $1::jsonb,
         p_payment_method => 'cash',
         p_discount_total => 0,
         p_tax_amount => 0,
         p_idempotency_key => 'fin-sale-1') as r`,
      [JSON.stringify(items)],
    )
  ).rows[0].r
  const sale = parseJson(saleRaw)
  check(
    'the sale returns the independently calculated subtotal, discount, tax and total',
    money(sale.subtotal) === expected.subtotal &&
      money(sale.discount_total) === expected.discount &&
      money(sale.tax_amount) === expected.tax &&
      money(sale.total_amount) === expected.total,
    `got ${JSON.stringify(sale)}, expected subtotal=${expected.subtotal} discount=${expected.discount} tax=${expected.tax} total=${expected.total}`,
  )
  check('the sale records that its tax came from the VAT configuration', sale.tax_source === 'vat', String(sale.tax_source))

  const stored = (
    await db.query(
      `select subtotal, discount_total, tax_amount, total_amount, tax_source, status
       from public.pharmacy_pos_sales where id = '${sale.sale_id}'`,
    )
  ).rows[0]
  check(
    'the stored sale row carries the same figures',
    money(stored.subtotal) === expected.subtotal &&
      money(stored.discount_total) === expected.discount &&
      money(stored.tax_amount) === expected.tax &&
      money(stored.total_amount) === expected.total &&
      stored.status === 'completed',
    JSON.stringify(stored),
  )

  console.log('\n[financial] line-level tax classification')
  const lines = (
    await db.query(
      `select product_id, quantity, unit_price, discount_amount, vat_category,
              tax_rate, taxable_amount, tax_amount, tax_source
       from public.pharmacy_pos_sale_items
       where sale_id = '${sale.sale_id}' order by product_id`,
    )
  ).rows
  const stdLine = lines.find((l) => l.product_id === fin.product.std)
  const exmLine = lines.find((l) => l.product_id === fin.product.exm)
  check(
    'the standard-rated line taxes only its net-of-discount value',
    Boolean(stdLine) &&
      money(stdLine.taxable_amount) === expected.stdTaxable &&
      money(stdLine.tax_amount) === expected.tax &&
      money(stdLine.tax_rate) === rate,
    JSON.stringify(stdLine),
  )
  check(
    'the exempt line carries a zero taxable base and zero tax',
    Boolean(exmLine) && money(exmLine.taxable_amount) === 0 && money(exmLine.tax_amount) === 0,
    JSON.stringify(exmLine),
  )

  console.log('\n[financial] the ledger posting')
  const journal = (
    await db.query(
      `select a.system_key, sum(l.debit) as debit, sum(l.credit) as credit
       from public.pharmacy_accounting_journal_lines l
       join public.pharmacy_accounting_accounts a on a.id = l.account_id
       join public.pharmacy_accounting_journal_entries e on e.id = l.journal_entry_id
       where e.source_type = 'sale' and e.source_id = '${sale.sale_id}'
       group by a.system_key order by a.system_key`,
    )
  ).rows
  const byKey = Object.fromEntries(journal.map((r) => [r.system_key, r]))
  const debits = round2(journal.reduce((s, r) => s + money(r.debit), 0))
  const credits = round2(journal.reduce((s, r) => s + money(r.credit), 0))
  check(
    'the sale journal balances at total + discount + cost of goods',
    debits === credits && debits === expected.journalTotal && debits > 0,
    `debits=${debits} credits=${credits} expected=${expected.journalTotal} rows=${JSON.stringify(journal)}`,
  )
  check(
    'output VAT is credited at the independently calculated figure',
    money(byKey.OUTPUT_VAT?.credit) === expected.tax,
    JSON.stringify(byKey.OUTPUT_VAT),
  )
  check(
    'sales revenue is credited at the pre-tax subtotal and the discount is debited',
    money(byKey.SALES_REVENUE?.credit) === expected.subtotal &&
      money(byKey.SALES_DISCOUNTS?.debit) === expected.discount,
    JSON.stringify({ revenue: byKey.SALES_REVENUE, discount: byKey.SALES_DISCOUNTS }),
  )
  check(
    'inventory is relieved at the batch cost of the units sold',
    money(byKey.COST_OF_GOODS_SOLD?.debit) === expected.cogs &&
      money(byKey.INVENTORY?.credit) === expected.cogs,
    JSON.stringify({ cogs: byKey.COST_OF_GOODS_SOLD, inventory: byKey.INVENTORY }),
  )

  console.log('\n[financial] the calling till figure is a cross-check')
  let mismatch = 'ACCEPTED'
  try {
    // Positional, all twelve arguments: the 11-argument overload from
    // 20260703185455 is still in the catalogue, so a shorter call is ambiguous.
    await db.query(
      `select public.complete_pharmacy_sale(
         '${tenants.A}', '${users.aStaff}', $1::jsonb, 'cash',
         null, null, null, 0, ${expected.tax + 5}, null, null, null)`,
      [JSON.stringify([items[0]])],
    )
  } catch (e) {
    mismatch = String(e.message).split('\n')[0]
  }
  check('a till figure that disagrees with the server is refused', mismatch.startsWith('TAX_MISMATCH'), mismatch)

  console.log('\n[financial] idempotency')
  const again = parseJson(
    (
      await db.query(
        `select public.complete_pharmacy_sale(
           p_tenant_id => '${tenants.A}', p_cashier_id => '${users.aStaff}',
           p_items => $1::jsonb, p_payment_method => 'cash',
           p_idempotency_key => 'fin-sale-1') as r`,
        [JSON.stringify(items)],
      )
    ).rows[0].r,
  )
  const saleCount = (
    await db.query(`select count(*)::int as n from public.pharmacy_pos_sales where tenant_id = '${tenants.A}'`)
  ).rows[0].n
  check(
    'replaying the same idempotency key returns the first sale and writes no second one',
    again.sale_id === sale.sale_id && saleCount === 1,
    `sale_id ${again.sale_id} vs ${sale.sale_id}, rows=${saleCount}`,
  )

  console.log('\n[financial] one sale function, not two')
  let shortCall = 'RESOLVED'
  try {
    await db.query(
      `select public.complete_pharmacy_sale('${tenants.A}', '${users.aStaff}', $1::jsonb, 'cash')`,
      [JSON.stringify([items[0]])],
    )
  } catch (e) {
    shortCall = String(e.message).split('\n')[0]
  }
  const overloads = (
    await db.query(
      `select count(*)::int as n from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'complete_pharmacy_sale'`,
    )
  ).rows[0].n
  check(
    'a call supplying fewer arguments resolves to the one remaining sale function',
    overloads === 1 && !/is not unique/.test(shortCall),
    `overloads=${overloads}, call=${shortCall}`,
  )

  console.log('\n[financial] a line that spans two batches')
  // 3 units at 333.33: one from the batch expiring first, two from the next.
  // Each row is taxed on its own rounded base, so the expected tax is the sum
  // of two independently rounded figures, not the tax on the whole line.
  const line1 = 1 * 333.33
  const line2 = 2 * 333.33
  const splitExpected = {
    tax: round2(round2((line1 * rate) / 100) + round2((line2 * rate) / 100)),
    subtotal: round2(line1 + line2),
  }
  splitExpected.total = round2(splitExpected.subtotal + splitExpected.tax)
  const split = parseJson(
    (
      await db.query(
        `select public.complete_pharmacy_sale(
           p_tenant_id => '${tenants.A}', p_cashier_id => '${users.aStaff}',
           p_items => $1::jsonb, p_payment_method => 'cash',
           p_idempotency_key => 'fin-split-1') as r`,
        [
          JSON.stringify([
            { product_id: fin.product.fefo, quantity: 3, unit_price: 333.33, allow_overdraft: true },
          ]),
        ],
      )
    ).rows[0].r,
  )
  const splitRows = (
    await db.query(
      `select batch_id, quantity, taxable_amount, tax_amount
       from public.pharmacy_pos_sale_items where sale_id = '${split.sale_id}' order by quantity`,
    )
  ).rows
  check(
    'a line spanning two batches splits into one row per batch and taxes each row',
    splitRows.length === 2 &&
      round2(splitRows.reduce((s, r) => s + money(r.tax_amount), 0)) === splitExpected.tax,
    JSON.stringify({ rows: splitRows, expectedTax: splitExpected.tax }),
  )
  check(
    'the split sale totals what the independently rounded rows add up to',
    money(split.subtotal) === splitExpected.subtotal && money(split.total_amount) === splitExpected.total,
    `got ${JSON.stringify(split)}, expected ${JSON.stringify(splitExpected)}`,
  )

  console.log('\n[financial] a partly paid sale')
  const partial = parseJson(
    (
      await db.query(
        `select public.complete_pharmacy_sale(
           p_tenant_id => '${tenants.A}', p_cashier_id => '${users.aStaff}',
           p_items => $1::jsonb, p_payment_method => 'cash',
           p_payment_ref => 'PAID:2000', p_idempotency_key => 'fin-partial-1') as r`,
        [JSON.stringify([items[0]])],
      )
    ).rows[0].r,
  )
  const partialLines = (
    await db.query(
      `select a.system_key, sum(l.debit) as debit, sum(l.credit) as credit
       from public.pharmacy_accounting_journal_lines l
       join public.pharmacy_accounting_accounts a on a.id = l.account_id
       join public.pharmacy_accounting_journal_entries e on e.id = l.journal_entry_id
       where e.source_type = 'sale' and e.source_id = '${partial.sale_id}'
       group by a.system_key`,
    )
  ).rows
  const pByKey = Object.fromEntries(partialLines.map((r) => [r.system_key, r]))
  const paid = 2000
  const owed = round2(money(partial.total_amount) - paid)
  check(
    'a partly paid sale debits cash for what was paid and receivables for the rest',
    money(pByKey.CASH_ON_HAND?.debit) === paid && money(pByKey.ACCOUNTS_RECEIVABLE?.debit) === owed,
    JSON.stringify({ rows: partialLines, total: partial.total_amount, expectedOwed: owed }),
  )
  check(
    'the partly paid journal still balances',
    round2(partialLines.reduce((s, r) => s + money(r.debit), 0)) ===
      round2(partialLines.reduce((s, r) => s + money(r.credit), 0)),
    JSON.stringify(partialLines),
  )

  console.log('\n[financial] reversal')
  const stockBefore = (
    await db.query(
      `select id, quantity from public.pharmacy_product_batches
       where id in ('${fin.batch.std}', '${fin.batch.exm}') order by id`,
    )
  ).rows
  const reversed = parseJson(
    (
      await db.query(
        `select public.reverse_pharmacy_sale(
           '${tenants.A}', '${sale.sale_id}', '${users.aStaff}', 'customer returned', 'active') as r`,
      )
    ).rows[0].r,
  )
  const stockAfter = (
    await db.query(
      `select id, quantity from public.pharmacy_product_batches
       where id in ('${fin.batch.std}', '${fin.batch.exm}') order by id`,
    )
  ).rows
  check(
    'reversing the sale restores every batch quantity',
    stockAfter.length === 2 &&
      stockAfter.every((after) => {
        const before = stockBefore.find((b) => b.id === after.id)
        return before && after.quantity === before.quantity + line[after.id === fin.batch.std ? 'std' : 'exm'].qty
      }),
    JSON.stringify({ before: stockBefore, after: stockAfter }),
  )

  const reversal = (
    await db.query(
      `select e.total_debit, e.total_credit from public.pharmacy_accounting_journal_entries e
       where e.source_type = 'sale_reversal' and e.source_id = '${sale.sale_id}'`,
    )
  ).rows[0]
  const net = (
    await db.query(
      `select sum(l.debit) as debit, sum(l.credit) as credit
       from public.pharmacy_accounting_journal_lines l
       join public.pharmacy_accounting_journal_entries e on e.id = l.journal_entry_id
       where e.source_id = '${sale.sale_id}'`,
    )
  ).rows[0]
  check(
    'the reversal journal is the mirror image, so the sale nets to zero',
    Boolean(reversal) &&
      round2(money(net.debit) - money(net.credit)) === 0 &&
      money(reversal.total_debit) === money(reversal.total_credit),
    JSON.stringify({ reversal, net }),
  )
  console.log(`[financial] reversal result: ${JSON.stringify(reversed)}`)

  // Every figure below is derived from the inputs at the top of this suite.
  // Nothing is read back out of the database to form its own expectation.
  // The credit scenarios sell the standard-rated line on its own, so their
  // totals are that line's, not the two-line sale's.
  const oneLine = {
    subtotal: expected.stdTaxable,
    tax: expected.tax,
  }
  oneLine.total = round2(oneLine.subtotal + oneLine.tax)

  const journalFor = async (sourceType, sourceId) =>
    (
      await db.query(
        `select a.system_key, sum(l.debit) as debit, sum(l.credit) as credit
         from public.pharmacy_accounting_journal_lines l
         join public.pharmacy_accounting_accounts a on a.id = l.account_id
         join public.pharmacy_accounting_journal_entries e on e.id = l.journal_entry_id
         where e.source_type = '${sourceType}' and e.source_id = '${sourceId}'
         group by a.system_key order by a.system_key`,
      )
    ).rows

  const creditsFor = async (customerId) =>
    (
      await db.query(
        `select type, amount, balance_after, idempotency_key
         from public.pharmacy_credit_ledger
         where tenant_id = '${tenants.A}' and customer_id = '${customerId}'
         order by created_at, id`,
      )
    ).rows

  // A sale wholly or partly on credit. The RPC stores the settlement tag and
  // does not touch the credit ledger; complete-sale posts the balance after the
  // RPC commits, so these scenarios reproduce that order.
  const saleOnCredit = async (key, paid) =>
    parseJson(
      (
        await db.query(
          `select public.complete_pharmacy_sale(
             p_tenant_id => '${tenants.A}', p_cashier_id => '${users.aStaff}',
             p_items => $1::jsonb, p_payment_method => 'credit',
             p_payment_ref => 'PAID:${paid}|BAL:${round2(oneLine.total - paid)}|M:CREDIT',
             p_idempotency_key => '${key}') as r`,
          [JSON.stringify([items[0]])],
        )
      ).rows[0].r,
    )

  const postCredit = async (customerId, amount, saleId, key) =>
    (
      await db.query(
        `select public.post_pharmacy_credit_entry(
           '${tenants.A}', '${customerId}', 'credit', ${amount},
           null, null, 'POS sale on credit', '${users.aStaff}',
           '${key ?? `pos-sale:${saleId}`}', 'credit') as r`,
      )
    ).rows[0].r

  const refundSale = async (saleId, reason) =>
    parseJson(
      (
        await db.query(
          `select public.reverse_pharmacy_sale(
             '${tenants.A}', '${saleId}', '${users.aStaff}', '${reason}', 'active') as r`,
        )
      ).rows[0].r,
    )

  console.log('\n[financial] a sale paid entirely on credit, then refunded')
  const credit1 = await saleOnCredit('fin-credit-1', 0)
  await postCredit(fin.customer.credit, oneLine.total, credit1.sale_id)
  const credit1Journal = await journalFor('sale', credit1.sale_id)
  const c1 = Object.fromEntries(credit1Journal.map((r) => [r.system_key, r]))
  check(
    'a sale paid entirely on credit debits the receivable for the whole total and no cash',
    money(c1.ACCOUNTS_RECEIVABLE?.debit ?? 0) === oneLine.total &&
      money(c1.CASH_ON_HAND?.debit ?? 0) === 0,
    JSON.stringify(credit1Journal),
  )

  const refund1 = await refundSale(credit1.sale_id, 'unused goods returned')
  check(
    'refunding a fully-credit sale hands back no cash and reverses the whole receivable',
    money(refund1.refund_amount) === 0 &&
      money(refund1.receivable_reversal) === oneLine.total &&
      money(refund1.receivable_outstanding) === oneLine.total &&
      money(refund1.receivable_unreversed) === 0 &&
      refund1.receivable_unposted === false,
    JSON.stringify(refund1),
  )
  check(
    'the reversal leaves the customer owing nothing',
    money(refund1.credit_balance_after) === 0,
    JSON.stringify(refund1),
  )

  const credit1Rows = await creditsFor(fin.customer.credit)
  check(
    'the refund writes one ledger row keyed to the sale and leaves the balance at zero',
    credit1Rows.length === 2 &&
      credit1Rows[0].type === 'credit' &&
      money(credit1Rows[0].amount) === oneLine.total &&
      credit1Rows[0].idempotency_key === `pos-sale:${credit1.sale_id}` &&
      credit1Rows[1].type === 'refund' &&
      money(credit1Rows[1].amount) === oneLine.total &&
      money(credit1Rows[1].balance_after) === 0 &&
      credit1Rows[1].idempotency_key === `pos-refund:${credit1.sale_id}`,
    JSON.stringify(credit1Rows),
  )

  const credit1Net = (
    await db.query(
      `select a.system_key, sum(l.debit) - sum(l.credit) as net
       from public.pharmacy_accounting_journal_lines l
       join public.pharmacy_accounting_accounts a on a.id = l.account_id
       join public.pharmacy_accounting_journal_entries e on e.id = l.journal_entry_id
       where e.source_id = '${credit1.sale_id}'
       group by a.system_key order by a.system_key`,
    )
  ).rows
  check(
    'the reversal mirrors the receivable, so every account nets to zero',
    credit1Net.length > 0 && credit1Net.every((r) => round2(money(r.net)) === 0),
    JSON.stringify(credit1Net),
  )

  console.log('\n[financial] a part-paid sale, then refunded')
  const cashPaid = 1000
  const credit2 = await saleOnCredit('fin-credit-part-1', cashPaid)
  const balanceDue2 = round2(oneLine.total - cashPaid)
  await postCredit(fin.customer.part, balanceDue2, credit2.sale_id)
  const credit2Journal = await journalFor('sale', credit2.sale_id)
  const c2 = Object.fromEntries(credit2Journal.map((r) => [r.system_key, r]))
  check(
    'a part-paid credit sale splits the total between cash and the receivable',
    money(c2.CASH_ON_HAND?.debit ?? 0) === cashPaid &&
      money(c2.ACCOUNTS_RECEIVABLE?.debit ?? 0) === balanceDue2,
    JSON.stringify({ journal: credit2Journal, expected: { cash: cashPaid, receivable: balanceDue2 } }),
  )

  const refund2 = await refundSale(credit2.sale_id, 'customer returned the purchase')
  check(
    'the refund returns the cash the customer actually paid and reverses only the unpaid part',
    money(refund2.refund_amount) === cashPaid &&
      money(refund2.receivable_reversal) === balanceDue2 &&
      money(refund2.receivable_outstanding) === balanceDue2 &&
      money(refund2.receivable_unreversed) === 0 &&
      money(refund2.credit_balance_after) === 0,
    JSON.stringify(refund2),
  )

  console.log('\n[financial] a credit sale the customer had partly repaid')
  const credit3 = await saleOnCredit('fin-credit-repaid-1', 0)
  await postCredit(fin.customer.repaid, oneLine.total, credit3.sale_id)
  const repayment = 400
  const repaid = (
    await db.query(
      `select public.post_pharmacy_credit_entry(
         '${tenants.A}', '${fin.customer.repaid}', 'repayment', ${repayment},
         null, null, 'part payment before return', '${users.aStaff}',
         'fin-repayment-1', 'cash') as r`,
    )
  ).rows[0].r
  check(
    'a repayment posts a customer receipt that settles part of the receivable',
    Number(parseJson(repaid)?.balance_after ?? repaid.balance_after) === round2(oneLine.total - repayment),
    JSON.stringify(repaid),
  )

  const refund3 = await refundSale(credit3.sale_id, 'goods returned after part payment')
  check(
    'refunding a partly repaid credit sale leaves the customer in store credit',
    money(refund3.refund_amount) === 0 &&
      money(refund3.receivable_reversal) === oneLine.total &&
      money(refund3.credit_balance_after) === -repayment,
    JSON.stringify(refund3),
  )
  const credit3Rows = await creditsFor(fin.customer.repaid)
  check(
    'the ledger reads credit, repayment, refund with balances that add up',
    credit3Rows.length === 3 &&
      credit3Rows.map((r) => [r.type, money(r.balance_after)]).join('|') ===
        [
          ['credit', oneLine.total],
          ['repayment', round2(oneLine.total - repayment)],
          ['refund', -repayment],
        ]
          .map(([t, b]) => `${t},${b}`)
          .join('|'),
    JSON.stringify(credit3Rows),
  )

  console.log('\n[financial] a receivable that posted less than the sale owed')
  const credit4 = await saleOnCredit('fin-credit-short-1', cashPaid)
  const shortPosted = 500
  await postCredit(fin.customer.short, shortPosted, credit4.sale_id)
  const refund4 = await refundSale(credit4.sale_id, 'returned after a partial posting')
  check(
    'the reversal is capped at what the ledger holds and the remainder is reported',
    money(refund4.refund_amount) === cashPaid &&
      money(refund4.receivable_reversal) === shortPosted &&
      money(refund4.receivable_unreversed) === round2(balanceDue2 - shortPosted) &&
      money(refund4.receivable_outstanding) === balanceDue2 &&
      refund4.receivable_unposted === false,
    JSON.stringify(refund4),
  )

  console.log('\n[financial] a credit sale whose receivable was never posted')
  const credit5 = await saleOnCredit('fin-credit-unposted-1', 0)
  const refund5 = await refundSale(credit5.sale_id, 'credit posting had failed at sale time')
  check(
    'an unposted receivable is reported instead of a cash refund that was never received',
    money(refund5.refund_amount) === 0 &&
      money(refund5.receivable_reversal) === 0 &&
      money(refund5.receivable_outstanding) === oneLine.total &&
      refund5.receivable_unposted === true,
    JSON.stringify(refund5),
  )
  const voided = (
    await db.query(`select status from public.pharmacy_pos_sales where id = '${credit5.sale_id}'`)
  ).rows[0]
  check('the sale is voided even when its receivable could not be reversed', voided?.status === 'voided', JSON.stringify(voided))

  console.log('\n[financial] a received purchase and the supplier balance it leaves')
  const purchasePaid = 380
  const purchaseTotal = 1180
  const purchaseSubtotal = 1000
  const purchaseTax = 180
  const purchasePayable = round2(purchaseTotal - purchasePaid)
  await exec(
    'purchase received',
    `update public.pharmacy_purchases set status = 'RECEIVED' where id = '${fin.purchase.main}'`,
  )
  const purchaseJournal = await journalFor('purchase', fin.purchase.main)
  const pj = Object.fromEntries(purchaseJournal.map((r) => [r.system_key, r]))
  check(
    'a received purchase debits inventory and input VAT and credits the supplier for the unpaid balance',
    money(pj.INVENTORY?.debit ?? 0) === purchaseSubtotal &&
      money(pj.INPUT_VAT?.debit ?? 0) === purchaseTax &&
      money(pj.CASH_ON_HAND?.credit ?? 0) === purchasePaid &&
      money(pj.ACCOUNTS_PAYABLE?.credit ?? 0) === purchasePayable,
    JSON.stringify({ journal: purchaseJournal, expected: { inventory: purchaseSubtotal, inputVat: purchaseTax, paid: purchasePaid, payable: purchasePayable } }),
  )
  check(
    'the purchase journal balances',
    round2(purchaseJournal.reduce((s, r) => s + money(r.debit), 0)) ===
      round2(purchaseJournal.reduce((s, r) => s + money(r.credit), 0)),
    JSON.stringify(purchaseJournal),
  )

  await exec(
    'supplier payment',
    `update public.pharmacy_purchases
        set amount_paid = ${purchaseTotal}, balance = 0, payment_status = 'PAID'
      where id = '${fin.purchase.main}'`,
  )
  const supplierJournal = (
    await db.query(
      `select a.system_key, sum(l.debit) as debit, sum(l.credit) as credit
       from public.pharmacy_accounting_journal_lines l
       join public.pharmacy_accounting_accounts a on a.id = l.account_id
       join public.pharmacy_accounting_journal_entries e on e.id = l.journal_entry_id
       where e.source_type = 'supplier_payment' and e.source_id like '${fin.purchase.main}:%'
       group by a.system_key order by a.system_key`,
    )
  ).rows
  const sj = Object.fromEntries(supplierJournal.map((r) => [r.system_key, r]))
  check(
    'paying the supplier settles the payable and credits cash for the same amount',
    money(sj.ACCOUNTS_PAYABLE?.debit ?? 0) === purchasePayable &&
      money(sj.CASH_ON_HAND?.credit ?? 0) === purchasePayable,
    JSON.stringify(supplierJournal),
  )
  check(
    'the supplier balance is fully settled across the receipt and the payment',
    round2(
      money(pj.ACCOUNTS_PAYABLE?.credit ?? 0) - money(sj.ACCOUNTS_PAYABLE?.debit ?? 0),
    ) === 0,
    JSON.stringify({ credited: pj.ACCOUNTS_PAYABLE, settled: sj.ACCOUNTS_PAYABLE }),
  )

  console.log('\n[financial] till cash reconciliation')
  const till = async (kind, amount, source) =>
    parseJson(
      (
        await db.query(
          `select public.pharmacy_till_record_cash(
             '${tenants.A}', '${fin.till.session}', '${kind}', ${amount},
             '${source}', '${users.aStaff}') as r`,
        )
      ).rows[0].r,
    )
  const openingFloat = 500
  const tillSale = oneLine.total
  const tillRefund = 500
  const first = await till('sale', tillSale, `sale:${credit1.sale_id}`)
  const replay = await till('sale', tillSale, `sale:${credit1.sale_id}`)
  const tillRefundResult = await till('refund', tillRefund, `refund:${credit1.sale_id}`)
  const zero = await till('cash_in', 0, 'zero-source')
  check(
    'a cash sale is credited to the till once and a replay is refused as a duplicate',
    first.applied === true && replay.applied === false && replay.reason === 'DUPLICATE',
    JSON.stringify({ first, replay }),
  )
  check(
    'a zero cash movement is refused rather than written',
    zero.applied === false && zero.reason === 'NO_CASH',
    JSON.stringify(zero),
  )
  check(
    'the refund is recorded against the till',
    tillRefundResult.applied === true,
    JSON.stringify(tillRefundResult),
  )
  const tillSession = (
    await db.query(
      `select opening_float, cash_payment_total, cash_refund_total, cash_in, cash_out
       from public.pharmacy_cashier_sessions where id = '${fin.till.session}'`,
    )
  ).rows[0]
  const expectedTillCash = round2(openingFloat + tillSale - tillRefund)
  check(
    'the till totals give the cash the drawer should hold, with the replay counted once',
    money(tillSession.cash_payment_total) === tillSale &&
      money(tillSession.cash_refund_total) === tillRefund &&
      round2(
        money(tillSession.opening_float) +
          money(tillSession.cash_payment_total) -
          money(tillSession.cash_refund_total) +
          money(tillSession.cash_in) -
          money(tillSession.cash_out),
      ) === expectedTillCash,
    JSON.stringify({ session: tillSession, expectedTillCash }),
  )
  const tillEventCount = (
    await db.query(
      `select count(*)::int as n from public.pharmacy_till_cash_events where session_id = '${fin.till.session}'`,
    )
  ).rows[0].n
  check('only the two accepted movements are stored', tillEventCount === 2, String(tillEventCount))

  console.log('\n[financial] the purchase tenant-isolation policies')
  const purchaseTables = [
    'pharmacy_purchases',
    'pharmacy_purchase_items',
    'pharmacy_purchase_idempotency',
    'pharmacy_purchase_attachments',
    'pharmacy_supplier_returns',
  ]
  const purchasePolicies = (
    await db.query(
      `select c.relname as table_name, pol.polname,
              (select array_agg(r.rolname::text order by r.rolname::text)
                 from pg_roles r where r.oid = any (pol.polroles)) as roles,
              pg_get_expr(pol.polqual, pol.polrelid) as using_expr,
              pg_get_expr(pol.polwithcheck, pol.polrelid) as check_expr
       from pg_policy pol
       join pg_class c on c.oid = pol.polrelid
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = any ('{${purchaseTables.join(',')}}'::text[])
       order by c.relname, pol.polname`,
    )
  ).rows
  check(
    'every purchase table carries exactly one tenant-isolation policy',
    purchasePolicies.length === purchaseTables.length &&
      purchaseTables.every((t) => purchasePolicies.filter((p) => p.table_name === t).length === 1),
    JSON.stringify(purchasePolicies.map((p) => p.table_name)),
  )
  check(
    'each purchase policy is scoped to authenticated and to no other role',
    purchasePolicies.length === purchaseTables.length &&
      purchasePolicies.every(
        (p) => Array.isArray(p.roles) && p.roles.length === 1 && p.roles[0] === 'authenticated',
      ),
    JSON.stringify(purchasePolicies.map((p) => [p.table_name, p.roles])),
  )
  check(
    'each purchase policy admits a row only for the caller’s tenants',
    purchasePolicies.length === purchaseTables.length &&
      purchasePolicies.every(
        (p) =>
          /pharmacy_caller_tenants/.test(p.using_expr ?? '') &&
          /pharmacy_caller_tenants/.test(p.check_expr ?? ''),
      ),
    JSON.stringify(purchasePolicies.map((p) => [p.table_name, p.using_expr, p.check_expr])),
  )

  const purchaseGrants = (
    await db.query(
      `select c.relname,
              has_table_privilege('anon', c.oid, 'SELECT') as anon_select,
              has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
              has_table_privilege('service_role', c.oid, 'SELECT') as svc_select
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = any ('{${purchaseTables.join(',')}}'::text[])
       order by c.relname`,
    )
  ).rows
  check(
    'the purchase tables stay reachable only through the service role',
    purchaseGrants.length === purchaseTables.length &&
      purchaseGrants.every((g) => g.anon_select === false && g.auth_select === false && g.svc_select === true),
    JSON.stringify(purchaseGrants),
  )
}

// ---------------------------------------------------------------------------

const mode = process.argv[2] ?? 'chain'
if (!['chain', 'isolation', 'financial'].includes(mode)) {
  console.error(`unknown mode: ${mode} (expected chain, isolation or financial)`)
  process.exit(2)
}

const extra = process.argv.slice(3)
if (extra.length) {
  console.error(`unknown option: ${extra.join(' ')} (the runner takes no options)`)
  process.exit(2)
}

const chain = await buildDatabase()
if (mode === 'isolation') await isolationSuite()
if (mode === 'financial') await financialSuite()

const failedChecks = checks.filter((c) => !c.pass)
console.log('')
console.log(`[summary] post-cutoff migrations applied: ${chain.applied}/${chain.total}`)
console.log(`[summary] checks: ${checks.length - failedChecks.length}/${checks.length} passed`)
console.log(`[summary] outcomes: ${failed === 0 && failedChecks.length === 0 ? 'PASS' : 'FAIL'}`)
await db.close()
process.exit(failed === 0 && failedChecks.length === 0 ? 0 : 1)
