import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

/**
 * pharmacy-refund-rpc-definitions.test.mjs — static contract for the two
 * privileged pharmacy RPCs the application calls.
 *
 * These assertions are not a substitute for executing the functions. They pin
 * the properties that a later edit could silently remove, and they compare the
 * SQL signature against the arguments the TypeScript wrapper actually sends, so
 * a rename on either side fails here instead of at runtime. The behavioural
 * proof lives in apps/pharmacy/lib/pharmacy-refund-rpc.integration.test.ts,
 * which runs only when a disposable database is configured.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const MIGRATION = "supabase/migrations/20261101090000_pharmacy_refund_and_adjust_rpcs.sql"
const RECEIVABLE_MIGRATION =
  "supabase/migrations/20261101120000_pharmacy_refund_receivable_reversal.sql"
const SNAPSHOT = "supabase/bootstrap/canonical_public_schema.sql"
const WRAPPER = "packages/db/src/inventory-rpc.ts"

const migration = readFileSync(join(root, MIGRATION), "utf8")
const receivableMigration = readFileSync(join(root, RECEIVABLE_MIGRATION), "utf8")
const snapshot = readFileSync(join(root, SNAPSHOT), "utf8")
const wrapper = readFileSync(join(root, WRAPPER), "utf8")

function sqlFunctionBody(sql, name) {
  const start = sql.search(
    new RegExp(`create or replace function public\\.${name}\\s*\\(`, "i"),
  )
  assert.notEqual(start, -1, `${name} is not defined in the given SQL`)
  const marker = sql.slice(start).search(/\$function\$;/)
  assert.notEqual(marker, -1, `${name} has no $function$ terminator`)
  return sql.slice(start, start + marker + "$function$;".length)
}

// A later migration may replace a function. The contract must describe what a
// replay actually leaves behind, which is the last definition in filename
// order — reading only the first migration would keep asserting a body that
// is no longer the one a database gets.
function latestSqlFunctionBody(name) {
  const dir = join(root, "supabase/migrations")
  const files = readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()
  let latest = null
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8")
    if (!new RegExp(`create or replace function public\\.${name}\\s*\\(`, "i").test(sql)) continue
    latest = { file, body: sqlFunctionBody(sql, name) }
  }
  assert.notEqual(latest, null, `${name} is not defined by any migration`)
  return latest
}

function sqlSignatureParams(body) {
  const signature = body.slice(0, body.indexOf(")"))
  return [...signature.matchAll(/\bp_[a-z0-9_]+/g)].map((match) => match[0]).sort()
}

function wrapperArgs(methodName) {
  const start = wrapper.indexOf(`client.rpc("${methodName}"`)
  assert.notEqual(start, -1, `${methodName} is not called by the wrapper`)
  const end = wrapper.indexOf("})", start)
  const call = wrapper.slice(start, end)
  return [...call.matchAll(/\b(p_[a-z0-9_]+):/g)].map((match) => match[1]).sort()
}

test("the migration chain defines both RPCs, so a replay reproduces them", () => {
  for (const name of ["adjust_pharmacy_batch_stock", "reverse_pharmacy_sale"]) {
    assert.match(
      migration,
      new RegExp(`create or replace function public\\.${name}\\s*\\(`, "i"),
      `${name} must be created by an active migration, not only by the snapshot or production`,
    )
  }
})

test("SQL signatures match the arguments the TypeScript wrapper sends", () => {
  assert.deepEqual(
    sqlSignatureParams(latestSqlFunctionBody("adjust_pharmacy_batch_stock").body),
    wrapperArgs("adjust_pharmacy_batch_stock"),
  )
  assert.deepEqual(
    sqlSignatureParams(latestSqlFunctionBody("reverse_pharmacy_sale").body),
    wrapperArgs("reverse_pharmacy_sale"),
  )
})

test("both RPCs validate the actor's tenancy before doing any work", () => {
  for (const name of ["adjust_pharmacy_batch_stock", "reverse_pharmacy_sale"]) {
    const body = latestSqlFunctionBody(name).body
    assert.match(
      body,
      /perform\s+public\.pharmacy_assert_actor\s*\(\s*p_tenant_id\s*,\s*p_actor_id\s*\)/i,
      `${name} must authorise the actor against the tenant`,
    )
  }
  const helper = sqlFunctionBody(migration, "pharmacy_assert_actor")
  assert.match(helper, /from\s+profiles\s+where\s+id\s*=\s*p_actor_id\s+and\s+tenant_id\s*=\s*p_tenant_id/is)
  assert.match(helper, /from\s+pharmacy_user_settings/i)
})

test("the cash refund is what the customer paid, not an undiscounted line sum", () => {
  const { body, file } = latestSqlFunctionBody("reverse_pharmacy_sale")
  assert.match(
    body,
    /v_refund_amount\s*:=\s*v_paid\b/i,
    `${file}: refund_amount must be the paid portion the sale recorded`,
  )
  assert.match(
    body,
    /regexp_match\(coalesce\(v_sale\.payment_ref,\s*''\),\s*'PAID:\(\[0-9\]\+\(\[\.\]\[0-9\]\+\)\?\)'\)/i,
    "the paid amount must come from the same payment_ref tag the accounting trigger parses",
  )
  assert.doesNotMatch(
    body,
    /v_refund_amount\s*:=\s*v_refund_amount\s*\+/i,
    "a line-by-line sum reintroduces the discount/tax defect",
  )
})

test("a credit sale reverses its receivable instead of paying out cash it never received", () => {
  const { body, file } = latestSqlFunctionBody("reverse_pharmacy_sale")
  assert.match(
    body,
    /idempotency_key\s*=\s*'pos-sale:'\s*\|\|\s*p_sale_id::text/i,
    `${file}: the sale's credit posting is found by the key complete-sale writes`,
  )
  assert.match(body, /'refund',\s*v_balance_after/i, "the reversal is a ledger movement, not a silent balance edit")
  assert.match(
    body,
    /'pos-refund:'\s*\|\|\s*p_sale_id::text/i,
    "one reversal per sale; the unique idempotency index is what makes a retry a no-op",
  )
  assert.match(body, /v_balance\s*-\s*v_reversal/i, "the balance after the reversal must be recorded")
  assert.match(
    body,
    /receivable_unposted/i,
    "a sale whose balance was never posted must be reported, not refunded as if it were cash",
  )
})

test("a missing sale and a missing product line are distinct failures", () => {
  const { body, file } = latestSqlFunctionBody("reverse_pharmacy_sale")
  assert.match(
    body,
    /raise\s+exception\s+'SALE_NOT_FOUND:\s*sale\s*%'/i,
    `${file}: a sale that does not exist must not be reported as a missing product; the caller uses that code to decide whether to search the older transaction table`,
  )
  assert.match(
    body,
    /raise\s+exception\s+'PRODUCT_NOT_FOUND:\s*%',\s*v_item\.product_id/i,
    "a line whose product row is gone is a different failure from a missing sale",
  )
  assert.match(
    body,
    /'receivable_unreversed',\s*v_unreversed/i,
    "the unpaid part the ledger could not reverse must be reported, not left to be discovered in ageing",
  )
})

test("the ledger type check is replaced by name before the loop, so a replay can re-add it", () => {
  assert.match(
    receivableMigration,
    /alter table public\.pharmacy_credit_ledger\s+drop constraint if exists pharmacy_credit_ledger_type_check;/i,
    "without this, a replay over an already-widened check fails on a duplicate constraint name",
  )
  const dropByName = receivableMigration.indexOf("drop constraint if exists pharmacy_credit_ledger_type_check")
  const addCheck = receivableMigration.indexOf("add constraint pharmacy_credit_ledger_type_check")
  const loop = receivableMigration.indexOf("execute format('alter table public.pharmacy_credit_ledger drop constraint %I'")
  assert.ok(dropByName !== -1 && loop !== -1 && addCheck !== -1)
  assert.ok(dropByName < loop && loop < addCheck, "the auto-named variant is still dropped before the add")
})

test("a sale cannot be refunded twice, and stock is restored at most once per line", () => {
  const body = latestSqlFunctionBody("reverse_pharmacy_sale").body
  assert.match(body, /ALREADY_REFUNDED/)
  assert.match(body, /SALE_NOT_REFUNDABLE/)
  assert.match(body, /for\s+update/i, "the sale row must be locked to serialise concurrent refunds")
  assert.match(body, /if\s+not\s+coalesce\(v_item\.stock_decremented,\s*false\)\s+then\s+continue/i)
  assert.doesNotMatch(
    body,
    /update\s+pharmacy_pos_sale_items\s+set\s+stock_decremented/i,
    "completed sale lines are append-only; the locked sale status is the idempotency guard",
  )
})

test("refund locks products before batches and never reactivates restricted stock", () => {
  const body = latestSqlFunctionBody("reverse_pharmacy_sale").body
  const productLock = body.indexOf("from pharmacy_products")
  const batchLock = body.indexOf("from pharmacy_product_batches")
  assert.ok(productLock !== -1 && batchLock !== -1 && productLock < batchLock)
  assert.match(body, /BATCH_NOT_RESTORABLE/)
  assert.match(body, /v_batch\.is_active/)
  assert.match(body, /v_batch\.expiry_date\s*<\s*v_kla_today/)
})

test("a refund whose sold batch is missing fails closed instead of desyncing totals", () => {
  const body = latestSqlFunctionBody("reverse_pharmacy_sale").body
  assert.match(body, /BATCH_NOT_FOUND: batch % for product % on sale % no longer exists/)
})

test("stock adjustments refuse to leave product and batch totals disagreeing", () => {
  const body = sqlFunctionBody(migration, "adjust_pharmacy_batch_stock")
  assert.match(
    body,
    /if\s+p_quantity\s*>\s*v_prev\s+then\s+raise\s+exception\s+'INSUFFICIENT_STOCK/i,
    "DECREASE must refuse more than the recorded product quantity",
  )
  assert.doesNotMatch(body, /greatest\(v_prev/, "clamping at zero is what hid the drift")
})

test("FEFO decreases create one stock-history row per affected batch", () => {
  const body = sqlFunctionBody(migration, "adjust_pharmacy_batch_stock")
  assert.match(body, /v_batch\.id,\s*v_take,\s*'DECREASE'/i)
  assert.match(body, /v_current\s*-\s*v_take/i)
  assert.doesNotMatch(
    body,
    /p_tenant_id,\s*p_product_id,\s*p_batch_id,\s*p_quantity,\s*'DECREASE'/i,
    "an unpinned FEFO decrease must not be recorded as one unattributed row",
  )
})

test("every stock branch writes an audit row, and audit failure is not swallowed", () => {
  const body = sqlFunctionBody(migration, "adjust_pharmacy_batch_stock")
  for (const action of ["stock.decrease", "stock.correction", "'stock.' || lower(v_type)"]) {
    assert.ok(body.includes(action), `${action} must be audited`)
  }
  assert.doesNotMatch(
    migration,
    /exception when others then null/i,
    "a swallowed audit failure makes an unaudited stock change look successful",
  )
})

test("a deactivated pharmacy user is refused even when their profile carries the tenant", () => {
  const helper = sqlFunctionBody(migration, "pharmacy_assert_actor")
  // The pharmacy_user_settings branch must come first and must decide on
  // is_active; the profiles fallback must not be reachable past a deactivation.
  const settingsBranch = helper.search(/from\s+pharmacy_user_settings/i)
  const profilesBranch = helper.search(/from\s+profiles\b/i)
  assert.ok(settingsBranch !== -1 && profilesBranch !== -1)
  assert.ok(
    settingsBranch < profilesBranch,
    "checking profiles first lets a deactivated pharmacist through on tenant_id alone",
  )
  assert.match(helper, /is deactivated for this pharmacy/)
})

test("a correction that would store negative product stock is refused", () => {
  const body = sqlFunctionBody(migration, "adjust_pharmacy_batch_stock")
  assert.match(body, /if\s+v_new\s*<\s*0\s+then\s+raise\s+exception\s+'STOCK_DRIFT/i)
  assert.match(body, /STOCK_DRIFT/)
})

test("the new RPCs and the actor check are service_role only", () => {
  const grantBlock = migration.slice(migration.indexOf("Least privilege"))
  for (const name of ["adjust_pharmacy_batch_stock", "reverse_pharmacy_sale", "pharmacy_assert_actor"]) {
    assert.ok(grantBlock.includes(`'${name}'`), `${name} must be in the grant loop`)
  }
  assert.match(grantBlock, /revoke all on function %s from anon/i)
  assert.match(grantBlock, /revoke all on function %s from authenticated/i)
  assert.match(grantBlock, /grant execute on function %s to service_role/i)
})

test("the canonical snapshot carries the corrected bodies for a snapshot-only bootstrap", () => {
  assert.ok(snapshot.includes('FUNCTION "public"."pharmacy_assert_actor"'))
  const reverse = snapshot.slice(snapshot.indexOf('CREATE OR REPLACE FUNCTION "public"."reverse_pharmacy_sale"'))
  const body = reverse.slice(0, reverse.indexOf("$$;"))
  assert.match(
    body,
    /v_refund_amount\s*:=\s*v_paid\b/i,
    "db-reset-fresh.sh applies only the snapshot, so the snapshot must not keep the old gross refund",
  )
  assert.match(body, /'pos-refund:'\s*\|\|\s*p_sale_id::text/i)
  assert.match(
    snapshot,
    /"pharmacy_credit_ledger_type_check" CHECK \(.*'refund'/i,
    "the snapshot's ledger must accept the reversal movement, or the refund fails on a snapshot-built database",
  )
})
