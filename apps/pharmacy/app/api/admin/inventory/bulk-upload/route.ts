import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { normalizeBarcode } from "@/lib/barcode"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { validateImportRow } from "@synapse/db/import-validation"
import { receivePharmacyStock } from "@synapse/db/inventory-rpc"
import {
  catalogProductFromRow,
  resolveImportCatalogMatch,
} from "@synapse/db/pharmacy-purchases"
import Papa from "papaparse"
import * as XLSX from "xlsx"
import {
  assertCsvRowCap,
  assertRowCap,
  checkImportFile,
  importErrorResponse,
  neutralizeRow,
  SAFE_XLSX_READ_OPTS,
} from "@/lib/import-guard"

const db = () => supabaseAdmin as any

// Helper function to find value from multiple possible column names
function getFieldValue(
  data: Record<string, unknown>,
  ...possibleNames: string[]
): string | null {
  for (const name of possibleNames) {
    const lowerName = name.toLowerCase()
    for (const key of Object.keys(data)) {
      if (key.toLowerCase() === lowerName || key.toLowerCase().includes(lowerName)) {
        const value = data[key]
        if (value !== undefined && value !== null && value !== "") {
          return String(value).trim()
        }
      }
    }
  }
  return null
}

// Helper to parse number, handling commas and currency symbols
function parseNumber(value: string | null): number {
  if (!value) return 0
  const cleaned = value.replace(/[₹$,\s]/g, "").trim()
  const num = parseFloat(cleaned)
  return isNaN(num) ? 0 : num
}

// Helper to generate SKU from product name if not provided
function generateSKU(name: string, index: number): string {
  const prefix = name
    .split(" ")
    .slice(0, 2)
    .map((word) => word.substring(0, 3).toUpperCase())
    .join("")
  return `${prefix}-${Date.now()}-${index}`
}

export async function POST(request: NextRequest) {
  try {
    // Creating products and receiving stock is an inventory-management action.
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const formData = await request.formData()
    const file = formData.get("file") as File | null

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 })
    }

    // Size, extension, MIME and magic-byte checks happen before any parser runs.
    const { kind, bytes } = await checkImportFile(file, ["csv", "xlsx", "xls"])
    let parsedData: Record<string, unknown>[] = []

    if (kind === "xlsx" || kind === "xls") {
      const workbook = XLSX.read(bytes, SAFE_XLSX_READ_OPTS)
      const sheetName = workbook.SheetNames[0]
      if (!sheetName) {
        return NextResponse.json({ error: "No sheets found in Excel file" }, { status: 400 })
      }
      const worksheet = workbook.Sheets[sheetName]
      parsedData = XLSX.utils.sheet_to_json(worksheet, { defval: "", raw: false }) as Record<string, unknown>[]
    } else {
      const text = new TextDecoder().decode(bytes)
      assertCsvRowCap(text)
      const results = Papa.parse<Record<string, unknown>>(text, {
        header: true,
        skipEmptyLines: true,
      })
      parsedData = results.data
    }
    assertRowCap(parsedData.length)
    parsedData = parsedData.map((row) => neutralizeRow(row))

    if (!parsedData || parsedData.length === 0) {
      return NextResponse.json({ error: "No data found in file" }, { status: 400 })
    }

    // Pre-load suppliers for this tenant to avoid N+1 lookups
    const { data: supplierRows } = await supabaseAdmin
      .from("pharmacy_suppliers")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
    const supplierMap = new Map<string, string>(
      (supplierRows ?? []).map((s) => [(s.name as string).toLowerCase(), s.id as string])
    )

    const errors: string[] = []
    const warnings: string[] = []
    const skippedDuplicates: string[] = []
    const seenSkus = new Set<string>()
    const seenBarcodes = new Set<string>()
    let created = 0
    let merged = 0
    let receivedBatches = 0
    const existingProducts: ReturnType<typeof catalogProductFromRow>[] = []
    for (let from = 0; ; from += 1000) {
      const { data: productRows, error: productsError } = await db()
        .from("pharmacy_products")
        .select("id, name, sku, barcode, strength, dosage_form, active_ingredient, generic_name")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .range(from, from + 999)
      if (productsError) {
        console.error("[inventory-import] catalog lookup failed:", productsError)
        return NextResponse.json({ error: "Could not check existing medicine identities" }, { status: 500 })
      }
      existingProducts.push(...(productRows ?? []).map(catalogProductFromRow))
      if ((productRows ?? []).length < 1000) break
    }

    for (const [index, data] of parsedData.entries()) {
      const rowNumber = index + 2
      const name = getFieldValue(
        data,
        "name", "item name", "stock item", "product name", "particulars",
        "item", "product", "medicine name", "drug name"
      )

      // Skip empty rows
      if (!name) continue

      let sku = getFieldValue(
        data,
        "sku", "part no", "part number", "item code", "product code",
        "hsn code", "hsn", "code", "item no"
      )

      const category =
        getFieldValue(
          data,
          "category", "group", "under", "item group", "product group",
          "stock group", "type", "classification"
        ) || "General"

      const priceStr = getFieldValue(
        data,
        "price", "rate", "selling price", "mrp", "sale rate", "sales price",
        "retail price", "sp", "selling rate", "unit price"
      )

      const costPriceStr = getFieldValue(
        data,
        "cost_price", "costprice", "cost price", "purchase price", "cost", "purchase rate",
        "cp", "buying price", "purchase cost", "landed cost"
      )

      const quantityStr = getFieldValue(
        data,
        "quantity", "qty", "stock", "closing stock", "balance",
        "opening stock", "stock qty", "available", "in stock", "closing balance"
      )

      const barcode = normalizeBarcode(getFieldValue(data, "barcode", "bar code", "upc", "ean"))

      const unitOfMeasure =
        getFieldValue(data, "unit_of_measure", "unit", "unitofmeasure", "uom", "unit of measure", "base unit") ||
        "Unit"

      const batchNumber =
        getFieldValue(
          data,
          "batch_number", "batchnumber", "batch number", "batch no", "batch", "lot number", "lot no"
        ) || null

      const manufacturer =
        getFieldValue(
          data,
          "manufacturer", "mfg", "brand", "company", "make"
        ) || null

      const expiryDateStr = getFieldValue(
        data,
        "expiry_date", "expirydate", "expiry date", "expiry", "exp date", "exp", "best before"
      )

      const description =
        getFieldValue(data, "description", "remarks", "notes", "details", "narration") || null

      const reorderLevelStr = getFieldValue(
        data,
        "reorder_level", "reorderlevel", "reorder level", "reorder", "min stock", "minimum stock"
      )

      const genericName =
        getFieldValue(data, "generic_name", "generic name", "generic", "inn") || null
      const activeIngredient =
        getFieldValue(data, "active_ingredient", "active ingredient", "ingredient") || null

      const dosageForm =
        getFieldValue(data, "dosage_form", "dosage form", "form", "formulation") || null

      const strength =
        getFieldValue(data, "strength", "potency", "concentration") || null

      const requiresPrescriptionRaw =
        getFieldValue(data, "requires_prescription", "prescription", "rx") ?? "no"
      const requiresPrescription =
        requiresPrescriptionRaw.toLowerCase() === "yes" ||
        requiresPrescriptionRaw.toLowerCase() === "true" ||
        requiresPrescriptionRaw === "1"

      const supplierName = getFieldValue(data, "supplier", "supplier name") ?? ""
      const supplierId = supplierName
        ? supplierMap.get(supplierName.toLowerCase()) ?? null
        : null

      if (!sku) {
        sku = generateSKU(name, index)
      }

      const price = parseNumber(priceStr)
      const costPrice = parseNumber(costPriceStr) || price * 0.7
      const reorderLevel = Math.round(parseNumber(reorderLevelStr)) || 10
      const resolvedPrice = price > 0 ? price : costPrice * 1.3
      const resolvedCost = costPrice > 0 ? costPrice : price * 0.7

      const validation = validateImportRow(
        {
          name,
          sku,
          price: resolvedPrice,
          costPrice: resolvedCost,
          quantity: quantityStr,
          batchNumber,
          expiryDate: expiryDateStr,
        },
        rowNumber,
      )

      errors.push(...validation.errors)
      warnings.push(...validation.warnings)

      if (!validation.productOk) continue

      // Check for duplicate SKU in database (scoped to tenant)
      const { data: existingProduct } = await db()
        .from("pharmacy_products")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("sku", sku)
        .maybeSingle()

      if (existingProduct) {
        skippedDuplicates.push(`Row ${rowNumber}: SKU "${sku}" already exists (${name})`)
        continue
      }

      const identityMatch = resolveImportCatalogMatch(
        { name, strength, dosageForm, activeIngredient },
        existingProducts,
      )
      if (identityMatch.kind === "ambiguous_name") {
        skippedDuplicates.push(
          `Row ${rowNumber}: "${name}" matches a medicine name but strength, dosage form, or active ingredient is not an exact match; review it manually`,
        )
        continue
      }

      if (identityMatch.kind === "match" && identityMatch.via === "name") {
        if (barcode) {
          const { data: barcodeOwner } = await db()
            .from("pharmacy_products")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("barcode", barcode)
            .maybeSingle()
          if (barcodeOwner && barcodeOwner.id !== identityMatch.product.id) {
            skippedDuplicates.push(`Row ${rowNumber}: barcode "${barcode}" belongs to another product (${name})`)
            continue
          }
          seenBarcodes.add(barcode)
        }

        if (!validation.batch) {
          skippedDuplicates.push(
            `Row ${rowNumber}: "${name}" matches existing medicine ${identityMatch.product.id}; no valid batch stock was provided`,
          )
          continue
        }

        const { error: receiveError } = await receivePharmacyStock(db(), {
          tenantId,
          productId: identityMatch.product.id,
          batchNumber: validation.batch.batchNumber,
          quantity: validation.batch.quantity,
          expiryDate: validation.batch.expiryDate,
          costPrice: resolvedCost,
          sellingPrice: resolvedPrice,
          receivedBy: session.user.id,
          supplierId,
          reason: `Bulk import receive (matched ${identityMatch.product.id})`,
        })
        if (receiveError) {
          warnings.push(
            `Row ${rowNumber}: existing medicine matched but stock was not received — ${receiveError.humanMessage}`,
          )
          continue
        }
        merged += 1
        receivedBatches += 1
        continue
      }

      // Barcodes are unique per pharmacy: skip rows whose barcode exists or repeats in the file.
      if (barcode) {
        const { data: barcodeOwner } = await db()
          .from("pharmacy_products")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("barcode", barcode)
          .maybeSingle()
        if (barcodeOwner || seenBarcodes.has(barcode)) {
          skippedDuplicates.push(`Row ${rowNumber}: barcode "${barcode}" already exists (${name})`)
          continue
        }
        seenBarcodes.add(barcode)
      }

      // Check for duplicate SKU in current batch
      let finalSku = sku
      if (seenSkus.has(finalSku)) {
        finalSku = `${sku}-${index}`
      }
      seenSkus.add(finalSku)

      // Catalogue insert always starts at quantity 0 — stock only via receivePharmacyStock
      const { data: product, error: insertError } = await db()
        .from("pharmacy_products")
        .insert({
          tenant_id: tenantId,
          name,
          sku: finalSku,
          barcode,
          category,
          price: resolvedPrice,
          cost_price: resolvedCost,
          quantity: 0,
          reorder_level: reorderLevel,
          unit_of_measure: unitOfMeasure,
          description,
          batch_number: validation.batch?.batchNumber ?? null,
          manufacturer,
          expiry_date: validation.batch?.expiryDate ?? null,
          generic_name: genericName,
          active_ingredient: activeIngredient,
          dosage_form: dosageForm,
          strength,
          requires_prescription: requiresPrescription,
          supplier_id: supplierId,
        })
        .select("id")
        .single()

      if (insertError || !product) {
        errors.push(`Row ${rowNumber}: ${insertError?.code === "23505" ? "duplicate SKU or barcode" : "could not be saved"}`)
        continue
      }

      created += 1
      existingProducts.push(
        catalogProductFromRow({
          id: product.id,
          name,
          sku: finalSku,
          barcode,
          strength,
          dosage_form: dosageForm,
          active_ingredient: activeIngredient,
          generic_name: genericName,
        }),
      )

      if (validation.batch) {
        const { error: receiveError } = await receivePharmacyStock(db(), {
          tenantId,
          productId: product.id,
          batchNumber: validation.batch.batchNumber,
          quantity: validation.batch.quantity,
          expiryDate: validation.batch.expiryDate,
          costPrice: resolvedCost,
          sellingPrice: resolvedPrice,
          receivedBy: session.user.id,
          supplierId,
          reason: "Bulk import receive",
        })
        if (receiveError) {
          warnings.push(
            `Row ${rowNumber}: product created but stock not received — ${receiveError.humanMessage}`,
          )
        } else {
          receivedBatches += 1
        }
      }
    }

    if (created === 0 && merged === 0) {
      return NextResponse.json(
        {
          error: "No valid products to create",
          details: errors,
          warnings: warnings.length > 0 ? warnings : undefined,
          skipped: skippedDuplicates,
          hint: "Make sure your file has columns for: name, price (or cost_price). Stock becomes sellable only with genuine batch number, quantity, and future expiry.",
        },
        { status: 400 }
      )
    }

    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "BULK_UPLOAD_PRODUCTS",
      entity: "PRODUCT",
      entity_id: null,
      details: `Bulk uploaded ${created} products, consolidated ${merged} exact-identity rows (${receivedBatches} batches received)`,
    })

    return NextResponse.json({
      success: true,
      count: created,
      merged,
      receivedBatches,
      errors: errors.length > 0 ? errors : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      skipped: skippedDuplicates.length > 0 ? skippedDuplicates : undefined,
    })
  } catch (error) {
    const rejected = importErrorResponse(error)
    if (rejected) return NextResponse.json(rejected.body, { status: rejected.status })
    console.error("Bulk upload error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
