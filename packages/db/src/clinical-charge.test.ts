import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { appendClinicalCharge, materializeEncounterCharges, resolveServicePrice, voidClinicalCharge } from "./clinical-charge.ts"

function catalogDb(rows: Array<{ tenant_id: string; service_type: string; name: string; price: number; is_active: boolean }>) {
  return {
    from(_table: string) {
      const self: Record<string, unknown> = {}
      const chain = () => self
      let filtered = rows
      self.select = chain
      self.eq = (col: string, value: unknown) => {
        filtered = filtered.filter((row) => (row as Record<string, unknown>)[col] === value)
        return self
      }
      self.ilike = (col: string, value: string) => {
        const needle = value.replaceAll("%", "").toLowerCase()
        filtered = filtered.filter((row) => String((row as Record<string, unknown>)[col] ?? "").toLowerCase().includes(needle))
        return self
      }
      self.order = chain
      self.limit = chain
      self.maybeSingle = async () => ({ data: filtered[0] ?? null, error: null })
      return self
    },
  }
}

function chargeMemoryDb(seed?: {
  encounter?: Record<string, unknown>
  labOrders?: Array<Record<string, unknown>>
  prescriptions?: Array<Record<string, unknown>>
  products?: Array<Record<string, unknown>>
  catalog?: Array<Record<string, unknown>>
}) {
  const invoices: Record<string, unknown>[] = []
  const lines: Record<string, unknown>[] = []
  return {
    invoices,
    lines,
    from(table: string) {
      const filters: Array<[string, unknown]> = []
      const neq: Array<[string, unknown]> = []
      const q: Record<string, unknown> = {}
      const rows = () => {
        const src =
          table === "billing_invoices" ? invoices
          : table === "billing_line_items" ? lines
          : table === "encounters" ? (seed?.encounter ? [seed.encounter] : [])
          : table === "lab_orders" ? (seed?.labOrders ?? [])
          : table === "clinical_prescriptions" ? (seed?.prescriptions ?? [])
          : table === "pharmacy_products" ? (seed?.products ?? [])
          : table === "service_catalog" ? (seed?.catalog ?? [])
          : []
        return src.filter((row) =>
          filters.every(([col, val]) => row[col] === val) &&
          neq.every(([col, val]) => row[col] !== val),
        )
      }
      q.select = () => q
      q.eq = (col: string, val: unknown) => {
        filters.push([col, val])
        return q
      }
      q.neq = (col: string, val: unknown) => {
        neq.push([col, val])
        return q
      }
      q.ilike = (col: string, value: string) => {
        const needle = value.replaceAll("%", "").toLowerCase()
        filters.push([`__ilike_${col}`, needle])
        return q
      }
      q.order = () => q
      q.limit = () => q
      q.maybeSingle = async () => {
        const matched = table === "service_catalog"
          ? (seed?.catalog ?? []).filter((row) => {
              const tenant = filters.find(([c]) => c === "tenant_id")?.[1]
              const type = filters.find(([c]) => c === "service_type")?.[1]
              const active = filters.find(([c]) => c === "is_active")?.[1]
              const needle = filters.find(([c]) => c.startsWith("__ilike_"))?.[1]
              if (tenant && row.tenant_id !== tenant) return false
              if (type && row.service_type !== type) return false
              if (active != null && row.is_active !== active) return false
              if (needle && !String(row.name).toLowerCase().includes(String(needle))) return false
              return true
            })
          : rows()
        return { data: matched[0] ?? null, error: null }
      }
      q.insert = (row: Record<string, unknown>) => {
        const stored = { ...row }
        if (table === "billing_invoices") invoices.push(stored)
        if (table === "billing_line_items") {
          stored.total_price = Number(stored.qty) * Number(stored.unit_price)
          lines.push(stored)
        }
        const inner: Record<string, unknown> = {}
        inner.select = () => inner
        inner.single = async () => ({ data: stored, error: null })
        return inner
      }
      q.update = (patch: Record<string, unknown>) => {
        const u: Record<string, unknown> = {}
        u.eq = (col: string, val: unknown) => {
          filters.push([col, val])
          return u
        }
        u.then = (resolve: (value: { error: null }) => unknown) => {
          for (const row of rows()) Object.assign(row, patch)
          return Promise.resolve({ error: null }).then(resolve)
        }
        return u
      }
      q.then = (resolve: (value: { data: Record<string, unknown>[]; error: null }) => unknown) =>
        Promise.resolve({ data: rows(), error: null }).then(resolve)
      return q
    },
  }
}

describe("server-authoritative service prices", () => {
  it("uses catalog price and ignores a client-supplied total", async () => {
    const db = catalogDb([
      { tenant_id: "t1", service_type: "consultation", name: "OPD consult", price: 15000, is_active: true },
    ])
    const clientAttempt = 1
    const server = await resolveServicePrice(db, "t1", "consultation", "consult")
    assert.equal(server, 15000)
    assert.notEqual(server, clientAttempt)
  })

  it("does not leak tenant B prices into tenant A", async () => {
    const db = catalogDb([
      { tenant_id: "tB", service_type: "lab", name: "FBC", price: 99, is_active: true },
    ])
    const price = await resolveServicePrice(db, "tA", "lab", "FBC")
    assert.equal(price, null)
  })

  it("treats configured zero as a valid government/waived price", async () => {
    const db = catalogDb([
      { tenant_id: "t1", service_type: "consultation", name: "OPD Consultation", price: 0, is_active: true },
    ])
    assert.equal(await resolveServicePrice(db, "t1", "consultation", "OPD"), 0)
  })
})

describe("clinical charge capture", () => {
  const tenantId = "0edb651a-232a-4289-9b3d-ae5bb1bac2cb"
  const patientId = "19bc626f-f51a-4bd5-aefd-7a4534babfeb"
  const encounterId = "72603ece-b91a-45ad-a6bc-c59bff1162db"
  const staff = "81456280-e996-4ff3-84ba-cada261d5061"
  const labId = "ff2ed387-f5d4-4fdc-9a55-17d295466257"

  it("omits created_by so Hospital profile ids do not hit auth.users", async () => {
    const db = chargeMemoryDb()
    await appendClinicalCharge(db, {
      tenantId,
      patientId,
      encounterId,
      itemName: "Lab · FBC",
      unitPrice: 15000,
      sourceTable: "lab_orders",
      sourceId: labId,
      createdBy: staff,
    })
    assert.equal("created_by" in db.invoices[0]!, false)
    assert.equal("created_by" in db.lines[0]!, false)
    assert.equal(db.invoices[0]!.tenant_id, tenantId)
    assert.equal(db.invoices[0]!.encounter_id, encounterId)
  })

  it("does not duplicate a lab charge on retry", async () => {
    const db = chargeMemoryDb()
    const first = await appendClinicalCharge(db, {
      tenantId,
      patientId,
      encounterId,
      itemName: "Lab · FBC",
      unitPrice: 15000,
      sourceTable: "lab_orders",
      sourceId: labId,
    })
    const second = await appendClinicalCharge(db, {
      tenantId,
      patientId,
      encounterId,
      itemName: "Lab · FBC",
      unitPrice: 15000,
      sourceTable: "lab_orders",
      sourceId: labId,
    })
    assert.equal(db.lines.length, 1)
    assert.equal(first.lineItemId, second.lineItemId)
    assert.equal(second.created, false)
    assert.equal(first.totalAmount, 15000)
  })

  it("materializes signed consult + released lab + dispensed medication once", async () => {
    const db = chargeMemoryDb({
      encounter: { id: encounterId, patient_id: patientId, tenant_id: tenantId, is_signed: true, status: "completed" },
      labOrders: [
        { id: labId, test_name: "FBC", tenant_id: tenantId, encounter_id: encounterId },
        { id: "88f3041d-76a1-4fe7-b5de-12c2c8de9a4a", test_name: "Malaria RDT", tenant_id: tenantId, encounter_id: encounterId },
      ],
      prescriptions: [{
        id: "89e1ea34-f4f6-4330-bc8e-51eec83a5fed",
        medication_display: "Paracetamol 500mg",
        quantity: 9,
        status: "dispensed",
        pharmacy_order_id: "146e93b2-191e-4020-a6cc-448b2d4ae9e8",
        tenant_id: tenantId,
        encounter_id: encounterId,
      }],
      products: [{ name: "Paracetamol 500mg", price: 200, tenant_id: tenantId, is_active: true }],
      catalog: [
        { tenant_id: tenantId, service_type: "consultation", name: "OPD Consultation", price: 10000, is_active: true },
        { tenant_id: tenantId, service_type: "lab", name: "FBC", price: 15000, is_active: true },
        { tenant_id: tenantId, service_type: "lab", name: "Malaria RDT", price: 8000, is_active: true },
      ],
    })
    const first = await materializeEncounterCharges(db, { tenantId, encounterId })
    const second = await materializeEncounterCharges(db, { tenantId, encounterId })
    const third = await materializeEncounterCharges(db, { tenantId, encounterId })
    assert.equal(first.encounterFound, true)
    assert.equal(db.invoices.length, 1)
    assert.equal(db.lines.length, 4)
    assert.equal(first.invoiceId, second.invoiceId)
    assert.equal(second.invoiceId, third.invoiceId)
    const total = db.lines.reduce((sum, row) => sum + Number(row.qty) * Number(row.unit_price), 0)
    assert.equal(total, 10000 + 15000 + 8000 + 200 * 9)
    assert.equal(Number(db.invoices[0]!.total_amount), total)
  })

  it("does not materialize another tenant encounter", async () => {
    const db = chargeMemoryDb({
      encounter: { id: encounterId, patient_id: patientId, tenant_id: tenantId, is_signed: true, status: "completed" },
    })
    const other = await materializeEncounterCharges(db, {
      tenantId: "200dfeb5-4c09-4a5d-8d46-14aa4b78a6ec",
      encounterId,
    })
    assert.equal(other.encounterFound, false)
    assert.equal(db.invoices.length, 0)
  })

  it("does not invent a price when the catalog has no matching service", async () => {
    const db = chargeMemoryDb({
      encounter: { id: encounterId, patient_id: patientId, tenant_id: tenantId, is_signed: true, status: "completed" },
      labOrders: [{ id: labId, test_name: "FBC", tenant_id: tenantId, encounter_id: encounterId }],
      catalog: [],
    })
    const result = await materializeEncounterCharges(db, { tenantId, encounterId })
    assert.equal(result.encounterFound, true)
    assert.equal(result.invoiceId, null)
    assert.equal(db.lines.length, 0)
    assert.ok(result.warnings.some((row) => row.startsWith("SERVICE_PRICE_NOT_CONFIGURED:encounters:")))
    assert.ok(result.warnings.some((row) => row.includes(`lab_orders:${labId}`)))
  })

  it("captures a configured zero-price government service without treating it as missing", async () => {
    const db = chargeMemoryDb({
      encounter: { id: encounterId, patient_id: patientId, tenant_id: tenantId, is_signed: true, status: "completed" },
      catalog: [
        { tenant_id: tenantId, service_type: "consultation", name: "OPD Consultation", price: 0, is_active: true },
      ],
    })
    const result = await materializeEncounterCharges(db, { tenantId, encounterId })
    assert.equal(result.invoiceId, db.invoices[0]!.id)
    assert.equal(db.lines.length, 1)
    assert.equal(Number(db.lines[0]!.unit_price), 0)
    assert.equal(result.warnings.length, 0)
  })

  it("does not charge cancelled Lab orders or replacement recollections", async () => {
    const rejectedId = "0b0c2f4e-3a53-4d38-9a52-0b1f7f2d9d11"
    const db = chargeMemoryDb({
      encounter: { id: encounterId, patient_id: patientId, tenant_id: tenantId, is_signed: false, status: "in_progress" },
      labOrders: [
        { id: labId, test_name: "FBC", workflow_status: "CANCELLED", tenant_id: tenantId, encounter_id: encounterId },
        { id: "5c1d5a6c-8f0e-4a7e-9d51-2f0f4b1e2a33", test_name: "FBC", status: "cancelled", workflow_status: null, tenant_id: tenantId, encounter_id: encounterId },
        { id: rejectedId, test_name: "Malaria RDT", workflow_status: "REJECTED", tenant_id: tenantId, encounter_id: encounterId },
        { id: "6d2e6b7d-9f1f-4b8f-8e62-3a1f5c2f3b44", test_name: "Malaria RDT", workflow_status: "RELEASED", replaces_lab_order_id: rejectedId, tenant_id: tenantId, encounter_id: encounterId },
      ],
      catalog: [
        { tenant_id: tenantId, service_type: "lab", name: "FBC", price: 15000, is_active: true },
        { tenant_id: tenantId, service_type: "lab", name: "Malaria RDT", price: 8000, is_active: true },
      ],
    })
    await materializeEncounterCharges(db, { tenantId, encounterId })
    assert.deepEqual(db.lines.map((row) => row.item_name), ["Lab · Malaria RDT"])
    assert.equal(Number(db.invoices[0]!.total_amount), 8000)
  })

  it("voids an unpaid charge once and never rewrites a settled invoice", async () => {
    const charge = { tenantId, patientId, encounterId, itemName: "Lab · FBC", unitPrice: 15000, sourceTable: "lab_orders", sourceId: labId }
    const unpaid = chargeMemoryDb()
    await appendClinicalCharge(unpaid, { ...charge, sourceId: "7e3f7c8e-0a2a-4c9a-9f73-4b2a6d3a4c55", itemName: "Lab · RDT", unitPrice: 8000 })
    await appendClinicalCharge(unpaid, charge)
    const ref = { tenantId, encounterId, sourceTable: "lab_orders", sourceId: labId }
    assert.deepEqual(await voidClinicalCharge(unpaid, ref), { voided: true })
    assert.equal(Number(unpaid.invoices[0]!.total_amount), 8000)
    assert.deepEqual(await voidClinicalCharge(unpaid, ref), { voided: false, reason: "NO_CHARGE" })

    const partlyPaid = chargeMemoryDb()
    await appendClinicalCharge(partlyPaid, charge)
    partlyPaid.invoices[0]!.paid_amount = 5000
    assert.deepEqual(await voidClinicalCharge(partlyPaid, ref), { voided: false, reason: "INVOICE_LOCKED" })

    const paid = chargeMemoryDb()
    await appendClinicalCharge(paid, charge)
    Object.assign(paid.invoices[0]!, { status: "paid", paid_amount: 15000 })
    assert.deepEqual(await voidClinicalCharge(paid, ref), { voided: false, reason: "INVOICE_LOCKED" })
    assert.equal(paid.lines[0]!.is_deleted, false)
    assert.equal(Number(paid.invoices[0]!.total_amount), 15000)
  })
})
