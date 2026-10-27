import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * db-reset-fresh.test.mjs — pins the bootstrap's default-privilege grants so a
 * future edit cannot silently re-grant anon EXECUTE on every function the
 * canonical snapshot creates.
 *
 * The defect this guards (A5): `scripts/db-reset-fresh.sh` ran
 * `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO
 * postgres, anon, authenticated, service_role;` *before* applying the snapshot.
 * Default privileges attach an ACL entry to every function created afterwards
 * by the executing role, and the snapshot's `REVOKE ALL ... FROM PUBLIC` removes
 * only the PUBLIC pseudo-grant — not the anon entry. Fresh and CI databases
 * therefore gave anon EXECUTE on every snapshot function, including
 * service_role-only RPCs such as `adjust_pharmacy_batch_stock`.
 *
 * The remedy is the bootstrap, not a migration. This test fails if `anon`
 * reappears in the FUNCTIONS default-privilege GRANT line, if the idempotent
 * `REVOKE ... FROM anon` line is removed, and also pins that the TABLE and
 * SEQUENCE lines still grant to anon so nobody over-corrects all three.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const script = readFileSync(join(root, "scripts", "db-reset-fresh.sh"), "utf8")

test("FUNCTIONS default privileges do not grant to anon", () => {
  const line = script.match(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO[^;]*;/)
  assert.ok(line, "the FUNCTIONS default-privilege line must exist")
  assert.doesNotMatch(line[0], /\banon\b/, "the FUNCTIONS default-privilege line must not grant to anon")
  for (const role of ["postgres", "authenticated", "service_role"]) {
    assert.match(line[0], new RegExp(`\\b${role}\\b`), `the FUNCTIONS default-privilege line must grant to ${role}`)
  }
})

test("FUNCTIONS default privileges revoke anon, before and after the snapshot", () => {
  const revokes = script.match(/ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;/g)
  assert.ok(revokes, "the FUNCTIONS default-privilege REVOKE FROM anon line must exist")
  assert.ok(revokes.length >= 2, "the REVOKE must run before the snapshot (for the snapshot's own functions) and again after it (the snapshot re-grants anon at canonical_public_schema.sql:26325)")
})

test("TABLE and SEQUENCE default privileges still grant to anon", () => {
  const tables = script.match(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO[^;]*;/)
  const seqs = script.match(/ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO[^;]*;/)
  assert.ok(tables, "the TABLES default-privilege line must exist")
  assert.ok(seqs, "the SEQUENCES default-privilege line must exist")
  for (const line of [tables[0], seqs[0]]) {
    assert.match(line, /\banon\b/, "the TABLE/SEQUENCE default-privilege lines must still grant to anon")
  }
})
