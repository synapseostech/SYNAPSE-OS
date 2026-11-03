import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyAdmin } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { netAmountFor } from "@/lib/pos/net-amount"
import { generateTransactionNo } from "@/lib/utils"
import { adjustPharmacyBatchStock } from "@synapse/db/inventory-rpc"
import { pharmacyDomainError, httpStatusForPharmacyError } from "@synapse/db/errors"

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

    if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

    const data = await request.json()
    const { orderId, paymentMethod = "CASH" } = data as { orderId: string; paymentMethod?: string }

    if (!orderId) {
      return NextResponse.json({ error: "Order ID is required" }, { status: 400 })
    }

    const { data: order, error: orderError } = await (supabaseAdmin as any)
      .from("pharmacy_orders")
      .select(
        `
        id, order_no, order_type, total_amount, customer_id, payment_status,
        items:pharmacy_order_items(id, product_id, product_name, quantity, unit_price, total_price)
      `
      )
      .eq("tenant_id", tenantId)
      .eq("id", orderId)
      .single()

    if (orderError || !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    if (order.payment_status === "PAID") {
      return NextResponse.json({ error: "Order already paid" }, { status: 400 })
    }

    if (order.order_type === "SUPPLIER") {
      return NextResponse.json(
        { error: "Supplier orders cannot be processed as transactions" },
        { status: 400 }
      )
    }

    const orderItems = order.items as Array<{
      id: string
      product_id: string | null
      product_name: string
      quantity: number
      unit_price: number
      total_price: number
    }>

    // Validate stock before processing
    for (const item of orderItems) {
      if (item.product_id) {
        const { data: product } = await (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("quantity, name")
          .eq("tenant_id", tenantId)
          .eq("id", item.product_id)
          .single()

        if (!product) {
          return NextResponse.json(
            { error: `Product not found: ${item.product_name}` },
            { status: 400 }
          )
        }

        if (product.quantity < item.quantity) {
          return NextResponse.json(
            { error: `Insufficient stock for ${product.name}. Available: ${product.quantity}` },
            { status: 400 }
          )
        }
      }
    }

    // Create transaction
    const transactionNo = generateTransactionNo()

    const { data: transaction, error: txError } = await supabaseAdmin
      .from("pharmacy_transactions")
      .insert({
        tenant_id: tenantId,
        transaction_no: transactionNo,
        cashier_id: session.user.id,
        total_amount: order.total_amount,
        discount: 0,
        tax: 0,
        net_amount: netAmountFor({ totalAmount: order.total_amount, discount: 0, tax: 0 }),
        payment_method: paymentMethod,
        status: "COMPLETED",
      })
      .select("id, transaction_no")
      .single()

    if (txError || !transaction) {
      console.error("Error creating transaction:", txError)
      return NextResponse.json({ error: "Failed to create transaction" }, { status: 500 })
    }

    // Insert transaction items
    const txItemsWithProductId = orderItems.filter((item) => item.product_id !== null)

    if (txItemsWithProductId.length > 0) {
      await supabaseAdmin.from("pharmacy_transaction_items").insert(
        txItemsWithProductId.map((item) => ({
          tenant_id: tenantId,
          transaction_id: transaction.id,
          product_id: item.product_id!,
          quantity: item.quantity,
          unit_price: item.unit_price,
          cost_price: 0,
          total_price: item.total_price,
        }))
      )
    }

    // Deduct sellable batch stock via FEFO (never product.quantity).
    for (const item of orderItems) {
      if (!item.product_id) continue

      const debit = await adjustPharmacyBatchStock(supabaseAdmin as any, {
        tenantId,
        productId: item.product_id,
        quantity: item.quantity,
        type: "DECREASE",
        reason: `Order ${order.order_no} payment processed`,
        actorId: session.user.id,
      })
      if (debit.error) {
        return NextResponse.json(
          pharmacyDomainError(debit.error.code, debit.error.humanMessage, {
            productId: item.product_id,
            requestedQuantity: item.quantity,
          }),
          { status: httpStatusForPharmacyError(debit.error.code) },
        )
      }
    }

    // Update order status to COMPLETED and payment status to PAID
    await supabaseAdmin
      .from("pharmacy_orders")
      .update({
        status: "COMPLETED",
        payment_status: "PAID",
        processed_by: session.user.id,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .eq("tenant_id", tenantId)

    // Create audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "PROCESS_PAYMENT",
      entity: "Order",
      entity_id: orderId,
      details: `Processed payment for order ${order.order_no}. Transaction: ${transaction.transaction_no}`,
    })

    return NextResponse.json({
      message: "Payment processed successfully",
      transaction,
    })
  } catch (error) {
    console.error("Error processing payment:", error)
    return NextResponse.json({ error: "Failed to process payment" }, { status: 500 })
  }
}
