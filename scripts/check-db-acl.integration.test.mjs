// Opt-in isolated integration test for scripts/check-db-acl.mjs --strict-live.
// Requires an isolated, disposable PostgreSQL database reachable via
// ACL_INTEGRATION_URL. NEVER point this at production.
//
// Without ACL_INTEGRATION_URL the test skips. It exercises the REAL live path
// (runLiveCheckFromUrl) against synthetic roles/functions only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { Client } from "pg"
import { runLiveCheckFromUrl } from "./check-db-acl.mjs"

const URL_ENV = process.env.ACL_INTEGRATION_URL

// Hard safety: refuse managed/production hosts and require loopback unless an
// explicit override is set. Never returns or logs the full URL or credentials.
const PRODUCTION_MARKERS = ["qfqakzmjatszisuqjwon", "supabase.co", "amazonaws.com", "neon.tech"]

function assertSafeIntegrationUrl(url, allowNonLocal = process.env.ACL_ALLOW_NONLOCAL === "1") {
  if (typeof url !== "string" || url.trim() === "") throw new Error("ACL_INTEGRATION_URL required")
  let host
  try {
    host = new URL(url).hostname
  } catch {
    throw new Error("ACL_INTEGRATION_URL invalid")
  }
  for (const marker of PRODUCTION_MARKERS) {
    if (host.includes(marker)) throw new Error("ACL_INTEGRATION_URL is a managed/production host; refusing")
  }
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1"
  if (!isLoopback && !allowNonLocal) {
    throw new Error("ACL_INTEGRATION_URL host is not loopback; set ACL_ALLOW_NONLOCAL=1 to override (test-only)")
  }
}

// Prevent destructive setup against a real database: the target database name
// must be marked disposable (*acl_test*), unless explicitly overridden.
function assertDisposableTarget(url, allow = process.env.ACL_DISPOSABLE_DB === "1") {
  if (allow) return
  let path
  try {
    path = new URL(url).pathname
  } catch {
    throw new Error("ACL_INTEGRATION_URL invalid")
  }
  const dbName = decodeURIComponent((path.replace(/^\//, "").split("?")[0] || ""))
  if (!dbName.toLowerCase().includes("acl_test")) {
    throw new Error("ACL_INTEGRATION_URL must target a disposable database named *acl_test*; set ACL_DISPOSABLE_DB=1 to override")
  }
}

const THIRTEEN = "receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)"

const DROP_OVERLOADS = `
DROP FUNCTION IF EXISTS public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text) CASCADE;
DROP FUNCTION IF EXISTS public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) CASCADE;`

const CREATE_THIRTEEN = `
CREATE FUNCTION public.receive_pharmacy_stock(
  p_tenant_id uuid, p_product_id uuid, p_batch_number text, p_quantity integer,
  p_expiry_date date, p_cost_price numeric DEFAULT NULL, p_received_by uuid DEFAULT NULL,
  p_supplier_ref text DEFAULT NULL, p_selling_price numeric DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL, p_purchase_order_id uuid DEFAULT NULL,
  p_store_id uuid DEFAULT NULL, p_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$ BEGIN RETURN '{}'::jsonb; END $$;`

const ENSURE_ROLES = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
END $$;`

async function withClient(fn) {
  const client = new Client({ connectionString: URL_ENV, connectionTimeoutMillis: 5000 })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

async function resetSafe() {
  await withClient(async (c) => {
    await c.query(ENSURE_ROLES)
    await c.query(DROP_OVERLOADS)
    await c.query(CREATE_THIRTEEN)
    await c.query(`REVOKE ALL ON FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated;`)
    await c.query(`GRANT EXECUTE ON FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) TO service_role;`)
  })
}

test("assertSafeIntegrationUrl rejects production targets and non-loopback hosts", () => {
  assert.throws(
    () => assertSafeIntegrationUrl("postgres://u:p@db.qfqakzmjatszisuqjwon.supabase.co:5432/db"),
    /managed|production/,
  )
  assert.throws(
    () => assertSafeIntegrationUrl("postgres://u:p@nonloopback.example.com:5432/db", false),
    /not loopback/,
  )
  assert.doesNotThrow(() => assertSafeIntegrationUrl("postgres://u:p@127.0.0.1:5432/db", false))
  assert.doesNotThrow(() => assertSafeIntegrationUrl("postgres://u:p@localhost:5432/db", false))
})

test("assertDisposableTarget requires a disposable *acl_test* database", () => {
  assert.throws(() => assertDisposableTarget("postgres://u:p@127.0.0.1:5432/realdb", false), /disposable/)
  assert.doesNotThrow(() => assertDisposableTarget("postgres://u:p@127.0.0.1:5432/acl_test", false))
  assert.doesNotThrow(() => assertDisposableTarget("postgres://u:p@127.0.0.1:5432/anything", true))
})

test("isolated ACL matrix", { skip: !URL_ENV }, async (t) => {
  assertSafeIntegrationUrl(URL_ENV)
  assertDisposableTarget(URL_ENV)
  await t.test("safe service-role-only passes", async () => {
    await resetSafe()
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.equal(result.ok, true, result.errors.join("; "))
  })

  await t.test("explicit PUBLIC EXECUTE fails", async () => {
    await resetSafe()
    await withClient((c) => c.query(`GRANT EXECUTE ON FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) TO PUBLIC;`))
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.equal(result.ok, false)
    assert.match(result.errors.join(";"), /PUBLIC_EXECUTE/)
  })

  await t.test("implicit default PUBLIC EXECUTE fails", async () => {
    await withClient(async (c) => {
      await c.query(ENSURE_ROLES)
      await c.query(DROP_OVERLOADS)
      await c.query(CREATE_THIRTEEN) // no grants -> default PUBLIC EXECUTE
    })
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.equal(result.ok, false)
    assert.match(result.errors.join(";"), /PUBLIC_EXECUTE/)
  })

  await t.test("authenticated EXECUTE fails", async () => {
    await resetSafe()
    await withClient((c) => c.query(`GRANT EXECUTE ON FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) TO authenticated;`))
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.match(result.errors.join(";"), /AUTHENTICATED_EXECUTE/)
  })

  await t.test("anon EXECUTE fails", async () => {
    await resetSafe()
    await withClient((c) => c.query(`GRANT EXECUTE ON FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) TO anon;`))
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.match(result.errors.join(";"), /ANON_EXECUTE/)
  })

  await t.test("missing required overload fails", async () => {
    await withClient(async (c) => {
      await c.query(ENSURE_ROLES)
      await c.query(DROP_OVERLOADS) // neither overload exists
    })
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.equal(result.ok, false)
    assert.match(result.errors.join(";"), /MISSING_EXPECTED_OVERLOAD|ACL_LIVE_NO_FUNCTIONS/)
  })

  await t.test("unsafe owner fails", async () => {
    await resetSafe()
    await withClient((c) => c.query(`ALTER FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) OWNER TO authenticated;`))
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.match(result.errors.join(";"), /UNSAFE_OWNER/)
  })

  await t.test("unsafe search_path fails", async () => {
    await resetSafe()
    await withClient((c) => c.query(`ALTER FUNCTION public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text) SET search_path TO 'attacker, public';`))
    const result = await runLiveCheckFromUrl(URL_ENV)
    assert.match(result.errors.join(";"), /SEARCH_PATH_UNSAFE/)
  })
})
