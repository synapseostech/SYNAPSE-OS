import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DUPLICATE_PRODUCT_THRESHOLD,
  allocatePurchaseIdempotencyKey,
  catalogProductFromRow,
  createPurchaseCatalogProduct,
  derivePaymentStatus,
  findDuplicateProducts,
  generatePurchaseNo,
  isPurchasePaymentStatus,
  lineTotal,
  mapPoStatusToExisting,
  matchCatalogProducts,
  resolveImportCatalogMatch,
  sameMedicineIdentity,
  IMPORT_QUANTITY_SEMANTICS,
  poStatusFromReceived,
  purchaseMargin,
  purchaseProductOpeningQuantity,
  purchaseTotals,
  rankProductMatches,
  receivePharmacyPurchase,
  scoreProductMatch,
} from "./pharmacy-purchases.ts"

describe("pharmacy purchases domain", () => {
  it("derives supplier payment status without mixing POS payments", () => {
    assert.equal(derivePaymentStatus({ total: 2_000_000, amountPaid: 0 }), "UNPAID")
    assert.equal(derivePaymentStatus({ total: 2_000_000, amountPaid: 800_000 }), "PARTIAL")
    assert.equal(derivePaymentStatus({ total: 2_000_000, amountPaid: 2_000_000 }), "PAID")
    assert.equal(derivePaymentStatus({ total: 2_000_000, amountPaid: 0, explicit: "CREDIT" }), "CREDIT")
    assert.equal(isPurchasePaymentStatus("PAID"), true)
    assert.equal(isPurchasePaymentStatus("captured"), false)
  })

  it("calculates line and purchase totals without hardcoded tax rules", () => {
    assert.equal(lineTotal(500, 200), 100_000)
    const totals = purchaseTotals({
      lines: [
        { quantity: 500, unitCost: 200 },
        { quantity: 200, unitCost: 350 },
      ],
      tax: 0,
      discount: 5_000,
      otherCost: 1_000,
    })
    assert.equal(totals.subtotal, 170_000)
    assert.equal(totals.grandTotal, 166_000)
  })

  it("exposes advisory margin math", () => {
    const margin = purchaseMargin(200, 300)
    assert.equal(margin.profit, 100)
    assert.equal(margin.marginPct, 33.33)
    assert.equal(margin.markupPct, 50)
  })

  it("matches existing catalog products and warns on similar new products", () => {
    const catalog = [
      {
        id: "para",
        name: "Paracetamol 500 mg Tablets",
        genericName: "Paracetamol",
        sku: "PARA-500",
        barcode: "1234567890123",
        strength: "500 mg",
        dosageForm: "Tablet",
        manufacturer: "Cipla",
      },
      {
        id: "amox",
        name: "Amoxicillin 500 mg Capsules",
        genericName: "Amoxicillin",
        sku: "AMOX-500",
        strength: "500 mg",
        dosageForm: "Capsule",
      },
    ]
    const barcodeHit = rankProductMatches({ barcode: "1234567890123" }, catalog)
    assert.equal(barcodeHit[0]?.id, "para")
    assert.ok((barcodeHit[0]?.score ?? 0) >= 100)

    const nameHit = rankProductMatches({ q: "paracetamol 500" }, catalog)
    assert.equal(nameHit[0]?.id, "para")

    const dupes = findDuplicateProducts({ name: "Paracetamol 500 mg Tablets", strength: "500 mg" }, catalog)
    assert.ok(dupes.length >= 1)
    assert.ok((dupes[0]?.score ?? 0) >= DUPLICATE_PRODUCT_THRESHOLD)
    assert.ok(scoreProductMatch({ q: "cetirizine" }, catalog[0]!) < DUPLICATE_PRODUCT_THRESHOLD)
  })

  it("normalizes exact medicine identity without merging missing or different clinical fields", () => {
    const identity = {
      name: " Amoxicillin 500 mg ",
      strength: "500 MG",
      dosageForm: "Capsule",
      activeIngredient: "Amoxicillin",
    }
    assert.equal(
      sameMedicineIdentity(identity, {
        ...identity,
        name: "amoxicillin 500 mg",
        strength: "500 mg",
        dosageForm: " capsule ",
      }),
      true,
    )
    assert.equal(sameMedicineIdentity(identity, { name: identity.name }), false)
    assert.equal(sameMedicineIdentity(identity, { ...identity, activeIngredient: "Ampicillin" }), false)
  })

  it("maps partial PO receiving onto existing status values", () => {
    assert.equal(poStatusFromReceived(1000, 0), "ORDERED")
    assert.equal(poStatusFromReceived(1000, 600), "PARTIALLY_RECEIVED")
    assert.equal(poStatusFromReceived(1000, 1000), "RECEIVED")
    assert.equal(mapPoStatusToExisting("ORDERED"), "SENT")
  })

  it("generates purchase numbers distinct from POS receipts", () => {
    assert.match(generatePurchaseNo(1_700_000_000_000), /^PUR-[A-Z0-9]+-[A-Z0-9]+$/)
  })

  it("replays the same idempotency key without a second receive", async () => {
    const prior = {
      ok: true,
      purchaseId: "p1",
      purchaseNo: "PUR-1",
      status: "RECEIVED",
      paymentStatus: "UNPAID",
      grandTotal: 100,
      amountPaid: 0,
      balance: 100,
      received: [{ productId: "prod", batchId: "b1", quantity: 10, purchaseItemId: "i1" }],
    }
    let rpcCalls = 0
    const client = {
      rpc: async () => {
        rpcCalls += 1
        return { data: { batch_id: "b1", product_id: "prod", received: 10 }, error: null }
      },
      from: (table: string) => {
        const api: Record<string, unknown> = {}
        const self = () => api
        for (const m of ["select", "insert", "update", "delete", "eq", "upsert"]) api[m] = self
        api.maybeSingle = async () =>
          table === "pharmacy_purchase_idempotency"
            ? { data: { purchase_id: "p1", response: prior }, error: null }
            : { data: null, error: null }
        api.single = async () => ({ data: prior, error: null })
        return api
      },
    }
    const result = await receivePharmacyPurchase(client as never, {
      tenantId: "t1",
      actorId: "u1",
      supplierId: "s1",
      idempotencyKey: "retry-1",
      lines: [
        {
          productId: "prod",
          productName: "Paracetamol",
          quantity: 10,
          unitCost: 10,
          batchNumber: "PAR-01",
          expiryDate: "2027-01-01",
        },
      ],
    })
    assert.equal("ok" in result && result.ok, true)
    if ("ok" in result && result.ok) {
      assert.equal(result.replay, true)
      assert.equal(result.purchaseId, "p1")
    }
    assert.equal(rpcCalls, 0)
  })

  it("resumes an in-progress receipt without receiving already-applied lines again", async () => {
    let rpcCalls = 0
    const client = {
      rpc: async () => {
        rpcCalls += 1
        return { data: { batch_id: "b2", product_id: "cet", received: 200 }, error: null }
      },
      from: (table: string) => {
        const api: Record<string, unknown> = {}
        const self = () => api
        for (const m of ["select", "insert", "update", "delete", "eq", "upsert"]) api[m] = self
        api.maybeSingle = async () => {
          if (table === "pharmacy_purchase_idempotency") {
            return {
              data: {
                purchase_id: "p2",
                response: { ok: false, purchaseId: "p2", purchaseNo: "PUR-2" },
              },
              error: null,
            }
          }
          if (table === "pharmacy_purchases") {
            return { data: { id: "p2", purchase_no: "PUR-2", status: "PARTIALLY_RECEIVED" }, error: null }
          }
          if (table === "pharmacy_suppliers") {
            return { data: { id: "s1", name: "Supplier A" }, error: null }
          }
          return { data: { id: "b-existing", cost_price: 100 }, error: null }
        }
        api.single = async () => ({ data: { id: "p2", purchase_no: "PUR-2" }, error: null })
        api.then = undefined
        if (table === "pharmacy_purchase_items") {
          api.select = () => {
            const q: Record<string, unknown> = {}
            const qself = () => q
            for (const m of ["eq"]) q[m] = qself
            q.then = (resolve: (value: unknown) => unknown) =>
              Promise.resolve(
                resolve({
                  data: [
                    {
                      id: "i-para",
                      product_id: "para",
                      quantity: 500,
                      received_quantity: 500,
                      unit_cost: 200,
                      batch_number: "PAR-01",
                      expiry_date: "2027-01-01",
                      selling_price: null,
                      receipt_idempotency_key: "retry-2:para:PAR-01",
                      purchase_order_item_id: null,
                    },
                    {
                      id: "i-cet",
                      product_id: "cet",
                      quantity: 200,
                      received_quantity: 0,
                      unit_cost: 350,
                      batch_number: "CET-44",
                      expiry_date: "2027-06-01",
                      selling_price: null,
                      receipt_idempotency_key: "retry-2:cet:CET-44",
                      purchase_order_item_id: null,
                    },
                  ],
                  error: null,
                }),
              )
            return q
          }
        }
        return api
      },
    }
    const result = await receivePharmacyPurchase(client as never, {
      tenantId: "t1",
      actorId: "u1",
      supplierId: "s1",
      idempotencyKey: "retry-2",
      lines: [
        {
          productId: "para",
          productName: "Paracetamol",
          quantity: 500,
          unitCost: 200,
          batchNumber: "PAR-01",
          expiryDate: "2027-01-01",
        },
        {
          productId: "cet",
          productName: "Cetirizine",
          quantity: 200,
          unitCost: 350,
          batchNumber: "CET-44",
          expiryDate: "2027-06-01",
        },
      ],
    })
    assert.equal("ok" in result && result.ok, true)
    assert.equal(rpcCalls, 1)
  })

  it("keeps a failed retry on the same key and issues a new key after cancel", () => {
    const first = allocatePurchaseIdempotencyKey(null, () => "key-1")
    const retry = allocatePurchaseIdempotencyKey(first, () => "key-2")
    assert.equal(retry, "key-1")
    const afterCancel = allocatePurchaseIdempotencyKey(null, () => "key-3")
    assert.equal(afterCancel, "key-3")
    assert.notEqual(afterCancel, first)
  })

  it("creates a purchase catalog product with zero opening quantity and audits override", async () => {
    assert.equal(purchaseProductOpeningQuantity(200), 0)
    const audits: unknown[] = []
    const para = {
      id: "para",
      name: "Paracetamol 500 mg Tablets",
      generic_name: "Paracetamol",
      sku: "PARA-500",
      strength: "500 mg",
      dosage_form: "Tablet",
    }
    const client = {
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        const api: Record<string, unknown> = {}
        const self = () => api
        for (const m of ["select", "eq", "limit"]) api[m] = self
        api.insert = (row: Record<string, unknown>) => {
          if (table === "pharmacy_audit_logs") audits.push(row)
          api._row = row
          return api
        }
        api.maybeSingle = async () => ({ data: null, error: null })
        api.single = async () => ({
          data: {
            id: "cet-1",
            name: "Cetirizine 10 mg Tablet",
            sku: "CET-10",
            barcode: null,
            price: 0,
            cost_price: 0,
            generic_name: "Cetirizine",
            strength: "10 mg",
            dosage_form: "Tablet",
            manufacturer: null,
            quantity: (api._row as { quantity?: number } | undefined)?.quantity,
          },
          error: null,
        })
        api.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data: table === "pharmacy_products" ? [para] : [], error: null }))
        return api
      },
    }

    const blocked = await createPurchaseCatalogProduct(client as never, {
      tenantId: "t1",
      actorId: "u1",
      name: "Paracetamol 500 mg Tablets",
      strength: "500 mg",
    })
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.code, "DUPLICATE_PRODUCT")
      assert.equal(blocked.candidates[0]?.id, "para")
    }

    const created = await createPurchaseCatalogProduct(client as never, {
      tenantId: "t1",
      actorId: "u1",
      name: "Paracetamol 500 mg Tablets",
      genericName: "Paracetamol",
      strength: "500 mg",
      dosageForm: "Tablet",
      quantity: 200,
      createAnyway: true,
    })
    assert.equal(created.ok, true)
    if (created.ok) {
      assert.equal(created.duplicateOverride, true)
      assert.equal(created.product.id, "cet-1")
    }
    const audit = audits[0] as { action?: string; details?: string }
    assert.equal(audit.action, "product.created_duplicate_override")
    assert.match(String(audit.details), /para/)
  })

  it("blocks an exact barcode duplicate even with createAnyway", async () => {
    const inserts: unknown[] = []
    const existing = { id: "amx", name: "Amoxicillin 500 mg Capsules", sku: "AMX-500", barcode: "6001234567890" }
    const client = {
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        const api: Record<string, unknown> = {}
        const self = () => api
        for (const m of ["select", "eq", "limit"]) api[m] = self
        api.insert = (row: unknown) => (inserts.push(row), api)
        api.maybeSingle = async () => ({ data: null, error: null })
        api.single = async () => ({ data: { id: "new" }, error: null })
        api.then = (resolve: (value: unknown) => unknown) =>
          Promise.resolve(resolve({ data: table === "pharmacy_products" ? [existing] : [], error: null }))
        return api
      },
    }
    const res = await createPurchaseCatalogProduct(client as never, {
      tenantId: "t1",
      actorId: "u1",
      name: "Totally Different Name",
      barcode: " 6001234567890 ",
      createAnyway: true,
    })
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, "BARCODE_EXISTS")
    assert.equal(inserts.filter((r) => (r as { tenant_id?: string }).tenant_id === "t1" && "sku" in (r as object)).length, 0)
  })

  it("does not match another tenant's barcode or sku", () => {
    const tenantA = [
      { id: "para", name: "Paracetamol 500 mg Tablets", sku: "PARA-500", barcode: "1234567890123" },
    ]
    const foreignBarcode = matchCatalogProducts({ barcode: "9999999999999" }, tenantA)
    const foreignSku = matchCatalogProducts({ sku: "SEC-B" }, tenantA)
    assert.equal(foreignBarcode.length, 0)
    assert.equal(foreignSku.length, 0)
  })

  it("creates a new catalog product at quantity 0 and audits purchase origin", async () => {
    const productInserts: Array<Record<string, unknown>> = []
    const audits: Array<Record<string, unknown>> = []
    const client = {
      rpc: async () => ({ data: null, error: null }),
      from: (table: string) => {
        const api: Record<string, unknown> = {}
        const self = () => api
        for (const m of ["select", "eq", "limit"]) api[m] = self
        api.insert = (row: Record<string, unknown>) => {
          if (table === "pharmacy_products") productInserts.push(row)
          if (table === "pharmacy_audit_logs") audits.push(row)
          api._row = row
          return api
        }
        api.maybeSingle = async () => ({ data: null, error: null })
        api.single = async () => ({
          data: {
            id: "cet-1",
            name: "Cetirizine 10 mg Tablet",
            sku: "CET-10",
            barcode: "6281001234567",
            price: 500,
            cost_price: 0,
            generic_name: "Cetirizine",
            strength: "10 mg",
            dosage_form: "Tablet",
            manufacturer: null,
            quantity: 0,
          },
          error: null,
        })
        api.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null }))
        return api
      },
    }
    const created = await createPurchaseCatalogProduct(client as never, {
      tenantId: "t1",
      actorId: "u1",
      name: "Cetirizine 10 mg Tablet",
      genericName: "Cetirizine",
      strength: "10 mg",
      dosageForm: "Tablet",
      barcode: "6281001234567",
      sellingPrice: 500,
      quantity: 200,
    })
    assert.equal(created.ok, true)
    if (created.ok) {
      assert.equal(created.duplicateOverride, false)
      assert.equal(created.product.id, "cet-1")
    }
    assert.equal(productInserts[0]?.quantity, 0)
    assert.equal(productInserts[0]?.tenant_id, "t1")
    assert.equal(audits[0]?.action, "product.created_from_purchase")
  })

  it("receives mixed existing Paracetamol and new Cetirizine stock exactly once", async () => {
    const rpcArgs: Array<Record<string, unknown>> = []
    let purchaseInserts = 0
    let itemInserts = 0
    const client = {
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        rpcArgs.push(args)
        const productId = String(args.p_product_id ?? args.product_id ?? "")
        return {
          data: { batch_id: productId === "para" ? "b-para" : "b-cet", product_id: productId, received: args.p_quantity ?? args.quantity },
          error: null,
        }
      },
      from: (table: string) => {
        const api: Record<string, unknown> = {}
        const self = () => api
        for (const m of ["select", "insert", "update", "delete", "eq", "upsert"]) api[m] = self
        api.insert = (row: unknown) => {
          if (table === "pharmacy_purchases") purchaseInserts += 1
          if (table === "pharmacy_purchase_items") {
            itemInserts += Array.isArray(row) ? row.length : 1
          }
          return api
        }
        api.maybeSingle = async () => {
          if (table === "pharmacy_purchase_idempotency") return { data: null, error: null }
          if (table === "pharmacy_suppliers") return { data: { id: "s1", name: "Supplier A" }, error: null }
          if (table === "pharmacy_product_batches") return { data: null, error: null }
          return { data: null, error: null }
        }
        api.single = async () => ({ data: { id: "p-mix", purchase_no: "PUR-MIX" }, error: null })
        if (table === "pharmacy_purchase_items") {
          api.select = () => ({
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(
                resolve({
                  data: [
                    {
                      id: "i-para",
                      product_id: "para",
                      quantity: 500,
                      received_quantity: 0,
                      unit_cost: 200,
                      batch_number: "PAR-01",
                      expiry_date: "2027-01-01",
                      selling_price: null,
                      receipt_idempotency_key: "mix-1:line-para:PAR-01",
                      purchase_order_item_id: null,
                    },
                    {
                      id: "i-cet",
                      product_id: "cet-1",
                      quantity: 200,
                      received_quantity: 0,
                      unit_cost: 350,
                      batch_number: "CET-44",
                      expiry_date: "2027-06-01",
                      selling_price: null,
                      receipt_idempotency_key: "mix-1:line-cet:CET-44",
                      purchase_order_item_id: null,
                    },
                  ],
                  error: null,
                }),
              ),
          })
        }
        return api
      },
    }

    const result = await receivePharmacyPurchase(client as never, {
      tenantId: "t1",
      actorId: "u1",
      supplierId: "s1",
      idempotencyKey: "mix-1",
      lines: [
        {
          clientItemId: "line-para",
          productId: "para",
          productName: "Paracetamol 500 mg Tablets",
          quantity: 500,
          unitCost: 200,
          batchNumber: "PAR-01",
          expiryDate: "2027-01-01",
        },
        {
          clientItemId: "line-cet",
          productId: "cet-1",
          productName: "Cetirizine 10 mg Tablet",
          quantity: 200,
          unitCost: 350,
          batchNumber: "CET-44",
          expiryDate: "2027-06-01",
        },
      ],
    })
    assert.equal("ok" in result && result.ok, true)
    if ("ok" in result && result.ok) {
      assert.equal(result.replay, undefined)
      assert.equal(result.received.length, 2)
      assert.equal(result.received[0]?.productId, "para")
      assert.equal(result.received[1]?.productId, "cet-1")
    }
    assert.equal(purchaseInserts, 1)
    assert.equal(itemInserts, 2)
    assert.equal(rpcArgs.length, 2)
    assert.deepEqual(
      rpcArgs.map((args) => args.p_product_id),
      ["para", "cet-1"],
    )
    assert.deepEqual(
      rpcArgs.map((args) => args.p_quantity),
      [500, 200],
    )
  })


  it("ranks barcode and SKU matches above fuzzy names", () => {
    const catalog = [
      { id: "name-hit", name: "Something 500", sku: "X", barcode: "000" },
      { id: "code-hit", name: "Other", sku: "CET-10", barcode: "6281001234567" },
    ]
    const barcode = matchCatalogProducts({ barcode: "6281001234567", q: "something" }, catalog)
    assert.equal(barcode[0]?.id, "code-hit")
    const sku = matchCatalogProducts({ sku: "CET-10" }, catalog)
    assert.equal(sku[0]?.id, "code-hit")
  })

  it("does not silently merge Amoxicillin 250 mg with Amoxicillin 500 mg by name", () => {
    assert.equal(IMPORT_QUANTITY_SEMANTICS, "STOCK_RECEIPT_DELTA")
    const catalog = [
      catalogProductFromRow({
        id: "amox-500",
        name: "Amoxicillin",
        strength: "500 mg",
        dosage_form: "Capsule",
        sku: "AMX-500",
        barcode: null,
      }),
      catalogProductFromRow({
        id: "amox-250",
        name: "Amoxicillin",
        strength: "250 mg",
        dosage_form: "Capsule",
        sku: "AMX-250",
        barcode: null,
      }),
    ]
    const hit = resolveImportCatalogMatch(
      { name: "Amoxicillin", strength: "250 mg", dosageForm: "Capsule" },
      catalog,
    )
    assert.equal(hit.kind, "match")
    if (hit.kind === "match") assert.equal(hit.product.id, "amox-250")

    const clash = resolveImportCatalogMatch(
      { name: "Amoxicillin", strength: "125 mg", dosageForm: "Capsule" },
      catalog,
    )
    assert.equal(clash.kind, "ambiguous_name")

    const bareName = resolveImportCatalogMatch({ name: "Amoxicillin" }, catalog)
    assert.equal(bareName.kind, "ambiguous_name")
  })

  it("prefers barcode and SKU and rejects form/strength collisions", () => {
    const catalog = [
      catalogProductFromRow({
        id: "para-tab",
        name: "Paracetamol",
        strength: "500 mg",
        dosage_form: "Tablet",
        sku: "PARA-TAB",
        barcode: "1111111111111",
      }),
      catalogProductFromRow({
        id: "para-syr",
        name: "Paracetamol",
        strength: "120 mg/5ml",
        dosage_form: "Syrup",
        sku: "PARA-SYR",
        barcode: "2222222222222",
      }),
      catalogProductFromRow({
        id: "ibuprofen-cap",
        name: "Ibuprofen",
        strength: "200 mg",
        dosage_form: "Capsule",
        sku: "IBU-200-CAP",
        barcode: "3333333333333",
      }),
      catalogProductFromRow({
        id: "ibuprofen-tab",
        name: "Ibuprofen",
        strength: "200 mg",
        dosage_form: "Tablet",
        sku: "IBU-200-TAB",
        barcode: "4444444444444",
      }),
    ]

    const byBarcode = resolveImportCatalogMatch(
      { barcode: "1111111111111", name: "Wrong Name", strength: "999 mg" },
      catalog,
    )
    assert.equal(byBarcode.kind, "ambiguous_name")

    const barcodeOk = resolveImportCatalogMatch(
      { barcode: "1111111111111", name: "Paracetamol", strength: "500 mg", dosageForm: "Tablet" },
      catalog,
    )
    assert.equal(barcodeOk.kind, "match")
    if (barcodeOk.kind === "match") {
      assert.equal(barcodeOk.via, "barcode")
      assert.equal(barcodeOk.product.id, "para-tab")
    }

    const bySku = resolveImportCatalogMatch(
      {
        sku: "PARA-SYR",
        name: "Paracetamol",
        strength: "120 mg/5ml",
        dosageForm: "Syrup",
      },
      catalog,
    )
    assert.equal(bySku.kind, "match")
    if (bySku.kind === "match") {
      assert.equal(bySku.via, "sku")
      assert.equal(bySku.product.id, "para-syr")
    }

    const tabletVsSyrup = resolveImportCatalogMatch(
      { name: "Paracetamol", strength: "120 mg/5ml", dosageForm: "Syrup" },
      catalog,
    )
    assert.equal(tabletVsSyrup.kind, "match")
    if (tabletVsSyrup.kind === "match") assert.equal(tabletVsSyrup.product.id, "para-syr")

    const sameStrengthDiffForm = resolveImportCatalogMatch(
      { name: "Ibuprofen", strength: "200 mg", dosageForm: "Tablet" },
      catalog,
    )
    assert.equal(sameStrengthDiffForm.kind, "match")
    if (sameStrengthDiffForm.kind === "match") assert.equal(sameStrengthDiffForm.product.id, "ibuprofen-tab")

    const bareIbuprofen = resolveImportCatalogMatch({ name: "Ibuprofen", strength: "200 mg" }, catalog)
    assert.equal(bareIbuprofen.kind, "ambiguous_name")

    const missingIdentity = resolveImportCatalogMatch({ name: "Paracetamol" }, catalog)
    assert.equal(missingIdentity.kind, "ambiguous_name")

    const exactIngredient = resolveImportCatalogMatch(
      {
        name: "Ibuprofen",
        strength: "200 MG",
        dosageForm: " tablet ",
        activeIngredient: "",
      },
      catalog,
    )
    assert.equal(exactIngredient.kind, "match")
    if (exactIngredient.kind === "match") assert.equal(exactIngredient.product.id, "ibuprofen-tab")

    const brandNew = resolveImportCatalogMatch(
      { name: "SYNAPSE Acceptance Widget", sku: "ACCEPT-NEW-1" },
      catalog,
    )
    assert.equal(brandNew.kind, "none")
  })
})
