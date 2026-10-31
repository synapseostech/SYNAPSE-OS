import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyTenant } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { receivePharmacyStock, adjustPharmacyBatchStock } from "@synapse/db/inventory-rpc"

const db = () => supabaseAdmin as any

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyTenant()
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const { searchParams } = new URL(request.url)
    const productId = searchParams.get("productId")

    if (!productId) {
      return NextResponse.json({ error: "Product ID is required" }, { status: 400 })
    }

    const { data: batches, error } = await db()
      .from("pharmacy_product_batches")
      .select("*")
      .eq("product_id", productId)
      .eq("tenant_id", tenantId)
      .eq("is_active", true)
      .order("expiry_date", { ascending: true })

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json(batches ?? [])
  } catch (error) {
    console.error("Get batches error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

/** Create/top-up a batch via authoritative receive_pharmacy_stock. */
export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyTenant()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const data: Record<string, unknown> = await request.json()

    if (!data.productId || !data.batchNumber || !data.quantity || !data.expiryDate) {
      return NextResponse.json(
        { error: "Product ID, batch number, quantity, and expiry date are required" },
        { status: 400 },
      )
    }

    const { data: product } = await db()
      .from("pharmacy_products")
      .select("id, cost_price, quantity")
      .eq("tenant_id", tenantId)
      .eq("id", data.productId as string)
      .maybeSingle()

    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 })
    }

    const { data: received, error } = await receivePharmacyStock(db(), {
      tenantId,
      productId: data.productId as string,
      batchNumber: String(data.batchNumber),
      quantity: Number(data.quantity),
      expiryDate: String(data.expiryDate),
      costPrice: (data.costPrice as number) || product.cost_price,
      sellingPrice: (data.sellingPrice as number | null) ?? null,
      receivedBy: session.user.id,
      reason: (data.notes as string) || "Batch created",
    })

    if (error) {
      return NextResponse.json({ error: error.humanMessage, code: error.code }, { status: 400 })
    }

    const { data: batch } = await db()
      .from("pharmacy_product_batches")
      .select("*")
      .eq("id", received?.batchId)
      .maybeSingle()

    return NextResponse.json(batch ?? received)
  } catch (error) {
    console.error("Create batch error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requirePharmacyTenant()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const data: Record<string, unknown> = await request.json()

    if (!data.id) {
      return NextResponse.json({ error: "Batch ID is required" }, { status: 400 })
    }

    const { data: existingBatch } = await db()
      .from("pharmacy_product_batches")
      .select("id, product_id, batch_number, quantity")
      .eq("tenant_id", tenantId)
      .eq("id", data.id as string)
      .maybeSingle()

    if (!existingBatch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 })
    }

    if (
      data.sellingPrice !== undefined &&
      (typeof data.sellingPrice !== "number" ||
        !Number.isFinite(data.sellingPrice) ||
        data.sellingPrice < 0)
    ) {
      return NextResponse.json(
        { error: "Selling price must be a non-negative number" },
        { status: 400 },
      )
    }

    if (data.quantity !== undefined) {
      const { error } = await adjustPharmacyBatchStock(db(), {
        tenantId,
        productId: existingBatch.product_id,
        quantity: Number(data.quantity),
        type: "CORRECTION",
        reason: `Batch correction for ${existingBatch.batch_number}`,
        actorId: session.user.id,
        batchId: existingBatch.id,
        expiryDate: (data.expiryDate as string) || null,
        costPrice: (data.costPrice as number) ?? null,
      })
      if (error) {
        return NextResponse.json({ error: error.humanMessage, code: error.code }, { status: 400 })
      }
    } else {
      const updateFields: Record<string, unknown> = {}
      if (data.expiryDate !== undefined) updateFields.expiry_date = data.expiryDate || null
      if (data.costPrice !== undefined) updateFields.cost_price = data.costPrice
      if (data.notes !== undefined) updateFields.notes = data.notes
      if (data.isActive !== undefined) updateFields.is_active = data.isActive
      if (data.status !== undefined) updateFields.status = data.status
      if (data.sellingPrice !== undefined) updateFields.selling_price = data.sellingPrice

      if (Object.keys(updateFields).length > 0) {
        const { error: batchError } = await db()
          .from("pharmacy_product_batches")
          .update(updateFields)
          .eq("id", data.id as string)
          .eq("tenant_id", tenantId)
        if (batchError) return NextResponse.json({ error: batchError.message }, { status: 500 })
      }
    }

    const { data: batch } = await db()
      .from("pharmacy_product_batches")
      .select("*")
      .eq("id", data.id as string)
      .eq("tenant_id", tenantId)
      .single()

    await db().from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "UPDATE_BATCH",
      entity: "PRODUCT_BATCH",
      entity_id: data.id,
      details: `Updated batch "${existingBatch.batch_number}"`,
    })

    return NextResponse.json(batch)
  } catch (error) {
    console.error("Update batch error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requirePharmacyTenant()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "Batch ID is required" }, { status: 400 })
    }

    const { data: existingBatch } = await db()
      .from("pharmacy_product_batches")
      .select("id, product_id, batch_number, quantity")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .maybeSingle()

    if (!existingBatch) {
      return NextResponse.json({ error: "Batch not found" }, { status: 404 })
    }

    const { error } = await adjustPharmacyBatchStock(db(), {
      tenantId,
      productId: existingBatch.product_id,
      quantity: 0,
      type: "QUARANTINE",
      reason: `Batch deactivated: ${existingBatch.batch_number}`,
      actorId: session.user.id,
      batchId: id,
    })
    if (error) {
      return NextResponse.json({ error: error.humanMessage, code: error.code }, { status: 400 })
    }

    if (existingBatch.quantity > 0) {
      await adjustPharmacyBatchStock(db(), {
        tenantId,
        productId: existingBatch.product_id,
        quantity: existingBatch.quantity,
        type: "DECREASE",
        reason: `Removed remaining qty on deactivated batch ${existingBatch.batch_number}`,
        actorId: session.user.id,
        batchId: id,
      })
    }

    await db().from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "DELETE_BATCH",
      entity: "PRODUCT_BATCH",
      entity_id: id,
      details: `Deactivated batch "${existingBatch.batch_number}"`,
    })

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("Delete batch error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
