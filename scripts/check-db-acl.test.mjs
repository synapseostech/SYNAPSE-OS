import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  extractDefinerFunctions,
  publicExecuteGrants,
  functionsWithPossibleImplicitPublicExec,
  listSql,
  validateAclUrl,
  evaluateLiveAcl,
  runLiveCheckFromUrl,
  normalizeSignature,
  LIVE_ACL_SQL,
} from "./check-db-acl.mjs"

test("extracts SECURITY DEFINER function names", () => {
  const src = `create or replace function public.receive_pharmacy_stock(
  p uuid
) returns jsonb language plpgsql security definer set search_path to 'public'
as $$ begin return '{}'::jsonb; end $$;`
  assert.deepEqual(extractDefinerFunctions(src), ["public.receive_pharmacy_stock"])
})

test("detects explicit public/anon EXECUTE grants", () => {
  const src =
    "grant execute on function public.f(uuid) to public;\n" +
    "grant execute on function public.g(uuid) to anon;"
  assert.deepEqual(publicExecuteGrants(src), [
    { fn: "public.f", role: "public" },
    { fn: "public.g", role: "anon" },
  ])
})

test("flags definer functions never revoked from public/anon as possible implicit PUBLIC", () => {
  const files = [
    {
      name: "1_create.sql",
      source:
        "create function public.a(uuid) returns void language plpgsql security definer as $$ begin null; end $$;",
    },
    {
      name: "2_create_and_revoke.sql",
      source:
        "create function public.b(uuid) returns void language plpgsql security definer as $$ begin null; end $$;\n" +
        "revoke execute on function public.a(uuid) from public, anon;",
    },
  ]
  const flagged = functionsWithPossibleImplicitPublicExec(files)
  assert.deepEqual(flagged.map((x) => x.fn), ["public.b"])
})

test("listSql returns sorted migration files with sources", () => {
  const files = listSql()
  assert.ok(files.length > 0, "expected at least one migration file")
  const names = files.map((f) => f.name)
  assert.deepEqual(names, [...names].sort(), "migration files must be sorted")
  assert.ok(files.every((f) => f.name.endsWith(".sql") && typeof f.source === "string"))
})

test("treats revoke to authenticated-only as still possible implicit PUBLIC", () => {
  const files = [
    {
      name: "1.sql",
      source:
        "create function public.c(uuid) returns void language plpgsql security definer as $$ begin null; end $$;\n" +
        "revoke execute on function public.c(uuid) from authenticated;",
    },
  ]
  const flagged = functionsWithPossibleImplicitPublicExec(files)
  assert.deepEqual(flagged.map((x) => x.fn), ["public.c"])
})

test("revoke all on function also clears implicit PUBLIC", () => {
  const files = [
    {
      name: "1.sql",
      source:
        "create function public.d(uuid) returns void language plpgsql security definer as $$ begin null; end $$;\n" +
        "revoke all on function public.d(uuid) from public, anon, authenticated;",
    },
  ]
  assert.deepEqual(functionsWithPossibleImplicitPublicExec(files), [])
})

test("counts duplicate grants and tolerates malformed source", () => {
  const src =
    "grant execute on function public.f(uuid) to public;\n" +
    "grant execute on function public.f(uuid) to public;\n" +
    "not a grant statement;"
  assert.equal(publicExecuteGrants(src).length, 2)
})

test("--strict-live without DATABASE_ACL_URL exits nonzero without writing the artifact", () => {
  const res = spawnSync(process.execPath, ["scripts/check-db-acl.mjs", "--strict-live"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_ACL_URL: "" },
    encoding: "utf8",
  })
  assert.notEqual(res.status, 0, "strict-live with no live URL must fail")
  assert.match(res.stderr, /strict-live/)
})

// --- live ACL verification (dependency-injected, no database) ---

const GOOD = "receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)"

function safeRow(overrides = {}) {
  return {
    signature: GOOD,
    owner: "postgres",
    security_definer: true,
    search_path: "public",
    public_execute: false,
    anon_execute: false,
    authenticated_execute: false,
    service_role_execute: true,
    ...overrides,
  }
}

test("validateAclUrl accepts postgres/postgresql URLs and rejects others", () => {
  assert.throws(() => validateAclUrl(""), /ACL_URL_MISSING/)
  assert.throws(() => validateAclUrl("not a url"), /ACL_URL_INVALID/)
  assert.throws(() => validateAclUrl("mysql://u:p@h/db"), /ACL_URL_NOT_POSTGRES/)
  assert.equal(validateAclUrl("postgres://u:p@h:5432/db"), true)
  assert.equal(validateAclUrl("postgresql://u:p@h/db"), true)
})

test("evaluateLiveAcl passes a service-role-only overload", () => {
  const result = evaluateLiveAcl([safeRow()])
  assert.equal(result.ok, true, result.errors.join("; "))
})

test("evaluateLiveAcl fails on no rows (missing function)", () => {
  const result = evaluateLiveAcl([])
  assert.equal(result.ok, false)
  assert.match(result.errors.join(";"), /ACL_LIVE_NO_FUNCTIONS/)
})

test("evaluateLiveAcl audits multiple overloads and requires the 13-arg", () => {
  const eightArg = safeRow({ signature: "receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text)" })
  const result = evaluateLiveAcl([eightArg, safeRow()])
  assert.equal(result.ok, true, result.errors.join("; "))
  assert.equal(result.signatures.length, 2)

  const missingRequired = evaluateLiveAcl([eightArg])
  assert.equal(missingRequired.ok, false)
  assert.match(missingRequired.errors.join(";"), /MISSING_EXPECTED_OVERLOAD/)
})

test("evaluateLiveAcl fails on implicit PUBLIC EXECUTE", () => {
  const result = evaluateLiveAcl([safeRow({ public_execute: true })])
  assert.equal(result.ok, false)
  assert.match(result.errors.join(";"), /PUBLIC_EXECUTE/)
})

test("evaluateLiveAcl fails on anon or authenticated EXECUTE", () => {
  assert.match(evaluateLiveAcl([safeRow({ anon_execute: true })]).errors.join(";"), /ANON_EXECUTE/)
  assert.match(evaluateLiveAcl([safeRow({ authenticated_execute: true })]).errors.join(";"), /AUTHENTICATED_EXECUTE/)
})

test("evaluateLiveAcl fails when service_role cannot execute", () => {
  assert.match(evaluateLiveAcl([safeRow({ service_role_execute: false })]).errors.join(";"), /SERVICE_ROLE_NOT_EXECUTE/)
})

test("evaluateLiveAcl fails on unsafe owner, non-definer, or unsafe search_path", () => {
  assert.match(evaluateLiveAcl([safeRow({ owner: "attacker" })]).errors.join(";"), /UNSAFE_OWNER/)
  assert.match(evaluateLiveAcl([safeRow({ security_definer: false })]).errors.join(";"), /NOT_SECURITY_DEFINER/)
  assert.match(evaluateLiveAcl([safeRow({ search_path: "malicious" })]).errors.join(";"), /SEARCH_PATH_UNSAFE/)
  assert.match(evaluateLiveAcl([safeRow({ search_path: "attacker, public" })]).errors.join(";"), /SEARCH_PATH_UNSAFE/)
  assert.match(evaluateLiveAcl([safeRow({ search_path: "" })]).errors.join(";"), /SEARCH_PATH_MISSING/)
})

test("evaluateLiveAcl fails on an incomplete catalog row (omitted privilege column)", () => {
  const row = safeRow()
  delete row.public_execute
  const result = evaluateLiveAcl([row])
  assert.equal(result.ok, false)
  assert.match(result.errors.join(";"), /INCOMPLETE_ACL_ROW.*public_execute/)
})

test("normalizeSignature strips spaces and schema prefix", () => {
  assert.equal(
    normalizeSignature("public.receive_pharmacy_stock(uuid, uuid, text)"),
    "receive_pharmacy_stock(uuid,uuid,text)",
  )
})

test("runLiveCheckFromUrl fails closed on an unreachable DB and never leaks the URL or password", async () => {
  const secretUrl = "postgres://user:supersecret@127.0.0.1:1/db"
  let message = ""
  try {
    await runLiveCheckFromUrl(secretUrl)
  } catch (err) {
    message = String(err.message)
  }
  assert.ok(message.length > 0, "must fail closed")
  assert.ok(!message.includes("supersecret"), "must not leak the password")
  assert.ok(!message.includes(secretUrl), "must not leak the full URL")
})

test("LIVE_ACL_SQL checks effective privileges via role-name literals, not OIDs", () => {
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    assert.ok(
      LIVE_ACL_SQL.includes(`has_function_privilege('${role}'`),
      `missing has_function_privilege for role ${role}`,
    )
  }
  assert.ok(LIVE_ACL_SQL.includes("proname = 'receive_pharmacy_stock'"))
  assert.ok(LIVE_ACL_SQL.includes("prosecdef"))
  assert.ok(LIVE_ACL_SQL.includes("search_path="))
  assert.ok(!LIVE_ACL_SQL.includes("acldefault("), "implicit PUBLIC is covered by has_function_privilege('public', ...)")
})
