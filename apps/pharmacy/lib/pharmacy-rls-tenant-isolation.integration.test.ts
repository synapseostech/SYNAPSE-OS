import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClient, type SupabaseClient } from "@supabase/supabase-js"
import { supabaseAdmin } from "@synapse/db/admin"
import { hasDb } from "./platform/test-db-guard"

/**
 * Database-backed proof that pharmacy row security isolates tenants for a real
 * authenticated user.
 *
 * These run only against a disposable database. CI's db-acceptance job exports
 * SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and NEXT_PUBLIC_SUPABASE_ANON_KEY
 * after replaying the canonical snapshot and every migration past the snapshot
 * cutoff, so the policies under test are the ones a deployment gets. A local run
 * without those variables skips — and a skip is not evidence.
 *
 * The service-role client cannot prove this: it bypasses RLS by design. Each
 * fixture user therefore signs in with the public anon key and exercises
 * PostgREST under its own JWT, which is exactly the path an operator's browser
 * takes. profiles.is_admin marks a tenant administrator; before
 * 20261102120000_pharmacy_policy_tenant_scope that flag satisfied the
 * `*_tenant_isolation` policies with no tenant predicate, so tenant A's
 * administrator could read and write tenant B's pharmacy rows.
 *
 * From 20261102130000 the policies ask public.pharmacy_caller_tenants(), so the
 * fixtures below also cover what a single profiles.tenant_id pointer cannot
 * express: a person who works at two pharmacies, a staff row deactivated at one
 * of them while the home pointer still names it, and an archived profile.
 */

const url = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim()
const anonKey = (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim()
const canTestRls = hasDb && Boolean(url) && Boolean(anonKey)

if (hasDb && !anonKey) {
  console.info(
    "[integration] pharmacy RLS tests skipped: NEXT_PUBLIC_SUPABASE_ANON_KEY is not set, so no user JWT can be minted",
  )
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

const password = `rls-${crypto.randomUUID()}-Aa1!`

type FixtureUser = { id: string; email: string; client: SupabaseClient }

describe.skipIf(!canTestRls)("pharmacy tenant isolation under a user JWT", () => {
  let tenantA: string
  let tenantB: string
  let tenantC: string
  let productA: string
  let productB: string
  let productC: string
  let adminA: FixtureUser
  let platformAdmin: FixtureUser
  let dualStaff: FixtureUser
  let deactivatedStaff: FixtureUser
  let deletedProfile: FixtureUser
  let anon: SupabaseClient

  async function createUser(
    tenantId: string | null,
    options: { isAdmin: boolean; role: string; label: string; isDeleted?: boolean },
  ): Promise<FixtureUser> {
    const email = `rls-${crypto.randomUUID()}@pharmacy-rls.invalid`
    const { data: created, error: createError } = await db.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    })
    if (createError || !created?.user) {
      throw new Error(`could not create the fixture user: ${createError?.message ?? "no user returned"}`)
    }

    const { error: profileError } = await db.from("profiles").insert({
      id: created.user.id,
      email,
      full_name: options.label,
      first_name: options.label.split(" ")[0],
      last_name: "Test",
      role: options.role,
      tenant_id: tenantId,
      is_admin: options.isAdmin,
      is_deleted: options.isDeleted ?? false,
      verification_status: "verified",
    })
    if (profileError) throw new Error(profileError.message)

    const client = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: signInError } = await client.auth.signInWithPassword({ email, password })
    if (signInError) throw new Error(`could not sign the fixture user in: ${signInError.message}`)

    return { id: created.user.id, email, client }
  }

  beforeAll(async () => {
    tenantA = crypto.randomUUID()
    tenantB = crypto.randomUUID()
    tenantC = crypto.randomUUID()

    for (const [id, name] of [
      [tenantA, "RLS Pharmacy A"],
      [tenantB, "RLS Pharmacy B"],
      [tenantC, "RLS Pharmacy C"],
    ] as const) {
      const { error } = await db.from("tenants").insert({
        id,
        slug: id,
        name,
        facility_type: "pharmacy",
        is_synthetic: true,
        environment: "demo",
        data_classification: "synthetic",
      })
      if (error) throw new Error(error.message)
    }

    productA = crypto.randomUUID()
    productB = crypto.randomUUID()
    productC = crypto.randomUUID()
    for (const [id, tenant, name] of [
      [productA, tenantA, "Tenant A Product"],
      [productB, tenantB, "Tenant B Product"],
      [productC, tenantC, "Tenant C Product"],
    ] as const) {
      const { error } = await db.from("pharmacy_products").insert({
        id,
        tenant_id: tenant,
        name,
        sku: id,
        price: 1000,
        cost_price: 500,
      })
      if (error) throw new Error(error.message)
    }

    adminA = await createUser(tenantA, { isAdmin: true, role: "pharmacist", label: "Tenant A Administrator" })
    platformAdmin = await createUser(null, {
      isAdmin: false,
      role: "platform_admin",
      label: "Platform Administrator",
    })
    // The home pointer names pharmacy A, but this person also works at B.
    dualStaff = await createUser(tenantA, {
      isAdmin: false,
      role: "pharmacist",
      label: "Dual Pharmacy Pharmacist",
    })
    // Home pointer still names A, but the staff row at A is switched off.
    deactivatedStaff = await createUser(tenantA, {
      isAdmin: false,
      role: "pharmacist",
      label: "Deactivated Pharmacist",
    })
    deletedProfile = await createUser(tenantA, {
      isAdmin: false,
      role: "pharmacist",
      label: "Archived Pharmacist",
      isDeleted: true,
    })

    for (const row of [
      { tenant_id: tenantA, profile_id: dualStaff.id, pharmacy_role: "pharmacist", is_active: true },
      { tenant_id: tenantB, profile_id: dualStaff.id, pharmacy_role: "pharmacist", is_active: true },
      { tenant_id: tenantA, profile_id: deactivatedStaff.id, pharmacy_role: "pharmacist", is_active: false },
    ]) {
      const { error } = await db.from("pharmacy_user_settings").insert(row)
      if (error) throw new Error(error.message)
    }

    anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } })
  }, 60_000)

  // Setup and teardown are sequences of hosted auth and table writes; vitest's
  // default 10s hook budget expired on both during remote runs on 2026-11-02.
  afterAll(async () => {
    const users = [adminA?.id, platformAdmin?.id, dualStaff?.id, deactivatedStaff?.id, deletedProfile?.id].filter(
      Boolean,
    ) as string[]
    for (const id of users) {
      await db.from("pharmacy_user_settings").delete().eq("profile_id", id)
      await db.from("profiles").delete().eq("id", id)
      await db.auth.admin.deleteUser(id).catch(() => undefined)
    }
    for (const tenant of [tenantA, tenantB, tenantC].filter(Boolean)) {
      await db.from("pharmacy_products").delete().eq("tenant_id", tenant)
      await db.from("pharmacy_customers").delete().eq("tenant_id", tenant)
      await db.from("tenants").delete().eq("id", tenant)
    }
  }, 60_000)

  it("a tenant administrator sees only their own tenant's products", async () => {
    const { data, error } = await adminA.client.from("pharmacy_products").select("id, tenant_id")
    expect(error).toBeNull()
    const ids = (data ?? []).map((row: { id: string }) => row.id)
    expect(ids).toContain(productA)
    expect(ids).not.toContain(productB)
    expect((data ?? []).every((row: { tenant_id: string }) => row.tenant_id === tenantA)).toBe(true)
  })

  it("a tenant administrator cannot create a product in another tenant", async () => {
    const foreignId = crypto.randomUUID()
    const { error } = await adminA.client.from("pharmacy_products").insert({
      id: foreignId,
      tenant_id: tenantB,
      name: "Cross-tenant Product",
      sku: foreignId,
      price: 1000,
      cost_price: 500,
    })
    expect(error).not.toBeNull()

    const { data: written } = await db.from("pharmacy_products").select("id").eq("id", foreignId)
    expect(written ?? []).toEqual([])
  })

  it("a tenant administrator can still write inside their own tenant", async () => {
    const ownId = crypto.randomUUID()
    const { error } = await adminA.client.from("pharmacy_products").insert({
      id: ownId,
      tenant_id: tenantA,
      name: "Own Tenant Product",
      sku: ownId,
      price: 1500,
      cost_price: 700,
    })
    expect(error).toBeNull()
    await db.from("pharmacy_products").delete().eq("id", ownId)
  })

  it("a tenant administrator cannot move a row into another tenant", async () => {
    const { error } = await adminA.client
      .from("pharmacy_products")
      .update({ tenant_id: tenantB })
      .eq("id", productA)
    expect(error).not.toBeNull()

    const { data: unchanged } = await db.from("pharmacy_products").select("tenant_id").eq("id", productA).single()
    expect(unchanged?.tenant_id).toBe(tenantA)
  })

  it("a platform administrator keeps cross-tenant reach", async () => {
    const { data, error } = await platformAdmin.client.from("pharmacy_products").select("id, tenant_id")
    expect(error).toBeNull()
    const ids = (data ?? []).map((row: { id: string }) => row.id)
    expect(ids).toContain(productA)
    expect(ids).toContain(productB)
  })

  it("an anonymous caller reads no pharmacy rows", async () => {
    const { data, error } = await anon.from("pharmacy_products").select("id")
    expect(error).toBeNull()
    expect(data ?? []).toEqual([])
  })

  it("a pharmacist working at two pharmacies sees both, and nothing else", async () => {
    const { data, error } = await dualStaff.client.from("pharmacy_products").select("id, tenant_id")
    expect(error).toBeNull()
    const ids = (data ?? []).map((row: { id: string }) => row.id)
    expect(ids).toContain(productA)
    expect(ids).toContain(productB)
    expect(ids).not.toContain(productC)
  })

  it("a two-pharmacy pharmacist cannot write into a third pharmacy", async () => {
    const foreignId = crypto.randomUUID()
    const { error } = await dualStaff.client.from("pharmacy_products").insert({
      id: foreignId,
      tenant_id: tenantC,
      name: "Third Pharmacy Product",
      sku: foreignId,
      price: 1000,
      cost_price: 500,
    })
    expect(error).not.toBeNull()

    const { data: written } = await db.from("pharmacy_products").select("id").eq("id", foreignId)
    expect(written ?? []).toEqual([])
  })

  it("a deactivated staff row withdraws access even though the home tenant still names the pharmacy", async () => {
    const { data, error } = await deactivatedStaff.client.from("pharmacy_products").select("id, tenant_id")
    expect(error).toBeNull()
    expect(data ?? []).toEqual([])

    const ownId = crypto.randomUUID()
    const { error: writeError } = await deactivatedStaff.client.from("pharmacy_products").insert({
      id: ownId,
      tenant_id: tenantA,
      name: "Deactivated Pharmacist Product",
      sku: ownId,
      price: 1000,
      cost_price: 500,
    })
    expect(writeError).not.toBeNull()

    const { data: written } = await db.from("pharmacy_products").select("id").eq("id", ownId)
    expect(written ?? []).toEqual([])
  })

  it("an archived profile loses its home tenant", async () => {
    const { data, error } = await deletedProfile.client.from("pharmacy_products").select("id")
    expect(error).toBeNull()
    expect(data ?? []).toEqual([])
  })

  it("an authenticated caller cannot execute a pharmacy mutation RPC", async () => {
    const { error } = await adminA.client.rpc("complete_pharmacy_sale", {
      p_tenant_id: tenantA,
      p_cashier_id: adminA.id,
      p_items: [],
      p_payment_method: "cash",
    })
    expect(error).not.toBeNull()

    // The refusal must also be a refusal to write, not a late validation error.
    const { data: sales } = await db
      .from("pharmacy_pos_sales")
      .select("id")
      .eq("tenant_id", tenantA)
      .eq("cashier_id", adminA.id)
    expect(sales ?? []).toEqual([])
  })

  it("a JWT subject cannot promote itself to platform administrator", async () => {
    // profiles_update_own_or_platform permits updating the caller's own row, so
    // without 20261102130100 this one statement would satisfy every
    // is_platform_admin() bypass in the schema.
    const { error } = await adminA.client
      .from("profiles")
      .update({ role: "platform_admin" })
      .eq("id", adminA.id)
    expect(error).not.toBeNull()

    const { data: after } = await db.from("profiles").select("role").eq("id", adminA.id).single()
    expect(after?.role).toBe("pharmacist")
  })

  it("a user JWT cannot read a stored import object", async () => {
    const bucket = "pharmacy-imports"
    await db.storage.createBucket(bucket, { public: false }).catch(() => undefined)

    const path = `${tenantC}/rls-${crypto.randomUUID()}.xml`
    const upload = await db.storage
      .from(bucket)
      .upload(path, Buffer.from("<ENVELOPE/>"), { contentType: "application/xml" })
    expect(upload.error).toBeNull()

    try {
      // The bucket is private and carries no policy, so a tenant user reaches
      // its own object only through a signed URL the server issues.
      const { data, error } = await adminA.client.storage.from(bucket).download(path)
      expect(error).not.toBeNull()
      expect(data).toBeNull()
    } finally {
      await db.storage.from(bucket).remove([path])
    }
  })

  it("customer records follow the same rule as products", async () => {
    const customerA = crypto.randomUUID()
    const { error } = await db
      .from("pharmacy_customers")
      .insert({ id: customerA, tenant_id: tenantA, name: "Tenant A Customer" })
    if (error) throw new Error(error.message)

    try {
      const { data, error: readError } = await adminA.client.from("pharmacy_customers").select("id, tenant_id")
      expect(readError).toBeNull()
      expect((data ?? []).every((row: { tenant_id: string }) => row.tenant_id === tenantA)).toBe(true)
      expect((data ?? []).map((row: { id: string }) => row.id)).toContain(customerA)
    } finally {
      await db.from("pharmacy_customers").delete().eq("id", customerA)
    }
  })
})
