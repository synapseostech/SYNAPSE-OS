# Audit Addendum 9 — 2026-10-24 (Isolated PostgreSQL environment: blocker, plan, harness hardening)

Supplements the main report and Addenda 1–8. No production connections, writes, migrations, ACL changes, or secrets. Nothing staged, committed, pushed, or deployed.

## 1. State

- Branch `integration/synapse-2026-10-09`, HEAD `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f`.
- `package.json` still declares `"pg": "^8.23.1"` and the `test:db-acl` / `test:db-acl:strict` scripts (post external edit). A new untracked `docs/audits/` directory is preserved as-is.
- All pre-existing modifications and untracked files preserved.

## 2. Isolated environment — NOT provisionable from available tooling

Verified absent: `postgres`, `initdb`, `pg_ctl`, `pg_isready`, `psql`, `postgresql`, `docker`, `podman`, `nix`, `snap`; a filesystem scan of `/usr`, `/opt`, `/usr/local`, `/snap` found no PostgreSQL server binary. The global Supabase CLI (`~/.supabase/bin/supabase`) requires Docker for `supabase start`.

**Conclusion:** no suitable isolated PostgreSQL instance can be provisioned from tools already present, and installing a server (Docker or apt `postgresql`) is a system-level change that is not approved here. No production infrastructure or credentials were used.

## 3. Smallest reproducible setup plan (documented; requires approval to execute)

Requires PostgreSQL 15+ (16 recommended; the scanner uses `has_function_privilege`, `acldefault`, `split_part`, `unnest`, all available in PG 10+).

**Option A — Docker (preferred, minimal footprint):**

```bash
docker run --rm --name synapse-acl-test \
  -e POSTGRES_PASSWORD=testonly -e POSTGRES_DB=acl_test \
  -p 127.0.0.1:5432:5432 -d postgres:16

ACL_INTEGRATION_URL='postgres://postgres:testonly@127.0.0.1:5432/acl_test' \
  node --test scripts/check-db-acl.integration.test.mjs

docker rm -f synapse-acl-test   # cleanup
```

**Option B — local package (requires sudo/approval):** install `postgresql`, then `initdb -D /tmp/synapse-pg-test` + start on a loopback port, run the harness, then `pg_ctl stop` and remove `/tmp/synapse-pg-test`.

The harness creates only synthetic roles (`service_role`, `anon`, `authenticated`) and synthetic `public.receive_pharmacy_stock` overloads in the disposable database; it never touches production.

## 4. Harness hardening (task 4) — applied

`scripts/check-db-acl.integration.test.mjs` now:

- Requires the explicit test-only URL `ACL_INTEGRATION_URL`.
- Rejects managed/production hosts by marker (`qfqakzmjatszisuqjwon`, `supabase.co`, `amazonaws.com`, `neon.tech`).
- Requires a loopback host (`127.0.0.1`, `localhost`, `::1`) unless `ACL_ALLOW_NONLOCAL=1` is explicitly set.
- Never logs the URL or credentials.
- The matrix test calls the safety guard first, then runs the real `runLiveCheckFromUrl` path.

## 5. Test results (this pass)

| Command | Exit | Result |
|---|---|---|
| `node --check scripts/check-db-acl.integration.test.mjs` | 0 | syntax OK |
| `node --test scripts/check-db-acl.integration.test.mjs` (no URL) | 0 | guard test 1/1 pass; matrix **skipped** (no URL) |
| `node --test scripts/check-db-acl.test.mjs` | 0 | 20/20 passed (prior pass, unchanged) |

No real database connection was established, so **no end-to-end integration success is claimed**. The scanner’s live query has still not executed against PostgreSQL.

## 6. Release workflow (review only, unchanged)

The proposed `release.yml` diff (Addendum 8: `environment: production` + a `Strict live database ACL verification` step running `test:db-acl:strict` with the protected `DATABASE_ACL_URL` secret, placed before deployment actions) remains **unapplied**. The working-tree `release.yml` was not edited.

## 7. Files changed this pass

- `scripts/check-db-acl.integration.test.mjs` — added production-target/loopback safety guard + its unit test.
- `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24_ADDENDUM_9.md` — this file.

## 8. Remaining blockers and approvals

1. Approve a PostgreSQL server install (Docker, or apt `postgresql`) — the smallest step to enable the isolated integration run.
2. Then run the harness against the disposable loopback database and record per-case results.
3. Create the protected `DATABASE_ACL_URL` secret and apply the `release.yml` diff.
4. Return the production read-only SQL outputs.

## 9. Readiness

**Production remains NOT READY.** The live-verification path and its safety guards are implemented and unit-tested, but it has not executed against any real PostgreSQL database, the release gate is not enforced, and production evidence is outstanding.
