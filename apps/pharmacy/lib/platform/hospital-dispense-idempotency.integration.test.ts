import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { supabaseAdmin } from "@synapse/db/admin"
import { hasDb } from "./test-db-guard"

describe.skipIf(!hasDb)("hospital dispense inventory idempotency (P0-001)", () => {
  let tenantId: string
  let productId: string
  let cashierId: string
  let taskId: string
  let prescriptionId: string
  let batchId: string
  const idempotencyKey = `clinical_prescriptions:${crypto.randomUUID()}`

  beforeAll(async () => {
    tenantId = crypto.randomUUID()
    productId = crypto.randomUUID()
    cashierId = crypto.randomUUID()
    taskId = crypto.randomUUID()
    prescriptionId = crypto.randomUUID()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any

    const { error: tenantError } = await db.from("tenants").insert({
      id: tenantId,
      slug: tenantId,
      name: "Dispense Idempotency Pharmacy",
      facility_type: "pharmacy",
      is_synthetic: true,
      environment: "demo",
      data_classification: "synthetic",
    })
    if (tenantError) throw new Error(tenantError.message)

    const { error: profileError } = await db.from('profiles').insert({
      id: cashierId,
      email: `${cashierId}@p0-001.invalid`,
      full_name: 'Synthetic Pharmacist',
      first_name: 'Synthetic',
      last_name: 'Pharmacist',
      role: 'pharmacist',
      tenant_id: tenantId,
      verification_status: 'verified',
    })
    if (profileError) throw new Error(profileError.message)

    const { error: productError } = await db.from("pharmacy_products").insert({
      id: productId,
      tenant_id: tenantId,
      name: "Paracetamol 500mg",
      sku: `PCT-${Date.now()}`,
      price: 500,
      cost_price: 300,
      quantity: 0,
      is_active: true,
    })
    if (productError) throw new Error(productError.message)

    const { data: receivedBatch, error: receiveError } = await db.rpc("receive_pharmacy_stock", {
      p_tenant_id: tenantId,
      p_product_id: productId,
      p_batch_number: `B-${Date.now()}`,
      p_quantity: 20,
      p_expiry_date: "2028-12-31",
      p_cost_price: 300,
      p_selling_price: 500,
      p_received_by: cashierId,
      p_supplier_ref: "dispense-idempotency-test",
    })
    if (receiveError) throw new Error(receiveError.message)
    batchId = String(receivedBatch.batch_id)

    const { error: taskError } = await db.from("department_tasks").insert({
      id: taskId,
      tenant_id: tenantId,
      owner_department: "pharmacy",
      owner_role: "pharmacist",
      task_type: "prescription",
      title: "Dispense Paracetamol 500mg",
      source_resource: "clinical_prescriptions",
      source_id: prescriptionId,
      idempotency_key: `clinical_prescriptions:${prescriptionId}`,
      is_synthetic: true,
    })
    if (taskError) throw new Error(taskError.message)
  })

  afterAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const { data: sales } = await db.from("pharmacy_pos_sales").select("id").eq("tenant_id", tenantId)
    const saleIds = (sales ?? []).map((row: { id: string }) => row.id)
    if (saleIds.length) {
      await db.from("pharmacy_pos_sale_items").delete().in("sale_id", saleIds)
    }
    await db.from("pharmacy_sale_idempotency").delete().eq("tenant_id", tenantId)
    await db.from("pharmacy_pos_sales").delete().eq("tenant_id", tenantId)
    await db.from("pharmacy_product_batches").delete().eq("tenant_id", tenantId)
    await db.from("department_tasks").delete().eq("id", taskId)
    await db.from("pharmacy_products").delete().eq("tenant_id", tenantId)
    await db.from("profiles").delete().eq("id", cashierId)
    await db.from("tenants").delete().eq("id", tenantId)
  })

  it("P0-001 completes a pharmacy task and decrements stock exactly once", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabaseAdmin as any
    const items = [
      {
        product_id: productId,
        batch_id: batchId,
        quantity: 2,
        unit_price: 500,
        discount_amount: 0,
      },
    ]

    const { data: first, error: firstError } = await db.rpc("complete_pharmacy_sale", {
      p_tenant_id: tenantId,
      p_cashier_id: cashierId,
      p_items: items,
      p_payment_method: "cash",
      p_idempotency_key: idempotencyKey,
    })
    if (firstError) throw new Error(firstError.message)

    const { error: taskCompleteError } = await db
      .from("department_tasks")
      .update({ status: "COMPLETED", result_summary: `Dispensed via sale ${String(first?.sale_id ?? "")}` })
      .eq("id", taskId)
      .eq("tenant_id", tenantId)
    if (taskCompleteError) throw new Error(taskCompleteError.message)

    const { data: second, error: secondError } = await db.rpc("complete_pharmacy_sale", {
      p_tenant_id: tenantId,
      p_cashier_id: cashierId,
      p_items: items,
      p_payment_method: "cash",
      p_idempotency_key: idempotencyKey,
    })
    if (secondError) throw new Error(secondError.message)

    const firstSaleId =
      first && typeof first === "object"
        ? String((first as Record<string, unknown>).sale_id ?? "")
        : ""
    const secondSaleId =
      second && typeof second === "object"
        ? String((second as Record<string, unknown>).sale_id ?? "")
        : ""

    expect(firstSaleId).not.toBe("")
    expect(secondSaleId).toBe(firstSaleId)

    const { data: product } = await db
      .from("pharmacy_products")
      .select("quantity")
      .eq("id", productId)
      .eq("tenant_id", tenantId)
      .single()

    expect(Number(product?.quantity ?? -1)).toBe(18)

    const { data: task } = await db.from("department_tasks").select("status").eq("id", taskId).single()
    expect(task?.status).toBe("COMPLETED")
  })
})
