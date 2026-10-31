import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { tenantRefsNotFound } from "@/lib/tenant-refs"
import { duplicateBarcodeResponse, normalizeBarcode } from "@/lib/barcode"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { summarizeInventory, kampalaToday, normaliseBatch, isSellableBatch } from "@synapse/db/inventory"
import { receivePharmacyStock } from "@synapse/db/inventory-rpc"
import { pharmacyDomainError, httpStatusForPharmacyError } from "@synapse/db/errors"
import {
  catalogueOpeningQuantity,
  catalogueQuantityPatchForbidden,
  catalogueBatchMutationForbidden,
} from "@/lib/inventory/catalogue-write"
import {
  catalogProductFromRow,
  resolveImportCatalogMatch,
  sameMedicineIdentity,
} from "@synapse/db/pharmacy-purchases"

function medicineNameSearchPattern(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[\\%_]/g, "\\$&"))
    .join("%")
}

export async function GET(request: NextRequest) {
  try {
    // purchasing.manage is included because the supplier and purchase-order
    // pages need the product list to build an order.
    const auth = await requirePharmacyPermission(["inventory.read", "pos.sell", "purchasing.manage"])
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const { data: products, error } = await (supabaseAdmin as any)
      .from("pharmacy_products")
      .select(`
        id, tenant_id, name, sku, barcode, price, cost_price, quantity, unit_of_measure,
        strength, dosage_form, active_ingredient, generic_name, requires_prescription,
        supplier_id, expiry_date, batch_number, is_active, created_at, updated_at,
        pharmacy_product_packages(id, name, units_per_package, price, is_default),
        pharmacy_product_batches(id, batch_number, quantity, expiry_date, cost_price,
          selling_price, manufacturer, status, is_active)
      `)
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("created_at", { ascending: false })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    const today = kampalaToday()
    // Normalize to camelCase so the POS client interface matches
    const result = (products ?? []).map((product: any) => {
      const rawBatches = product.pharmacy_product_batches ?? []
      // Authoritative batch-derived quantities. `quantity` is retained for
      // compatibility, but POS must validate against `sellableQuantity`.
      const summary = summarizeInventory(
        { id: product.id, name: product.name, quantity: product.quantity, is_active: product.is_active },
        rawBatches,
        today,
      )
      return {
      id:                   product.id,
      name:                 product.name,
      sku:                  product.sku,
      barcode:              product.barcode ?? null,
      price:                Number(product.price ?? 0),
      costPrice:            product.cost_price != null ? Number(product.cost_price) : null,
      quantity:             product.quantity ?? 0,
      sellableQuantity:     summary.sellableQuantity,
      physicalQuantity:     summary.physicalQuantity,
      expiredQuantity:      summary.expiredQuantity,
      unbatchedQuantity:    summary.unbatchedQuantity,
      hasPhantomStock:      summary.hasPhantomStock,
      unitOfMeasure:        product.unit_of_measure ?? "unit",
      strength:             product.strength ?? null,
      dosageForm:           product.dosage_form ?? null,
      activeIngredient:     product.active_ingredient ?? null,
      genericName:          product.generic_name ?? null,
      requiresPrescription: product.requires_prescription ?? false,
      supplierId:           product.supplier_id ?? null,
      expiryDate:           product.expiry_date ?? null,
      batchNumber:          product.batch_number ?? null,
      isActive:             product.is_active,
      tenantId:             product.tenant_id,
      createdAt:            product.created_at,
      updatedAt:            product.updated_at,
      packages: (product.pharmacy_product_packages ?? [])
        .sort((a: any, b: any) => a.units_per_package - b.units_per_package)
        .map((pkg: any) => ({
          id:              pkg.id,
          name:            pkg.name,
          unitsPerPackage: pkg.units_per_package,
          price:           Number(pkg.price ?? 0),
          isDefault:       pkg.is_default ?? false,
        })),
      batches: rawBatches
        .filter((b: any) => isSellableBatch(normaliseBatch(b, today), today))
        .sort((a: any, b: any) => new Date(a.expiry_date).getTime() - new Date(b.expiry_date).getTime())
        .map((batch: any) => ({
          id:          batch.id,
          batchNumber: batch.batch_number,
          quantity:    batch.quantity,
          expiryDate:  batch.expiry_date,
          costPrice:   batch.cost_price != null ? Number(batch.cost_price) : null,
          sellingPrice: Number(batch.selling_price ?? product.price ?? 0),
          manufacturer: batch.manufacturer ?? null,
        })),
      }
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error("Get products error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const data: Record<string, unknown> = await request.json()

    // A supplier from another pharmacy must never be linkable.
    const foreignRef = await tenantRefsNotFound(tenantId, { supplierId: data.supplierId })
    if (foreignRef) return foreignRef

    const barcode = normalizeBarcode(data.barcode)

    // Check if SKU already exists (scoped to tenant)
    const { data: existingProduct } = await (supabaseAdmin as any)
      .from("pharmacy_products")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("sku", data.sku as string)
      .maybeSingle()

    if (existingProduct) {
      return NextResponse.json({ error: "Product with this SKU already exists" }, { status: 400 })
    }

    const name = String(data.name ?? "").trim()
    const { data: identityRows, error: identityError } = await (supabaseAdmin as any)
      .from("pharmacy_products")
      .select("id, name, sku, barcode, strength, dosage_form, active_ingredient, generic_name")
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .ilike("name", medicineNameSearchPattern(name))

    if (identityError) {
      console.error("[inventory] medicine identity lookup failed:", identityError)
      return NextResponse.json({ error: "Could not check existing medicine identity" }, { status: 500 })
    }

    const identityMatch = resolveImportCatalogMatch(
      {
        name,
        strength: typeof data.strength === "string" ? data.strength : null,
        dosageForm: typeof data.dosageForm === "string" ? data.dosageForm : null,
        activeIngredient: typeof data.activeIngredient === "string" ? data.activeIngredient : null,
      },
      (identityRows ?? []).map(catalogProductFromRow),
    )

    if (
      identityMatch.kind === "ambiguous_name" &&
      identityMatch.candidates.some((candidate) =>
        sameMedicineIdentity(
          {
            name,
            strength: typeof data.strength === "string" ? data.strength : null,
            dosageForm: typeof data.dosageForm === "string" ? data.dosageForm : null,
            activeIngredient: typeof data.activeIngredient === "string" ? data.activeIngredient : null,
          },
          candidate,
        ),
      )
    ) {
      return NextResponse.json(
        {
          error: "Multiple products have this exact medicine identity. Review the catalog and choose the correct product before receiving stock.",
          code: "AMBIGUOUS_MEDICINE_IDENTITY",
        },
        { status: 409 },
      )
    }

    if (identityMatch.kind === "match" && identityMatch.via === "name") {
      const { data: existingBarcode } = barcode
        ? await (supabaseAdmin as any)
            .from("pharmacy_products")
            .select("id")
            .eq("tenant_id", tenantId)
            .eq("barcode", barcode)
            .maybeSingle()
        : { data: null }

      if (existingBarcode && existingBarcode.id !== identityMatch.product.id) {
        const duplicate = await duplicateBarcodeResponse(tenantId, barcode)
        if (duplicate) return duplicate
      }

      const batches = Array.isArray(data.batches)
        ? (data.batches as Array<Record<string, unknown>>)
        : []
      if (batches.length === 0) {
        return NextResponse.json(
          {
            error: "This exact medicine already exists. Add its new batch to the existing product instead of creating a duplicate.",
            code: "DUPLICATE_MEDICINE",
            productId: identityMatch.product.id,
          },
          { status: 409 },
        )
      }

      const validatedBatches = batches.map((batch) => ({
        batch,
        quantity: Number(batch.quantity ?? 0),
        batchNumber: String(batch.batchNumber ?? "").trim(),
        expiryDate: String(batch.expiryDate ?? "").slice(0, 10),
      }))
      const invalidBatch = validatedBatches.find(
        ({ quantity, batchNumber, expiryDate }) => quantity <= 0 || !batchNumber || !expiryDate,
      )
      if (invalidBatch) {
        const err = pharmacyDomainError(
          "REQUIRES_BATCH",
          "Every opening batch requires a genuine batch number, future expiry, and positive quantity.",
        )
        return NextResponse.json(err, { status: httpStatusForPharmacyError(err.code) })
      }

      for (const { batch, quantity, batchNumber, expiryDate } of validatedBatches) {
        const received = await receivePharmacyStock(supabaseAdmin as any, {
          tenantId,
          productId: identityMatch.product.id,
          batchNumber,
          quantity,
          expiryDate,
          costPrice: (batch.costPrice as number | null) ?? (data.costPrice as number | null) ?? null,
          sellingPrice:
            (batch.sellingPrice as number | null) ?? (data.price as number | null) ?? null,
          receivedBy: session.user.id,
          reason: "Product create matched exact medicine identity",
        })
        if (received.error) {
          return NextResponse.json(
            pharmacyDomainError(received.error.code, received.error.humanMessage),
            { status: httpStatusForPharmacyError(received.error.code) },
          )
        }
      }

      const packages = data.packages as Array<Record<string, unknown>> | undefined
      if (Array.isArray(packages) && packages.length > 0) {
        const { error: packagesError } = await supabaseAdmin
          .from("pharmacy_product_packages")
          .upsert(
            packages.map((pkg) => ({
              tenant_id: tenantId,
              product_id: identityMatch.product.id,
              name: pkg.name as string,
              units_per_package: pkg.unitsPerPackage as number,
              price: pkg.price as number,
              is_default: (pkg.isDefault as boolean) || false,
            })),
            { onConflict: "product_id,name", ignoreDuplicates: true },
          )
        if (packagesError) {
          console.error("[inventory] matched product packages could not be saved:", packagesError)
          return NextResponse.json({ error: "Stock received but package options were not saved" }, { status: 500 })
        }
      }

      await supabaseAdmin.from("pharmacy_audit_logs").insert({
        tenant_id: tenantId,
        profile_id: session.user.id,
        action: "RECEIVE_BATCHES_ON_MATCHED_PRODUCT",
        entity: "PRODUCT",
        entity_id: identityMatch.product.id,
        details: `Received ${batches.length} batch(es) on exact medicine identity match`,
      })
      return NextResponse.json({
        ...identityMatch.product,
        matchedExisting: true,
        batchesReceived: batches.length,
      })
    }

    const dupBarcode = await duplicateBarcodeResponse(tenantId, barcode)
    if (dupBarcode) return dupBarcode

    // Create the product
    const { data: product, error: productError } = await supabaseAdmin
      .from("pharmacy_products")
      .insert({
        tenant_id: tenantId,
        name,
        sku: data.sku as string,
        barcode,
        category: (data.category as string) || "General",
        price: data.price as number,
        cost_price: data.costPrice as number,
        quantity: catalogueOpeningQuantity(data.quantity),
        reorder_level: (data.reorderLevel as number) || 10,
        unit_of_measure: (data.unitOfMeasure as string) || "Tablet",
        description: (data.description as string) || null,
        manufacturer: (data.manufacturer as string) || null,
        strength: (data.strength as string) || null,
        dosage_form: (data.dosageForm as string) || null,
        active_ingredient: (data.activeIngredient as string) || null,
        requires_prescription: (data.requiresPrescription as boolean) || false,
        generic_name: (data.genericName as string) || null,
        side_effects: (data.sideEffects as string) || null,
        storage_instructions: (data.storageInstructions as string) || null,
        regulatory_id: (data.regulatoryId as string) || null,
        supplier_id: (data.supplierId as string) || null,
      })
      .select()
      .single()

    if (productError) {
      if ((productError as { code?: string }).code === "23505") {
        return NextResponse.json({ error: "A product with this SKU or barcode already exists.", code: "DUPLICATE_PRODUCT" }, { status: 409 })
      }
      console.error("[inventory] product write failed:", (productError as { code?: string }).code ?? "unknown")
      return NextResponse.json({ error: "Failed to save product" }, { status: 500 })
    }

    // Create packages if provided
    const packages = data.packages as Array<Record<string, unknown>> | undefined
    if (Array.isArray(packages) && packages.length > 0) {
      const { error: packagesError } = await supabaseAdmin
        .from("pharmacy_product_packages")
        .insert(
          packages.map((pkg) => ({
            tenant_id: tenantId,
            product_id: product.id,
            name: pkg.name as string,
            units_per_package: pkg.unitsPerPackage as number,
            price: pkg.price as number,
            is_default: (pkg.isDefault as boolean) || false,
          }))
        )
      if (packagesError) return NextResponse.json({ error: packagesError.message }, { status: 500 })
    }

    // Batches enter only through receive_pharmacy_stock (never raw inserts).
    const batches = data.batches as Array<Record<string, unknown>> | undefined
    if (Array.isArray(batches) && batches.length > 0) {
      for (const batch of batches) {
        const qty = Number(batch.quantity ?? 0)
        const batchNumber = String(batch.batchNumber ?? "").trim()
        const expiryDate = String(batch.expiryDate ?? "").slice(0, 10)
        if (!batchNumber || !expiryDate || qty <= 0) {
          const err = pharmacyDomainError(
            "REQUIRES_BATCH",
            "Opening stock requires a genuine batch number, future expiry, and positive quantity.",
          )
          return NextResponse.json(err, { status: httpStatusForPharmacyError(err.code) })
        }
        const received = await receivePharmacyStock(supabaseAdmin as any, {
          tenantId,
          productId: product.id,
          batchNumber,
          quantity: qty,
          expiryDate,
          costPrice: (batch.costPrice as number | null) ?? (data.costPrice as number | null) ?? null,
          sellingPrice:
            (batch.sellingPrice as number | null) ?? (data.price as number | null) ?? null,
          receivedBy: session.user.id,
          reason: "Product create opening batch",
        })
        if (received.error) {
          return NextResponse.json(
            pharmacyDomainError(received.error.code, received.error.humanMessage),
            { status: httpStatusForPharmacyError(received.error.code) },
          )
        }
      }
    }

    // Audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "CREATE_PRODUCT",
      entity: "PRODUCT",
      entity_id: product.id,
      details: `Created product: ${product.name} (${product.sku}) with ${packages?.length ?? 0} packages, ${batches?.length ?? 0} batches`,
    })

    return NextResponse.json(product)
  } catch (error) {
    console.error("Create product error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const data: Record<string, unknown> = await request.json()

    if (!data.id) {
      return NextResponse.json({ error: "Product ID is required" }, { status: 400 })
    }

    // Verify product exists (scoped to tenant)
    const { data: existingProduct } = await (supabaseAdmin as any)
      .from("pharmacy_products")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("id", data.id as string)
      .maybeSingle()

    if (!existingProduct) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 })
    }

    const foreignRef = await tenantRefsNotFound(tenantId, { supplierId: data.supplierId })
    if (foreignRef) return foreignRef

    const barcode = normalizeBarcode(data.barcode)
    const dupBarcode = await duplicateBarcodeResponse(tenantId, barcode, data.id as string)
    if (dupBarcode) return dupBarcode

    if (catalogueQuantityPatchForbidden(data) || catalogueBatchMutationForbidden(data)) {
      const err = pharmacyDomainError(
        "REQUIRES_BATCH",
        "Product quantity and batch stock cannot be edited here. Receive, adjust, or reverse through the inventory RPCs.",
      )
      return NextResponse.json(err, { status: httpStatusForPharmacyError(err.code) })
    }

    // Update the product (catalogue fields only — never quantity)
    const { data: product, error: productError } = await supabaseAdmin
      .from("pharmacy_products")
      .update({
        name: data.name as string,
        barcode,
        category: (data.category as string) || "General",
        price: data.price as number,
        cost_price: data.costPrice as number,
        reorder_level: (data.reorderLevel as number) || 10,
        unit_of_measure: (data.unitOfMeasure as string) || "Tablet",
        description: (data.description as string) || null,
        manufacturer: (data.manufacturer as string) || null,
        strength: (data.strength as string) || null,
        dosage_form: (data.dosageForm as string) || null,
        active_ingredient: (data.activeIngredient as string) || null,
        requires_prescription: data.requiresPrescription as boolean,
        generic_name: (data.genericName as string) || null,
        side_effects: (data.sideEffects as string) || null,
        storage_instructions: (data.storageInstructions as string) || null,
        regulatory_id: (data.regulatoryId as string) || null,
        supplier_id: (data.supplierId as string) || null,
      })
      .eq("id", data.id as string)
      .eq("tenant_id", tenantId)
      .select()
      .single()

    if (productError) {
      if ((productError as { code?: string }).code === "23505") {
        return NextResponse.json({ error: "A product with this SKU or barcode already exists.", code: "DUPLICATE_PRODUCT" }, { status: 409 })
      }
      console.error("[inventory] product write failed:", (productError as { code?: string }).code ?? "unknown")
      return NextResponse.json({ error: "Failed to save product" }, { status: 500 })
    }

    // Batch quantity / create / delete is not allowed on catalogue PATCH.
    // Receive and adjust RPCs own those mutations.

    // Handle packages: update existing, create new
    const deletedPackageIds = data.deletedPackageIds as string[] | undefined
    if (Array.isArray(deletedPackageIds) && deletedPackageIds.length > 0) {
      const { error: pkgDeleteError } = await supabaseAdmin
        .from("pharmacy_product_packages")
        .delete()
        .in("id", deletedPackageIds)
        .eq("tenant_id", tenantId)
      if (pkgDeleteError) return NextResponse.json({ error: pkgDeleteError.message }, { status: 500 })
    }

    // Handle packages: update existing, create new
    const packages = data.packages as Array<Record<string, unknown>> | undefined
    if (Array.isArray(packages)) {
      for (const pkg of packages) {
        if (pkg.id) {
          const { error } = await supabaseAdmin
            .from("pharmacy_product_packages")
            .update({
              name: pkg.name as string,
              units_per_package: pkg.unitsPerPackage as number,
              price: pkg.price as number,
              is_default: pkg.isDefault as boolean,
            })
            .eq("id", pkg.id as string)
            .eq("tenant_id", tenantId)
          if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        } else {
          const { error } = await supabaseAdmin
            .from("pharmacy_product_packages")
            .insert({
              tenant_id: tenantId,
              product_id: product.id,
              name: pkg.name as string,
              units_per_package: pkg.unitsPerPackage as number,
              price: pkg.price as number,
              is_default: (pkg.isDefault as boolean) || false,
            })
          if (error) return NextResponse.json({ error: error.message }, { status: 500 })
        }
      }
    }

    // Audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "UPDATE_PRODUCT",
      entity: "PRODUCT",
      entity_id: product.id,
      details: `Updated product: ${product.name} (${product.sku})`,
    })

    return NextResponse.json(product)
  } catch (error) {
    console.error("Update product error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("inventory.write")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const productId = request.nextUrl.searchParams.get("id")
    if (!productId) {
      return NextResponse.json({ error: "Product id is required" }, { status: 400 })
    }

    const { data: product, error: fetchError } = await supabaseAdmin
      .from("pharmacy_products")
      .select("id, name, sku")
      .eq("id", productId)
      .eq("tenant_id", tenantId)
      .maybeSingle()

    if (fetchError) return NextResponse.json({ error: fetchError.message }, { status: 500 })
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 })

    const { error: deleteError } = await supabaseAdmin
      .from("pharmacy_products")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", productId)
      .eq("tenant_id", tenantId)

    if (deleteError) return NextResponse.json({ error: deleteError.message }, { status: 500 })

    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "DELETE_PRODUCT",
      entity: "PRODUCT",
      entity_id: productId,
      details: `Deleted product: ${product.name} (${product.sku})`,
    })

    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error("Delete product error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
