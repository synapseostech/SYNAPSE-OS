# Decision: production `public` default privileges (DO NOT implement)

**Date:** 2026-10-25
**Status:** Decision — remediation **deliberately not applied**. This memo is the
deliverable; it records the finding, the chosen remedy shape, and the
constraints that make implementation unsafe to bundle today.
**Scope:** the production project only (`qfqakzmjatszisuqjwon`). Nothing in this
memo was applied to any database, remote or local.

## 1. What production grants today

`supabase/bootstrap/canonical_public_schema.sql` is a `pg_dump` of production.
Its tail records the live default-privilege state:

- `:26315` `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"`
  `GRANT ALL ON SEQUENCES TO "postgres", "anon", "authenticated", "service_role"`
- `:26325` `… GRANT ALL ON FUNCTIONS TO "postgres", "anon", "authenticated", "service_role"`
- `:26335` `… GRANT ALL ON TABLES TO "postgres", "anon", "authenticated", "service_role"`

These are **defaults for objects `postgres` creates later** — additive grants, not
per-object ACLs. The FUNCTIONS default (specifically the `anon` line) is the A5
defect already resolved at the bootstrap root and pinned by
`scripts/db-tests/assert-function-acl-surface.sql`. The SEQUENCES and TABLES
defaults are still live in production and are the subject of this memo.

## 2. Why the FUNCTIONS default is fixed but TABLES is not

Functions are the escalation surface: a SECURITY DEFINER function runs as its
owner and bypasses RLS. The remediation was therefore correct to zero out the
`anon` FUNCTIONS default and revoke the exposed definers.

Tables are different. PostgREST does **not** grant table privileges per request;
it relies on the table-level privileges the connecting role already holds and
lets RLS narrow the rows. The `anon`/`authenticated` TABLE defaults are what make
every anonymous `/rest/v1/...` path work at all. Revoking them is not a security
fix — it is an availability change that removes the privilege RLS is layered on
top of. The actual security boundary for tables is, and remains, RLS.

## 3. Blast radius of revoking the TABLE default

Revoking `GRANT ALL ON TABLES … TO "anon"` would immediately break every
anonymous read path that currently succeeds because `anon` holds table-level
SELECT plus an RLS `USING` policy — for example facility directory lookups,
invitation-token resolution, and public master-data reads served through
PostgREST. `authenticated` removal would break the logged-in app surface the
same way. A full census of `anon`-reachable tables and their RLS policies is a
**prerequisite** to any such change; it has not been run, so the change must not
be made.

## 4. Remedy shape: migration, not operator DDL

If and when the census justifies it, the remedy must be a **versioned
`supabase/migrations` file**, not operator-issued `psql`:

- **Migration** — repeatable from an empty database, reviewable in the ledger,
  ordered against the other migrations, and re-run as a no-op in CI and local
  fresh builds. This is how `20261002180000` and `20261003150000` handled the
  function surface.
- **Operator DDL** — immediate but unrepeatable and unreviewable; it drifts from
  the migration ledger and from `canonical_public_schema.sql`, and it cannot be
  re-derived by a fresh build. Rejected.

## 5. Ordering constraint (non-negotiable)

The TABLE-default remediation must **not** share a change with the tenancy
policy repair (`20261025120000_tenant_isolation_policy_repair.sql`). They are
orthogonal: one changes object privileges, the other changes row policies. If
they ship together, a failure in either rolls back the other, and the resulting
half-state (policies repaired but privileges broken, or vice versa) is harder to
diagnose and harder to revert. Separate migrations, separate verification, in
either order — never the same change.

## 6. Verified check recorded for the record

No table is exposed today by the TABLE default beyond RLS. The post-cutoff
migrations that create tables without a literal `ENABLE ROW LEVEL SECURITY`
statement (11 tables total) all enable RLS and revoke over-broad grants through
dynamic loops:

- `20260921120000_pharmacy_purchases.sql` (loop at ~line 154): 5 tables.
- `20261022160000_pharmacy_accounting_ledger.sql` (loop at ~line 969): 6 tables.

Both loops `ENABLE ROW LEVEL SECURITY` and `REVOKE ALL … FROM public, anon,
authenticated` (the ledger also revokes `service_role` and re-grants narrow
SELECT). Every other table enables RLS literally. Confirmed by inspection; the
assertion suite (`scripts/db-tests/assert-function-acl-surface.sql` and the
`db-acceptance` gate) pins the function surface, not the table default.

## Decision

- **Do not revoke** the SEQUENCES/TABLES `anon` defaults in production.
- **Keep** the FUNCTIONS remediation as implemented (bootstrap root fix +
  revocations + ACL-surface assertion).
- **If** a future census justifies table-default tightening, it must be a
  standalone, repeatable migration, ordered apart from the tenancy policy
  repair, with the full blast-radius census in the same PR.
