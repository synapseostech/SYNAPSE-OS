# Audit Addendum 10 — 2026-10-24 (Isolated PostgreSQL install plan — review only, NOT executed)

Supplements the main report and Addenda 1–9. No package was installed, no system service was modified, and no production action was taken.

## 1. System facts (verified)

- OS: Linux Mint 22.3 "zena" (Ubuntu 24.04 base) → apt `postgresql` = **PostgreSQL 16**.
- Arch: `x86_64`; `/` has **373 GB free**; RAM 11 GiB (~2.8 GiB available); swap nearly full.
- No existing PostgreSQL server binaries, Docker, podman, nix, or snap.

## 2. Harness hardening (applied this pass)

`scripts/check-db-acl.integration.test.mjs` now enforces, before any SQL runs:

1. Explicit test-only URL (`ACL_INTEGRATION_URL`).
2. Rejects managed/production hosts (`qfqakzmjatszisuqjwon`, `supabase.co`, `amazonaws.com`, `neon.tech`).
3. Loopback-only (`127.0.0.1`/`localhost`/`::1`) unless `ACL_ALLOW_NONLOCAL=1`.
4. **Disposable database required**: the URL database name must contain `acl_test`, unless `ACL_DISPOSABLE_DB=1` — this prevents destructive `DROP FUNCTION`/role setup against a real database.

Results: `node --test scripts/check-db-acl.integration.test.mjs` → 2 guard tests pass, matrix skips (no URL), **EXIT 0**. Syntax check OK.

## 3. Minimal, reversible PostgreSQL install plan (for review)

**Package change (reversible):** `postgresql-16` + `postgresql-client-16`. Approx. disk footprint ≤ 150 MB total (packages ~60–70 MB; a throwaway data directory ~40 MB).

**Steps (not executed):**

```bash
# 1. Install binaries (package change; reversible via apt remove --purge)
sudo apt update
sudo apt install -y postgresql-16 postgresql-client-16

# 2. Remove the default system cluster/service that apt auto-creates
#    (keeps us service-free and loopback-only; reversible)
sudo pg_dropcluster 16 main --stop   # or: sudo systemctl stop postgresql

# 3. Create a throwaway data directory in /tmp (trust auth OK: loopback-only)
/usr/lib/postgresql/16/bin/initdb -D /tmp/synapse-pg --username=postgres \
  --auth=trust --auth-host=trust --no-instructions

# 4. Start manually on a loopback-only port (no systemd service)
/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/synapse-pg -l /tmp/synapse-pg.log \
  -o "-p 5433 -c listen_addresses=127.0.0.1" start

# 5. Create the disposable database
/usr/lib/postgresql/16/bin/createdb -h 127.0.0.1 -p 5433 -U postgres acl_test

# 6. Run the guarded integration matrix
ACL_INTEGRATION_URL='postgres://postgres@127.0.0.1:5433/acl_test' \
  node --test scripts/check-db-acl.integration.test.mjs

# 7. Cleanup (complete and reversible)
/usr/lib/postgresql/16/bin/pg_ctl -D /tmp/synapse-pg stop
rm -rf /tmp/synapse-pg /tmp/synapse-pg.log
sudo apt remove --purge -y postgresql-16 postgresql-client-16
sudo apt autoremove -y
```

**Safety properties of this plan:**
- `listen_addresses=127.0.0.1` and a non-default port (5433) keep it loopback-only.
- `trust` auth is used only on a throwaway `/tmp` cluster that is deleted afterward; no credentials are printed or persisted.
- No systemd service remains (the auto-created `main` cluster is dropped; our cluster runs via `pg_ctl`).
- The harness independently re-verifies loopback + disposable `acl_test` naming before touching anything.
- Fully reversible: stop the `/tmp` cluster, remove `/tmp/synapse-pg`, and purge the apt packages.

## 4. Status

- Package installation and service changes: **not executed** (awaiting review).
- Isolated integration matrix: **not run** (no server yet).
- Release workflow (`release.yml`) and its proposed diff: **unchanged**.
- Production readiness: **NOT READY** — live verification has not run against any real database.

## 5. Files changed this pass

- `scripts/check-db-acl.integration.test.mjs` — disposable-database guard + test.
- `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24_ADDENDUM_10.md` — this file.

No staging, committing, pushing, merging, deploying, migration application, or ACL changes were performed.
