A5 is confirmed as a bootstrap defect, not a migration defect. Do not add a migration and do not weaken the assertion.

Root cause: `scripts/db-reset-fresh.sh:33` grants anon EXECUTE by default on every function created afterwards, and it runs before the snapshot is applied. `ALTER DEFAULT PRIVILEGES` attaches an ACL entry to each function created by that role; the snapshot's `REVOKE ALL ... FROM PUBLIC` is a separate entry and does not remove anon's. The snapshot itself grants `current_tenant_id()` only to `authenticated` and `service_role`.

1. In `scripts/db-reset-fresh.sh`, drop `anon` from the FUNCTIONS default-privilege line only:
   `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, authenticated, service_role;`
   Leave the TABLE and SEQUENCE defaults unchanged. Explicit `GRANT ... TO "anon"` statements in the snapshot still apply, so nothing anon legitimately needs is lost.

2. Rebuild the disposable stack from scratch with the same `db-acceptance` recipe and re-run the A1–A5 assertions. Add two more, and show the SQL:
   - `select has_function_privilege('anon', 'public.current_tenant_id()', 'EXECUTE');` → false
   - `select has_function_privilege('anon', 'public.adjust_pharmacy_batch_stock(uuid,uuid,integer,text,text,uuid,uuid,text,date,numeric,text)', 'EXECUTE');` → false, and the same call for `authenticated` → true
   Then re-run `scripts/db-tests/rls-tenant-isolation.sql` on that build.

3. Add a static test that pins the FUNCTIONS default-privilege line so a future edit cannot silently re-grant anon. It must fail if `anon` appears in that line.

4. Record the finding in the closure report as a new item: fresh and CI databases were granting anon EXECUTE on every function created by the snapshot, including service_role-only RPCs, so ACL assertions from `db-acceptance` are not evidence about production until this fix lands. State that by construction, not as a suspicion, and state how you verified it.

5. If the narrowed default breaks a local dev or test flow, report the failing flow and stop. Do not re-add the grant to make it pass; that flow would fail against production for the same reason.

Two documentation fixes while you are there:
- `REMEDIATION_HANDOVER_2026-10-25.md` Part 4 said "38 tests, 38 pass" while `evidence.json` records 44; I have already corrected that line to 44 with the reason. Do not re-introduce 38.
- `artifacts/readiness/evidence.json` records `porcelainCount: 73` but the tree ended at 74, because evidence was collected before the last files were written. Collect evidence as the final step of a run, or drop `porcelainCount` from the file — it is inherently unstable and nothing pins it.
