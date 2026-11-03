import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * pharmacy-rpc-coverage.test.mjs — every RPC the application calls must be
 * creatable from a source a fresh database is actually built from.
 *
 * A fresh database is built from `supabase/bootstrap/canonical_public_schema.sql`
 * (scripts/db-reset-fresh.sh explicitly does not replay supabase/migrations),
 * and CI builds from the two together. A function that exists only in a
 * production database — applied by hand, its migration recorded as a
 * `to_regprocedure(...) is not null` check — is invisible to both. Refunds and
 * manual stock adjustments then fail at runtime with "function does not exist"
 * in staging, DR and local, while production appears healthy.
 *
 * The matcher must accept both declaration styles this repo contains:
 * migrations write `create or replace function public.name(`, while the
 * canonical snapshot is a pg_dump and writes
 * `CREATE OR REPLACE FUNCTION "public"."name"(`. An earlier version of the
 * matcher only accepted the unquoted form, so every snapshot definition was
 * invisible to it and it reported defined RPCs as missing. The last test below
 * is the canary for that blind spot.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

function sourceFiles(dir, acc = []) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__tests__") continue
      sourceFiles(rel, acc)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      acc.push(rel)
    }
  }
  return acc
}

function calledRpcs() {
  const names = new Set()
  for (const file of [...sourceFiles("packages/db/src"), ...sourceFiles("apps/pharmacy")]) {
    const text = readFileSync(join(root, file), "utf8")
    for (const match of text.matchAll(/\.rpc\(\s*["'`]([a-z0-9_]+)["'`]/g)) {
      names.add(match[1])
    }
  }
  return names
}

function definitionSources() {
  const sql = []
  for (const dir of ["supabase/migrations", "supabase/bootstrap"]) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".sql")) {
        sql.push(readFileSync(join(root, dir, entry.name), "utf8"))
      }
    }
  }
  // Production's quarantined history is deliberately excluded: it is not a
  // build input, so a function that exists only there is still undefined.
  return sql.join("\n")
}

function defines(sql, name) {
  return new RegExp(`function\\s+(?:"?public"?\\s*\\.\\s*)?"?${name}"?\\s*\\(`, "i").test(sql)
}

test("the scan sees the RPC surface (guards against a vacuous pass)", () => {
  const names = calledRpcs()
  assert.ok(
    names.size >= 20,
    `expected to find the application's RPC calls, found ${names.size}: ${[...names].join(", ")}`,
  )
  assert.ok(names.has("complete_pharmacy_sale"), "the POS sale RPC must be in the scanned surface")
})

test("every called RPC is definable from the active migrations or the canonical snapshot", () => {
  const sql = definitionSources()
  const missing = [...calledRpcs()].filter((name) => !defines(sql, name))
  assert.deepEqual(
    missing,
    [],
    `these RPCs are called but no build input creates them: ${missing.join(", ")}. ` +
      "Add an additive migration (or refresh the canonical snapshot) — do not rely on the production database.",
  )
})

test("the matcher sees quoted, schema-qualified definitions (canary for a blind scan)", () => {
  const snapshot = readFileSync(join(root, "supabase/bootstrap/canonical_public_schema.sql"), "utf8")
  for (const name of ["complete_pharmacy_sale", "reverse_pharmacy_sale", "adjust_pharmacy_batch_stock"]) {
    assert.ok(
      defines(snapshot, name),
      `${name} is defined in the canonical snapshot but the matcher cannot see it; ` +
        "a scan that cannot see this declaration style reports defined functions as missing",
    )
  }
})
