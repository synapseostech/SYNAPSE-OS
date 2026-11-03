# Pharmacy tenant isolation — audit and repair

Date: 2026-11-01
Scope: every pharmacy row-security policy, the account columns that decide who
may act, the security-definer functions those policies call, the API
authorisation layer above them, and the storage bucket the cut-over uses.

This is the record of what was found and what was changed. It is not a
readiness claim. **No database-backed assertion in this document was executed**
— see [§7](#7-what-was-not-executed).

---

## 1. How access actually works here

The pharmacy portal does not use Supabase Auth for sign-in. It uses Synapse's
custom auth, so for an ordinary portal session `auth.uid()` is `NULL` in
PostgREST. Every portal read and write therefore goes through the service-role
client, and row security does not apply to it at all.

That makes application-level authorisation the primary control, and row
security a **second layer** for the population that does carry a Supabase JWT.
`same_tenant()`'s own comment says as much. Both layers are audited below, and
the distinction matters when reading the findings: a defect in RLS is not
automatically a live vulnerability for a portal user, but it is one for any
Supabase-Auth JWT holder, and it is one the moment anything changes about how
sessions are minted.

### The application layer held up

| Control | File | Verdict |
|---|---|---|
| Tenant never taken from body/query | `apps/pharmacy/lib/api-auth.ts` (`requirePharmacyTenant`) | Sound — derives the tenant from the session only, and requires `facilityType === 'pharmacy'` |
| Platform routes separated | `apps/pharmacy/lib/api-auth.ts` (`requirePlatformAdmin`) | Sound — checks `PLATFORM_ROLES` and `facilityType === 'platform'` |
| Workspace switch honours only real memberships | `packages/auth/src/session-scope.ts` | Sound — an explicit tenant is accepted only with an *active* `staff_scope_assignments` row or an *active* `pharmacy_user_settings` row; a read error is a denial |
| Deactivated staff refused | `apps/pharmacy/lib/auth.ts` (`toPharmacySession`) | Sound — returns `null` when `pharmacy_user_settings.is_active === false`, on every request, whichever login path minted the session |
| Multi-pharmacy staff | `session-scope.ts` + `workspaces.ts` | Sound at the session layer |

---

## 2. Findings

### F1 — Anonymous read of every pending pharmacy invitation (HIGH)

`supabase/bootstrap/canonical_public_schema.sql:22783`

```sql
CREATE POLICY "public_invite_lookup" ON "public"."pharmacy_onboarding"
  FOR SELECT USING ((current_step = 0) AND (invite_expires_at > now()));
```

No `TO` clause, so the policy applies to `PUBLIC`; the table is also granted to
`anon` (`:25757`). The row carries `invite_token`, `admin_email`, `admin_name`
and `tenant_id`. Anyone holding the public anon key could list every pharmacy
awaiting onboarding and redeem another pharmacy's invitation.

Every reader of `pharmacy_onboarding` — `apps/pharmacy/app/invite/[token]/actions.ts`,
`apps/web/src/app/invite/[token]/page.tsx`, `apps/pharmacy/app/api/onboarding/route.ts`,
`apps/pharmacy/app/api/auth/register/route.ts` and
`apps/web/src/app/api/mobile/pharmacy/onboarding/route.ts` — uses `supabaseAdmin`.
The policy protected no flow and only widened exposure.

### F2 — Deactivated and deleted accounts kept row-security access (HIGH)

`current_tenant_id()` (`:1294`) reads `profiles.tenant_id` and consults neither
`profiles.is_deleted` nor `pharmacy_user_settings.is_active`. So a stale JWT
kept reading its tenant after the account was archived or the staff row switched
off. The application layer refuses those requests (F1 table above); RLS did not.
`custom_access_token_hook` (`:1305`) had the same gap and would re-mint the
tenant claim from a deleted profile on every token refresh.

`is_platform_admin()` (`:1911`) also ignored `is_deleted`, so an archived
platform administrator kept the platform bypass that every adopted policy calls.

### F3 — Membership was one pointer, not a set (HIGH)

`current_tenant_id()` returns at most one tenant. The canonical model is a set:
`pharmacy_user_settings` has one row per pharmacy a person works at
(`:9292` area, `tenant_id NOT NULL`), and `staff_scope_assignments` adds active
assignments at other facilities. The application's workspace switch already
honours this; RLS did not.

Two consequences, both real:

- a pharmacist working at a second pharmacy read nothing there under RLS;
- an `is_active = false` staff row withdrew nothing, because nothing read it.

### F4 — Twenty-seven policies defaulted to `PUBLIC`, i.e. `anon` (MEDIUM)

A policy without `TO` applies to `PUBLIC`. Several of those policies call
helpers whose `EXECUTE` is revoked from `anon`, so an anonymous query failed
with a permission error rather than returning rows — fail-closed, but an error
an anonymous caller can provoke, and one policy (F1) failed open. The full list
is pinned in `scripts/pharmacy-policy-tenant-scope.test.mjs`.

### F5 — Two row-secured tables had no policy at all (MEDIUM)

`pharmacy_receipt_reprints` (`:21745`) and `pharmacy_sale_idempotency`
(`:21755`) have `ENABLE ROW LEVEL SECURITY` and zero policies: every
non-service-role read was denied, and nothing documented that this was intended.

### F6 — Four policies resolved tenancy through an inline `profiles` subquery (MEDIUM)

`pharmacy_admin_own`, `pharmacy_user_update_onboarding`, `tenant_pharmacy_orders`
and the `platform_admin_*` policies each embedded their own
`SELECT ... FROM profiles WHERE id = auth.uid()`. Four independent
implementations of one question, none of them consulting `is_deleted`, and all
of them single-tenant.

### F7 — A JWT subject could promote itself to platform administrator (HIGH)

`profiles_update_own_or_platform` (`:22764`) permits a caller to update the row
whose `id` is their own JWT subject, and constrains no columns. `role`,
`is_admin`, `platform_control_role`, `tenant_id` and `is_deleted` are all on
that row, and `is_platform_admin()` reads `role`. So:

```sql
update profiles set role = 'platform_admin' where id = auth.uid();
```

would satisfy every platform bypass in the schema, including all the pharmacy
policies repaired by PR-011 — one statement defeating the entire cross-tenant
model. `profiles_insert_own_or_platform` had the same shape for a brand-new row.

The portal does not go through this path: it writes `profiles` with the service
role, and no browser component updates the table (`apps/web/src/app/admin/staff/page.tsx`,
`apps/web/src/app/onboarding/page.tsx` and the rest read a `hospital_id` and
then query the table they care about). The guard is aimed at exactly the token
holder RLS exists to contain.

### F8 — `pharmacy_assert_actor` accepted a deleted profile (LOW)

Its `profiles` fallback (`:2024`) checked `tenant_id` only. When a
`pharmacy_user_settings` row existed the activation flag *was* enforced.

### Constraints found while repairing — not defects

- `complete_pharmacy_sale` must **not** assert that the actor's tenant matches
  `p_tenant_id`. `apps/web/src/app/hospital/pharmacy/dispense/route.ts:180`
  calls it with the *clinician's* id and the *pharmacy's* tenant, a legitimate
  cross-tenant call by design. Adding the assertion would break hospital
  dispensing. The caller re-derives the tenant from the session, and pharmacy
  sessions are already refused for deactivated staff in `lib/auth.ts`.
- All pharmacy mutation RPCs (`complete_pharmacy_sale`, the refund/stock RPCs,
  `pharmacy_assert_actor`) are `REVOKE ALL ... FROM PUBLIC` and granted only to
  `service_role`, so there is no authenticated PostgREST path to them. Verified
  by `scripts/pharmacy-rpc-coverage.test.mjs` and re-asserted in the DB suite.
- The `pharmacy-imports` storage bucket is private and carries no policy, so
  `anon` and `authenticated` are denied outright. Uploads and downloads use
  server-issued signed URLs scoped to the tenant path
  (`apps/pharmacy/lib/tally/storage.ts`). Denial is the intended state.
- `pharmacy_inventory_summary` is a `security_invoker` view, so it inherits the
  caller's policies rather than the owner's.

---

## 3. Repairs

Both files are **prepared only**. Neither has been applied anywhere.

### `supabase/migrations/20261102130000_pharmacy_tenant_access_hardening.sql`

1. `public.pharmacy_caller_tenants()` returns the set of pharmacy tenants the
   caller may act in: `profiles.tenant_id` when the profile is not deleted,
   every active `pharmacy_user_settings.tenant_id`, every active
   `staff_scope_assignments.tenant_id`, and the tenant behind any active
   site-scoped assignment — **minus** any tenant whose staff row is explicitly
   `is_active = false`. `SECURITY DEFINER`, `search_path = public`, `REVOKE`
   from `PUBLIC`, `GRANT` to `authenticated` and `service_role`.
2. `current_tenant_id()`, `is_platform_admin()` and `custom_access_token_hook`
   exclude deleted profiles.
3. `pharmacy_assert_actor` reads the staff row first and refuses a deactivated
   actor, then falls back to a non-deleted member profile.
4. `public_invite_lookup` is dropped and `anon` is revoked on
   `pharmacy_onboarding`.
5. A `do`-loop rewrites all 48 pharmacy policies — 29 named pairs, 4 generic
   `tenant_isolation` tables — to `TO authenticated` with the
   `pharmacy_caller_tenants()` predicate on both `USING` and `WITH CHECK`, and
   the four inline-subquery policies and the two `_via_parent` policies are
   rewritten explicitly.
6. New tenant policies on `pharmacy_receipt_reprints` and
   `pharmacy_sale_idempotency`.
7. A fail-closed self-check that aborts on: an expected policy missing, any
   pharmacy policy still reachable by `anon`/`PUBLIC`, any policy still testing
   `is_admin`, `same_tenant`, `current_tenant_id` or a literal
   `'platform_admin'`, a missing helper, or `anon` holding `EXECUTE` on it.

### `supabase/migrations/20261102130100_profiles_privileged_column_guard.sql`

A `BEFORE INSERT OR UPDATE` trigger on `profiles` that refuses a change to
`role`, `is_admin`, `platform_control_role`, `tenant_id`, `is_deleted`,
`verification_status`, `hospital_id` or `department_id` unless the request
carries no user JWT (service role, migration, seed) or the caller is a platform
administrator. Self-checks that the trigger is attached.

---

## 4. Static evidence that was executed

```
node --test scripts/pharmacy-policy-tenant-scope.test.mjs      → 15/15 pass
npm run test:migration-integrity                               → 41/41 pass
npm run db:check                                               → 209 migration files OK, exit 0
npm run db:history:check                                       → exit 0
```

`scripts/pharmacy-policy-tenant-scope.test.mjs` replays the snapshot and every
migration in filename order and resolves each policy's effective definition —
it now understands `ALTER POLICY` and the `do`-loop's generated statements,
which the previous version could not see. It asserts, over the replayed state,
that all 48 pharmacy policies are `TO authenticated`, that none resolves
identity outside `pharmacy_caller_tenants()` / `is_platform_admin()`, and that
only `public_invite_lookup` was dropped.

A static test proves the migration text, not the database.

---

## 5. What the database suite now covers

`apps/pharmacy/lib/pharmacy-rls-tenant-isolation.integration.test.ts` — 14
tests, all skipped in this environment.

| Scenario | Test |
|---|---|
| A cannot read B | "a tenant administrator sees only their own tenant's products" |
| A cannot modify B | "…cannot create a product in another tenant", "…cannot move a row into another tenant" |
| Admin of A cannot reach B | same, with `is_admin: true` on the fixture |
| Dual-pharmacy user gets only authorised records | "a pharmacist working at two pharmacies sees both, and nothing else", "…cannot write into a third pharmacy" |
| Deactivated staff | "a deactivated staff row withdraws access even though the home tenant still names the pharmacy" |
| Deleted profile | "an archived profile loses its home tenant" |
| RPC cannot bypass tenant ownership | "an authenticated caller cannot execute a pharmacy mutation RPC" |
| Privilege escalation | "a JWT subject cannot promote itself to platform administrator" |
| Storage isolation | "a user JWT cannot read a stored import object" |
| Platform and anonymous paths | "a platform administrator keeps cross-tenant reach", "an anonymous caller reads no pharmacy rows" |

Positive cases are included alongside negative ones: an administrator can still
write inside their own tenant, and a two-pharmacy pharmacist still sees both.

---

## 6. Migration ordering and replay

- `20261102120000` (PR-011) is assumed to have run first; the hardening file
  does not depend on it for correctness — it re-alters every policy including
  PR-011's nineteen — but the two files are consistent in intent.
- Both new files are written to be replay-safe: `create or replace function`,
  `drop policy if exists`, `drop trigger if exists before create trigger`, and
  `alter policy` over policies that must already exist.
- Every statement runs inside `begin; … commit;`, so a failed self-check rolls
  the whole file back rather than leaving a partial scope.
- Rollback is by restoring the prior function bodies and policy expressions from
  the canonical snapshot. There is no down migration, consistent with the rest
  of `supabase/migrations/`.

---

## 7. What was not executed

This environment has no PostgreSQL engine: no `postgres`, `initdb` or `pg_ctl`
executable, nothing listening on 5432, the Docker socket is denied, and npm
egress to `registry.npmjs.org` is refused. Every DB-backed assertion above is
therefore **not executed**. The suite skips, and a skip is not evidence.

To execute it, someone with a disposable database must:

1. replay `supabase/bootstrap/canonical_public_schema.sql`, then every migration
   after the snapshot cutoff, in filename order;
2. export `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` for that database;
3. run `npx vitest run apps/pharmacy/lib/pharmacy-rls-tenant-isolation.integration.test.ts`
   and report the count of passing tests — not the count of skipped ones.

Until that run exists, every isolation requirement in this document is
**NOT TESTED**, whatever the static contracts say.
