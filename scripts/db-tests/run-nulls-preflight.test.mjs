import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * run-nulls-preflight.test.mjs — pins the fail-closed behaviour of
 * scripts/db-tests/run-nulls-preflight.sh. Each case below exits before any
 * database connection is attempted, so these tests touch no network.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const script = join(root, "scripts", "db-tests", "run-nulls-preflight.sh")

function run(env) {
  const r = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  })
  return r
}

test("exits 2 with BLOCKED when the URL is unset", () => {
  const env = { ...process.env }
  delete env.SYNAPSE_PREFLIGHT_DATABASE_URL
  const r = run(env)
  assert.equal(r.status, 2)
  assert.match(r.stderr, /BLOCKED/)
})

test("exits 2 with REFUSED when the URL contains the linked production ref", () => {
  const r = run({
    SYNAPSE_PREFLIGHT_DATABASE_URL:
      "postgresql://user:pass@qfqakzmjatszisuqjwon.supabase.co:5432/postgres",
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /REFUSED/)
  assert.match(r.stderr, /qfqakzmjatszisuqjwon/)
})

test("exits 2 with REFUSED for a Supabase host carrying a project ref but no sign-off, and does not print the password", () => {
  const r = run({
    SYNAPSE_PREFLIGHT_DATABASE_URL:
      "postgresql://user:s3cr3t@abcdefghijklmnopqrst.supabase.co:5432/postgres",
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /REFUSED/)
  assert.match(r.stderr, /abcdefghijklmnopqrst/)
  assert.doesNotMatch(r.stderr, /s3cr3t/)
})

test("exits 2 with REFUSED for a ref-free Supabase host", () => {
  const r = run({
    SYNAPSE_PREFLIGHT_DATABASE_URL:
      "postgresql://user:pass@foo.supabase.co:5432/postgres",
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /REFUSED/)
  assert.match(r.stderr, /no project ref/)
})
