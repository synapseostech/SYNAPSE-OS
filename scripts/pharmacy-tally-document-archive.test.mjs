import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * pharmacy-tally-document-archive.test.mjs — static contract for the archive
 * tables in docs/pharmacy/TALLY_DOCUMENT_CHAIN_DESIGN.md §5.
 *
 * The archive must be readable and not writable: a document imported from
 * Tally's history can never be edited, deleted or fed back into a Synapse
 * workflow. That guarantee lives in the grant matrix and the absence of a
 * write policy, so this file asserts both rather than trusting the comments.
 *
 * It also pins the ordering constraint between it and the tenant reset: the
 * archive references `pharmacy_import_sessions` with ON DELETE RESTRICT, so
 * the purge has to clear the archive first or the reset fails.
 *
 * These are static assertions over the migration text. They do not prove the
 * migration applies, that the policies behave, or that RLS denies anything —
 * that needs the disposable-database run, which has not been performed. Do
 * not read a pass here as behavioural evidence.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const MIGRATIONS_DIR = "supabase/migrations"
const ARCHIVE = "20261104130000_pharmacy_tally_document_archive.sql"
const PURGE = "20261104120000_pharmacy_tenant_purge.sql"

const read = (path) => readFileSync(join(root, path), "utf8")
const archive = read(join(MIGRATIONS_DIR, ARCHIVE))
const purge = read(join(MIGRATIONS_DIR, PURGE))

const TABLES = [
  "pharmacy_tally_documents",
  "pharmacy_tally_document_lines",
  "pharmacy_tally_document_imports",
]

// Every statement, so assertions can talk about one policy or grant at a time
// instead of matching across the whole file.
const statements = archive
  .split(/;\s*(?:\r?\n|$)/)
  // The file's section comments sit between statements, not inside them, so
  // dropping leading comment and blank lines leaves the statement itself.
  .map((text) => text.replace(/^(?:[ \t]*--.*(?:\r?\n|$)|[ \t]*(?:\r?\n|$))+/, "").trim())
  .filter(Boolean)

const statementMatching = (pattern) => statements.filter((text) => pattern.test(text))

function policyFor(table) {
  const found = statementMatching(
    new RegExp(`^create policy\\b[\\s\\S]*\\bon public\\.${table}\\b`),
  )
  return found
}

test("the migration creates each of the three tables exactly once", () => {
  for (const table of TABLES) {
    const creates = statementMatching(
      new RegExp(`^create table if not exists public\\.${table}\\b`),
    )
    assert.equal(creates.length, 1, `expected one CREATE TABLE for ${table}`)
  }
})

test("every archive table has row level security enabled", () => {
  for (const table of TABLES) {
    assert.match(
      archive,
      new RegExp(`alter table public\\.${table} enable row level security`),
      `${table} must have RLS enabled`,
    )
  }
})

test("no application role keeps a write grant", () => {
  const writeGrants = statementMatching(
    /^grant\s+(?:all|insert|update|delete|truncate)\b[\s\S]*\bto\s+(?:public|anon|authenticated)\b/,
  )
  assert.deepEqual(writeGrants, [], "the archive must not be writable by anon or authenticated")

  for (const table of TABLES) {
    assert.match(
      archive,
      new RegExp(`revoke all on public\\.${table} from public, anon, authenticated`),
      `${table} must revoke the default grants`,
    )
  }
})

test("authenticated may read documents and lines, and nothing else", () => {
  for (const table of ["pharmacy_tally_documents", "pharmacy_tally_document_lines"]) {
    assert.match(
      archive,
      new RegExp(`grant select on public\\.${table} to authenticated`),
      `${table} must be readable by authenticated`,
    )
  }

  assert.doesNotMatch(
    archive,
    /grant select on public\.pharmacy_tally_document_imports to authenticated/,
    "the apply checkpoint is machinery, not a document",
  )
})

test("the service role is the only writer", () => {
  for (const table of TABLES) {
    assert.match(
      archive,
      new RegExp(`grant select, insert, update, delete on public\\.${table} to service_role`),
      `${table} must be writable by the service role`,
    )
  }
})

test("the document tables carry one SELECT-only tenant policy each", () => {
  for (const table of ["pharmacy_tally_documents", "pharmacy_tally_document_lines"]) {
    const policies = policyFor(table)
    assert.equal(policies.length, 1, `expected one policy on ${table}`)
    const policy = policies[0]
    assert.match(policy, /\bfor select\b/, `${table}'s policy must be SELECT-only`)
    assert.match(policy, /\bto authenticated\b/, `${table}'s policy must be scoped to authenticated`)
    assert.match(policy, /tenant_id = any \(public\.pharmacy_caller_tenants\(\)\)/)
    assert.match(policy, /public\.is_platform_admin\(\)/)
  }
})

test("the checkpoint table has no policy at all", () => {
  assert.deepEqual(policyFor("pharmacy_tally_document_imports"), [])
})

test("a line cannot belong to a different tenant than its document", () => {
  assert.match(
    archive,
    /foreign key \(document_id, tenant_id\)\s+references public\.pharmacy_tally_documents \(id, tenant_id\)\s+on delete cascade/,
  )
  assert.match(
    archive,
    /constraint pharmacy_tally_documents_id_tenant_key unique \(id, tenant_id\)/,
    "the composite foreign key needs this unique constraint to point at",
  )
})

test("the apply is idempotent on the document's own identity", () => {
  assert.match(
    archive,
    /constraint pharmacy_tally_documents_identity_key\s+unique \(tenant_id, company_key, source_key\)/,
  )
})

test("an import session that owns archived documents cannot vanish", () => {
  for (const constraint of ["pharmacy_tally_documents", "pharmacy_tally_document_imports"]) {
    assert.match(
      archive,
      new RegExp(
        `${constraint}[\\s\\S]*?session_id\\s+uuid not null references public\\.pharmacy_import_sessions\\(id\\) on delete restrict`,
      ),
      `${constraint}.session_id must be ON DELETE RESTRICT`,
    )
  }
})

test("every kind the classifier can produce is allowed by the check", () => {
  const kinds = [
    "sales",
    "purchase",
    "receipt",
    "payment",
    "contra",
    "journal",
    "credit_note",
    "debit_note",
    "order",
    "inventory_note",
    "stock_journal",
    "other",
  ]
  for (const kind of kinds) {
    assert.match(archive, new RegExp(`'${kind}'`), `voucher_kind check must allow ${kind}`)
  }
})

test("the restore/reset clears the archive before the sessions it references", () => {
  const linesIndex = purge.indexOf("array['pharmacy_tally_document_lines'")
  const documentsIndex = purge.indexOf("array['pharmacy_tally_documents'")
  const importsIndex = purge.indexOf("array['pharmacy_tally_document_imports'")
  const sessionsIndex = purge.indexOf("array['pharmacy_import_sessions'")

  assert.ok(linesIndex > 0, "the purge must delete archive lines")
  assert.ok(documentsIndex > linesIndex, "lines must go before the documents they belong to")
  assert.ok(importsIndex > documentsIndex, "the checkpoint goes after its documents")
  assert.ok(
    sessionsIndex > importsIndex,
    "the archive must go before pharmacy_import_sessions, or ON DELETE RESTRICT blocks the reset",
  )
})

test("the purge tolerates a table that has not been created yet", () => {
  assert.match(
    purge,
    /if to_regclass\(format\('public\.%I', v_table\)\) is null then/,
    "an unapplied archive migration must not break the reset",
  )
})

test("the archive is not referenced by any other migration", () => {
  const others = readdirSync(join(root, MIGRATIONS_DIR))
    .filter((file) => file.endsWith(".sql") && file !== ARCHIVE && file !== PURGE)
  const offenders = others.filter((file) =>
    read(join(MIGRATIONS_DIR, file)).includes("pharmacy_tally_document"),
  )
  assert.deepEqual(offenders, [], "the archive tables are created here and nowhere else")
})
