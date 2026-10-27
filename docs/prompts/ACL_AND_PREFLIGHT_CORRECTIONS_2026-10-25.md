# Corrections to the A5/ACL and NULL-preflight artefacts

Scope: two scripts produced in the last run, plus one figure that must be reconciled before it is written into any document. No migrations. No remote database. No changes to the tenancy decisions.

Everything below was verified by reading the tree; where a number is quoted it is measured, not inherited.

---

## 1. The anon-entry count does not reconcile — resolve it before pinning anything

The assertion reports **40** functions carrying an explicit `anon` ACL entry. The arithmetic from source says it should be **38**:

- `supabase/bootstrap/canonical_public_schema.sql` contains exactly **49** `GRANT ALL ON FUNCTION ... TO "anon";` lines (49 distinct signatures; 68 to `service_role`, 55 to `authenticated`; 68 `CREATE OR REPLACE FUNCTION`).
- `supabase/migrations/20261003150000_revoke_exposed_security_definer_functions.sql` loops over 11 `regprocedure` identities and executes `revoke execute on function %s from public, anon, authenticated`. All 11 are among the 49: `apply_encounter_amendment`, `custom_access_token_hook`, `has_patient_consent`, `has_feature`, `has_capability`, `current_staff_site_ids`, `is_platform_operator`, `auto_set_tenant_id`, `fn_sync_network_inventory`, `handle_new_user`, `handle_new_user_profile`.
- No post-cutoff migration grants a function to `anon` (checked: zero `GRANT ... ON FUNCTION ... TO anon` statements in the 24 files above `20260920190000`), and none drops or recreates any of the 49.
- `20261003160000` re-revokes `handle_new_user` and `handle_new_user_profile`, which is a no-op at that point.

So the expected figure is `49 − 11 = 38`. Two extra entries exist in the built database and nothing in the chain accounts for them.

**Do this.** Re-run the census on the chain-built database and print, by name, every function that carries an explicit `anon` entry and is *not* in the expected 38. Then classify each one:

- If it is an extension function created in `public` (the bootstrap creates `pg_trgm`, `vector`, `pgcrypto`, `uuid-ossp`), record it as such — the count then conflates the snapshot surface with the extension surface, and the assertion must be scoped by identity, not by "all functions in `public`".
- If it is anything else, that is a finding and it is reported as one.

Do not adjust the expected number to match the observed one. The 38 comes from source; 40 is the thing under suspicion.

---

## 2. `scripts/db-tests/assert-function-acl-surface.sql` — replace the bound with a pin

Current form cannot fail for the reason it claims to test:

- `if a_count > 60 then` — the true value is 38. A regression could remove up to 22 grants, or the bug could partially return, and 59 would still pass. This is a ceiling, not a proof.
- The "under-grant" loop is tautological: it iterates rows produced by `aclexplode(p.proacl) ... grantee = 'anon' AND privilege_type = 'EXECUTE'` and then asks `has_function_privilege('anon', oid, 'EXECUTE')`. An explicit grant implies the privilege. It can never fire.

Replace both with exact assertions over the identity set:

1. Build the expected list as a `VALUES`/`text[]` literal of the **38** signatures — every `"public"."name"(...)` from the snapshot's anon grants minus the 11 revoked in `20261003150000`. Quote it as `::regprocedure` and let a bad signature fail loudly.
2. Assert **set equality**: the set of functions in `public` with an explicit `anon` EXECUTE entry, intersected with the expected-38 set, equals the expected-38 set exactly. Any missing signature is an under-grant and is named. Extra anon entries *inside the expected set* are impossible by construction, so no second check is needed there.
3. Assert the **11 revoked** signatures are not anon-executable and carry no explicit anon entry. This is the A5 proof with a hard edge, not a spot check for two symbols.
4. Keep the two existing spot checks.
5. Keep reporting `service_role` entries, overlap, and `public_default_anon_exec` as NOTICEs — but report them, do not assert them, and label `public_default_anon_exec` as pre-existing and expected to match production.

State the arithmetic in the file header: `49 snapshot grants − 11 revoked in 20261003150000 = 38`. A reader in six months must be able to re-derive the pin without running anything.

Also confirm the step in `.github/workflows/deploy.yml` (currently line 132) runs *after* the post-cutoff migration loop on the same connection recipe, so the assertion sees the finished chain. It is wired only there — there is no `npm run` entry point, so the assertion is unreachable outside a chain build. That is acceptable if deliberate; say so in the README or the file header rather than leaving it implicit.

---

## 3. `scripts/db-tests/run-nulls-preflight.sh` — remove the `eval`, verify the read-only claim

Three defects, in severity order.

**(a) Shell injection and mangled credentials.** Lines 32–45 build an `eval` string from `node` output where each value is `JSON.stringify`d. `JSON.stringify` does not escape `$` or backticks inside double quotes, so a password containing either is expanded by the shell during `eval`; a password containing `$(...)` executes. Percent-decoding also happens before quoting, so encoded characters become live shell syntax.

Fix: stop constructing shell assignments. `psql` accepts a connection URI as its database argument and does its own URI parsing:

```bash
psql "$SYNAPSE_PREFLIGHT_DATABASE_URL" -X -v ON_ERROR_STOP=1 ...
```

If host/role/database are needed for the log header, read them back from the server rather than parsing them locally.

**(b) The log asserts a property nobody checked.** Line 70 writes `# transaction_read_only: on (default_transaction_read_only set at session start)` before any session exists, and nothing verifies it. If the `SET` silently fails, the log still claims read-only.

Fix: set it at connection time with `PGOPTIONS='-c default_transaction_read_only=on'`, and have the SQL open with:

```sql
do $$ begin
  if current_setting('transaction_read_only') <> 'on' then
    raise exception 'preflight aborted: session is not read-only (transaction_read_only=%)', current_setting('transaction_read_only');
  end if;
end $$;
```

Then write the header from `select current_database(), current_user, inet_server_addr()::text, inet_server_port(), current_setting('transaction_read_only')` — observed values, not intended ones.

**(c) The hosted-platform refusal is both too broad and not the right test.** Lines 49–54 refuse every `*.supabase.co` host. A staging database hosted on Supabase is a legitimate read-only target for this check, and the current rule blocks it; meanwhile the rule that actually matters is "not the production project", and the ref check on line 25 already handles the direct, pooler and direct-connection forms because it matches anywhere in the URL.

Fix: keep the production-ref refusal. Replace the blanket host rule with: if the host is a Supabase host, print the project ref for the operator to read, and require `SYNAPSE_PREFLIGHT_SIGNOFF` to be set to a non-empty string naming who authorised the target — record both in the log header. Refuse if the ref is absent and the host is a Supabase host, since a ref-free Supabase URL cannot be shown not to be production.

Also: the completeness check greps for the literal strings `null_tenant` and `orphaned_tenant_rows` in the log. That passes if either word appears in an error message. Require the query tags that `psql` prints for a real result set, or have the SQL end with a checksum-style marker line that is only emitted on success.

---

## 4. Do not do

- Do not change the expected 38 to 40.
- Do not add a migration to fix an ACL. The bootstrap is the layer, and it is already corrected at `scripts/db-reset-fresh.sh:39`.
- Do not run the preflight against anything unless `SYNAPSE_PREFLIGHT_DATABASE_URL` names an authorised read-only target with a named sign-off.
- Do not touch `docs/audits/*` until §1 is resolved — no document should quote a count that is currently off by two.
