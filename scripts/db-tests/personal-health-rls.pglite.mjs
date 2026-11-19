#!/usr/bin/env node
/**
 * Engine-level proof that personal wearable readings are owner-private.
 *
 * Applies supabase/migrations/20261120120000_personal_wearables_owner_private.sql
 * verbatim on a real PostgreSQL engine (PGlite, see PGLITE-SETUP.md) on top of a
 * minimal Supabase-shaped bootstrap (anon/authenticated/service_role roles,
 * auth.uid() reading request.jwt.claim.sub, a profiles table), then acts as:
 *
 *   owner     a pharmacy cashier with readings
 *   admin     the same pharmacy's admin (same tenant_id, is_admin = true)
 *   stranger  someone at another facility
 *   anon      no session
 *
 *   PGLITE_DIST=/path/to/@electric-sql/pglite/dist \
 *     node scripts/db-tests/personal-health-rls.pglite.mjs
 *
 * Exits 2 with CANNOT RUN when PGLITE_DIST is unset, so it never passes vacuously.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const DIST = process.env.PGLITE_DIST
if (!DIST) {
  console.error('CANNOT RUN: PGLITE_DIST is not set, so no database proof was produced. See scripts/db-tests/PGLITE-SETUP.md.')
  process.exit(2)
}

const { PGlite } = await import(join(DIST, 'index.js'))
const db = await new PGlite()

const OWNER = '00000000-0000-4000-8000-0000000000a1'
const ADMIN = '00000000-0000-4000-8000-0000000000a2'
const STRANGER = '00000000-0000-4000-8000-0000000000b1'
const TENANT = '00000000-0000-4000-8000-00000000000a'
const OTHER_TENANT = '00000000-0000-4000-8000-00000000000b'

await db.exec(`
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  create table public.profiles (id uuid primary key, tenant_id uuid, role text, is_admin boolean default false);
  insert into public.profiles values
    ('${OWNER}', '${TENANT}', 'pharmacy_cashier', false),
    ('${ADMIN}', '${TENANT}', 'pharmacy_admin', true),
    ('${STRANGER}', '${OTHER_TENANT}', 'pharmacy_admin', true);
`)

await db.exec(readFileSync(join(ROOT, 'supabase/migrations/20261120120000_personal_wearables_owner_private.sql'), 'utf8'))

const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
  } catch (err) {
    results.push({ name, ok: false, err: err?.message ?? String(err) })
  }
}

async function as(role, sub, sql, params = []) {
  await db.exec('reset role')
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [sub ?? ''])
  await db.exec(`set role ${role}`)
  try {
    return await db.query(sql, params)
  } finally {
    await db.exec('reset role')
  }
}

async function refused(promise) {
  try {
    const res = await promise
    return { refused: false, affected: res.affectedRows ?? res.rows?.length ?? 0 }
  } catch (err) {
    return { refused: true, message: err.message }
  }
}

// Owner writes through RLS as an authenticated client.
await check('owner can record consent and readings', async () => {
  await as('authenticated', OWNER, `insert into public.personal_wearable_connections (owner_profile_id, provider, scopes, consent_version) values ($1, 'health_connect', '{steps}', 'v1')`, [OWNER])
  await as('authenticated', OWNER, `insert into public.personal_wearable_daily (owner_profile_id, provider, metric, day, value, unit) values ($1, 'health_connect', 'steps', '2026-11-18', 9000, 'count')`, [OWNER])
  const own = await as('authenticated', OWNER, 'select value from public.personal_wearable_daily')
  assert.deepEqual(own.rows.map((r) => Number(r.value)), [9000])
})

await check('same-facility admin sees none of the staff member’s readings', async () => {
  const rows = await as('authenticated', ADMIN, 'select * from public.personal_wearable_daily')
  assert.equal(rows.rows.length, 0)
  const byId = await as('authenticated', ADMIN, 'select * from public.personal_wearable_daily where owner_profile_id = $1', [OWNER])
  assert.equal(byId.rows.length, 0)
  const conn = await as('authenticated', ADMIN, 'select * from public.personal_wearable_connections')
  assert.equal(conn.rows.length, 0)
})

await check('same-facility admin cannot update or delete them', async () => {
  const upd = await as('authenticated', ADMIN, `update public.personal_wearable_daily set value = 1 where owner_profile_id = $1`, [OWNER])
  assert.equal(upd.affectedRows, 0)
  const del = await as('authenticated', ADMIN, `delete from public.personal_wearable_daily where owner_profile_id = $1`, [OWNER])
  assert.equal(del.affectedRows, 0)
  const still = await as('service_role', null, 'select value from public.personal_wearable_daily where owner_profile_id = $1', [OWNER])
  assert.deepEqual(still.rows.map((r) => Number(r.value)), [9000])
})

await check('admin cannot write readings or consent in a staff member’s name', async () => {
  const conn = await refused(as('authenticated', ADMIN, `insert into public.personal_wearable_connections (owner_profile_id, provider, scopes, consent_version) values ($1, 'healthkit', '{steps}', 'v1')`, [OWNER]))
  assert.equal(conn.refused, true, 'consent insert for another owner must be refused')
  const daily = await refused(as('authenticated', ADMIN, `insert into public.personal_wearable_daily (owner_profile_id, provider, metric, day, value, unit) values ($1, 'health_connect', 'steps', '2026-11-17', 1, 'count')`, [OWNER]))
  assert.equal(daily.refused, true, 'reading insert for another owner must be refused')
})

await check('admin cannot move their own rows onto the staff member', async () => {
  await as('authenticated', ADMIN, `insert into public.personal_wearable_connections (owner_profile_id, provider, scopes, consent_version) values ($1, 'health_connect', '{steps}', 'v1')`, [ADMIN])
  const moved = await refused(as('authenticated', ADMIN, `update public.personal_wearable_connections set owner_profile_id = $1 where owner_profile_id = $2`, [OWNER, ADMIN]))
  assert.equal(moved.refused, true)
})

await check('another facility sees nothing', async () => {
  const rows = await as('authenticated', STRANGER, 'select * from public.personal_wearable_daily')
  assert.equal(rows.rows.length, 0)
})

await check('anon has no access at all', async () => {
  const read = await refused(as('anon', null, 'select * from public.personal_wearable_daily'))
  assert.equal(read.refused, true)
  const write = await refused(as('anon', null, `insert into public.personal_wearable_connections (owner_profile_id, provider, consent_version) values ($1, 'health_connect', 'v1')`, [OWNER]))
  assert.equal(write.refused, true)
})

await check('authenticated without a subject sees nothing', async () => {
  const rows = await as('authenticated', null, 'select * from public.personal_wearable_daily')
  assert.equal(rows.rows.length, 0)
})

await check('withdrawing consent deletes the readings (cascade)', async () => {
  await as('authenticated', OWNER, `delete from public.personal_wearable_connections where provider = 'health_connect'`)
  const left = await as('service_role', null, 'select count(*)::int as n from public.personal_wearable_daily where owner_profile_id = $1', [OWNER])
  assert.equal(left.rows[0].n, 0)
})

await check('deleting the profile deletes everything', async () => {
  await as('service_role', null, `delete from public.profiles where id = $1`, [ADMIN])
  const left = await as('service_role', null, 'select count(*)::int as n from public.personal_wearable_connections where owner_profile_id = $1', [ADMIN])
  assert.equal(left.rows[0].n, 0)
})

console.log('engine: PGlite (PostgreSQL in WASM); policies evaluated under SET ROLE + request.jwt.claim.sub')
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.err}`}`)
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
