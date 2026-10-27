# Next run — four tasks, in this order

Gate status: A1–A5 pass on a chain-built database; the harness passes; every regression suite is green. Two gate items remain and they are human inputs, not engineering: an authorised read-only target for the NULL preflight with a named sign-off, and O2/O3. Job B stays unstarted. The tasks below are the ones that need nothing from the owner except, in task 1, a URL.

## 1. Make the NULL preflight runnable in one command, and refuse to be dangerous

Write `scripts/db-tests/run-nulls-preflight.sh`:

- Require `SYNAPSE_PREFLIGHT_DATABASE_URL`; exit 2 with a clear message if it is unset.
- Refuse to run if the URL contains `qfqakzmjatszisuqjwon` (the linked production ref in `db:link`) or if `PGHOST` resolves to anything reachable as a production host. Print the host, never the credentials.
- Open the session with `SET default_transaction_read_only = on;` and run `scripts/db-tests/nulls-preflight.sql` under `-X -v ON_ERROR_STOP=1`.
- Tee the output to `artifacts/readiness/nulls-preflight-<UTC timestamp>.log` and exit non-zero if the log does not contain both result sets.
- Add a header to the log naming the target host, the role, `transaction_read_only`, and the timestamp, so the evidence is self-describing.

Then, only if a target exists, run it and record the per-table counts. Do not run it against anything else. If no target exists, stop after the script and its self-test — the script is the deliverable.

## 2. Prove the bootstrap fix propagated to the whole function surface

The two spot checks ( `current_tenant_id`, `adjust_pharmacy_batch_stock` ) show the fix works for the two symbols that mattered. That is not the same as showing the function surface now matches the snapshot. On a freshly built disposable stack, assert:

- For every function the snapshot grants to `service_role`, `has_function_privilege('anon', oid, 'EXECUTE')` is false. The snapshot has 68 such grants; report the count you actually evaluated.
- For every function the snapshot grants explicitly to `anon` (49 of them), the same call is true. Any that are false is an under-grant the bootstrap has now introduced.
- Report, separately, how many `public` functions are executable by `anon` only via the PostgreSQL `PUBLIC` default, because those are neither explicitly granted nor explicitly revoked. This is pre-existing and matches production, so it is a known quantity, not a new finding — but state the number so nobody has to guess later.

Wire this as SQL assertions in the chain-build script so it re-runs with every chain build, not as a one-off query. Report the three counts and any mismatch by name.

## 3. Replace the prose counts with a generated block

`collect-evidence.mjs` should own the figures. Add a delimited block to both audit documents:

```
<!-- evidence:begin -->
<!-- evidence:end -->
```

The collector rewrites everything between those markers from `evidence.json` and writes nothing else. `evidence-drift.test.mjs` asserts the block matches the file exactly. Then delete the hand-written pass counts from the surrounding prose, keeping the historical sentences in §10 (they are history, not current figures, and must survive).

Do not reintroduce a regex that scans prose for stale numbers. That is what forced the deletion of real history last time.

## 4. Read-only interoperability inventory (allowed behind the gate; writing is not)

Confirm or refute, from code and schema with file:line citations, and produce a single evidence table in `docs/architecture/INTEROP_BASELINE_2026-10-25.md`:

- `synapse_adapters` exists and has zero references outside SQL.
- No outbox relay worker exists for `domain_events`.
- The FHIR surface is read-only and cookie-authenticated only.
- DHIS2 export exists and its drain is unscheduled.
- Tally support is CSV/JSON staging only and rejects `.xml`.
- No ALIS connector exists.

One page, no recommendations, no connector design, no code. This is the factual ground that Job B will be built on, and it can be verified now without assuming anything about the tenancy decisions.

## Do not

- Do not start B2 or B3, and do not write connector code.
- Do not add a migration to fix an ACL; the bootstrap is the right layer and it is already fixed.
- Do not apply anything to a remote, staging or linked database.
- Do not weaken an assertion or edit a document to make a gate pass.
