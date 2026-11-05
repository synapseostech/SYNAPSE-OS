import { NextRequest, NextResponse } from "next/server"
import { isPharmacyAdmin } from "@/lib/auth"
import { requirePharmacyAdmin } from "@/lib/api-auth"
import { mapOrder } from "@/lib/api-serialize"
import { netAmountFor } from "@/lib/pos/net-amount"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { tenantOwnsRecord } from "@/lib/tenant-ownership"
import { generateOrderNo, generateTransactionNo } from "@/lib/utils"
import { adjustPharmacyBatchStock } from "@synapse/db/inventory-rpc"
import { pharmacyDomainError, httpStatusForPharmacyError } from "@synapse/db/errors"

type OrderStatsRow = {
  status: string
  totalAmount: number | null
  orderType: string | null
  isOnlineOrder: boolean | null
  claimedBy: string | null
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

    if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

    const { data: orders, error } = await (supabaseAdmin as any)
      .from("pharmacy_orders")
      .select(
        `
        *,
        customer:pharmacy_customers(name, email, phone),
        items:pharmacy_order_items(
          id, product_id, product_name, quantity, unit_price, total_price
        )
      `
      )
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("Error fetching orders:", error)
      return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
    }

    // Get claimed-by and processed-by user names from auth
    const profileIds = new Set<string>()
    for (const order of orders ?? []) {
      if (order.claimed_by) profileIds.add(order.claimed_by)
      if (order.processed_by) profileIds.add(order.processed_by)
    }

    const profileNameMap = new Map<string, string>()
    if (profileIds.size > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id, full_name, first_name, last_name")
        .in("id", Array.from(profileIds))

      for (const p of profiles ?? []) {
        profileNameMap.set(
          p.id,
          p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim() ?? p.id
        )
      }
    }

    const enrichedOrders = (orders ?? []).map((order: Record<string, unknown> & {
      processed_by?: string | null
      claimed_by?: string | null
    }) =>
      mapOrder(order, {
        processedByName: order.processed_by
          ? profileNameMap.get(order.processed_by) ?? null
          : null,
        claimedByName: order.claimed_by
          ? profileNameMap.get(order.claimed_by) ?? null
          : null,
      }),
    ) as OrderStatsRow[]

    const stats = {
      pending: enrichedOrders.filter((o) => o.status === "PENDING").length,
      completed: enrichedOrders.filter((o) => o.status === "COMPLETED").length,
      cancelled: enrichedOrders.filter((o) => o.status === "CANCELLED").length,
      totalRevenue: enrichedOrders
        .filter((o) => o.status === "COMPLETED")
        .reduce((sum, o) => sum + (o.totalAmount ?? 0), 0),
      supplierOrders: enrichedOrders.filter((o) => o.orderType === "SUPPLIER").length,
      customerOrders: enrichedOrders.filter((o) => o.orderType === "CUSTOMER").length,
      onlineOrders: enrichedOrders.filter((o) => o.isOnlineOrder === true).length,
      unclaimedOrders: enrichedOrders.filter(
        (o) => o.isOnlineOrder === true && !o.claimedBy && o.status === "PENDING"
      ).length,
    }

    return NextResponse.json({ orders: enrichedOrders, stats })
  } catch (error) {
    console.error("Error fetching orders:", error)
    return NextResponse.json({ error: "Failed to fetch orders" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

    if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

    const data = await request.json()
    const { customerId, customerName, customerPhone, orderType = "CUSTOMER", items, notes, deliveryAddress } = data

    if (!items || items.length === 0) {
      return NextResponse.json({ error: "Items are required" }, { status: 400 })
    }

    if (customerId && !(await tenantOwnsRecord("pharmacy_customers", tenantId, customerId))) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 })
    }

    let finalCustomerId: string | null = customerId ?? null

    // If customer order with no existing customer, create one
    if (orderType === "CUSTOMER" && !customerId && customerName) {
      const { data: newCustomer, error: customerError } = await supabaseAdmin
        .from("pharmacy_customers")
        .insert({
          tenant_id: tenantId,
          name: customerName,
          email: `${customerName.toLowerCase().replace(/\s+/g, ".")}@temp.local`,
          phone: customerPhone ?? null,
          is_active: true,
        })
        .select("id")
        .single()

      if (customerError || !newCustomer) {
        console.error("Error creating customer:", customerError)
        return NextResponse.json({ error: "Failed to create customer" }, { status: 500 })
      }
      finalCustomerId = newCustomer.id
    }

    // Calculate total and validate stock
    let totalAmount = 0
    const orderItems: Array<{
      tenant_id: string
      product_id: string | null
      product_name: string
      quantity: number
      unit_price: number
      total_price: number
    }> = []

    for (const item of items as Array<{
      productId?: string
      productName?: string
      quantity: number
      unitPrice?: number
    }>) {
      const unitPrice = item.unitPrice ?? 0
      const totalPrice = unitPrice * item.quantity
      totalAmount += totalPrice

      if (orderType === "CUSTOMER" && item.productId) {
        const { data: product } = await (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("quantity, name")
          .eq("tenant_id", tenantId)
          .eq("id", item.productId)
          .single()

        if (product && product.quantity < item.quantity) {
          return NextResponse.json(
            { error: `Insufficient stock for ${product.name}. Available: ${product.quantity}` },
            { status: 400 }
          )
        }
      }

      orderItems.push({
        tenant_id: tenantId,
        product_id: item.productId ?? null,
        product_name: item.productName ?? "",
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: totalPrice,
      })
    }

    // Generate order number
    // Use REQ prefix for supplier orders, ORD for customer orders
    const orderNo = orderType === "SUPPLIER"
      ? `REQ-${Date.now().toString(36).toUpperCase()}`
      : generateOrderNo()

    // Create order
    const { data: order, error: orderError } = await supabaseAdmin
      .from("pharmacy_orders")
      .insert({
        tenant_id: tenantId,
        order_no: orderNo,
        order_type: orderType,
        customer_id: finalCustomerId,
        total_amount: totalAmount,
        status: "PENDING",
        payment_status: "UNPAID",
        notes: notes ?? null,
        delivery_address: deliveryAddress ?? null,
      })
      .select("id, order_no, status, total_amount, customer_id")
      .single()

    if (orderError || !order) {
      console.error("Error creating order:", orderError)
      return NextResponse.json({ error: "Failed to create order" }, { status: 500 })
    }

    // Insert order items
    const itemsWithOrderId = orderItems.map((item) => ({
      ...item,
      order_id: order.id,
    }))

    const { error: itemsError } = await supabaseAdmin.from("pharmacy_order_items").insert(itemsWithOrderId)

    if (itemsError) {
      console.error("Error creating order items:", itemsError)
      // Rollback order
      await supabaseAdmin.from("pharmacy_orders").delete().eq("id", order.id).eq("tenant_id", tenantId)
      return NextResponse.json({ error: "Failed to create order items" }, { status: 500 })
    }

    // Create audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: orderType === "SUPPLIER" ? "CREATE_SUPPLIER_ORDER" : "CREATE_CUSTOMER_ORDER",
      entity: "Order",
      entity_id: order.id,
      details:
        orderType === "SUPPLIER"
          ? `Created supplier requisition ${orderNo}`
          : `Created customer order ${orderNo}`,
    })

    return NextResponse.json(order, { status: 201 })
  } catch (error) {
    console.error("Error creating order:", error)
    return NextResponse.json({ error: "Failed to create order" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

    if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

    const data = await request.json()
    const { id, status } = data as { id: string; status: string }

    if (!id || !status) {
      return NextResponse.json({ error: "Order ID and status are required" }, { status: 400 })
    }

    if (!["PENDING", "PROCESSING", "COMPLETED", "CANCELLED"].includes(status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }

    const { data: order, error: orderFetchError } = await (supabaseAdmin as any)
      .from("pharmacy_orders")
      .select("id, order_no, order_type, total_amount, customer_id, status, items:pharmacy_order_items(*)")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .single()

    if (orderFetchError || !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    // A completed order has already written its sale. Completing it again
    // created a second transaction and deducted every line twice.
    if (order.status === status) {
      return NextResponse.json(
        {
          error:
            status === "COMPLETED"
              ? "Order is already completed."
              : `Order is already ${status.toLowerCase()}.`,
          code: status === "COMPLETED" ? "ORDER_ALREADY_COMPLETED" : "ORDER_STATUS_UNCHANGED",
        },
        { status: 409 },
      )
    }

    // Update order status, guarded by the status just read so two concurrent
    // requests cannot both go on to record a sale.
    const { data: updatedOrder, error: updateError } = await supabaseAdmin
      .from("pharmacy_orders")
      .update({
        status,
        processed_by: status !== "PENDING" ? session.user.id : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .eq("status", order.status)
      .select()
      .maybeSingle()

    if (updateError) {
      console.error("Error updating order:", updateError)
      return NextResponse.json({ error: "Failed to update order" }, { status: 500 })
    }
    if (!updatedOrder) {
      return NextResponse.json(
        {
          error: "Order changed while it was being updated. Reload and try again.",
          code: "ORDER_STATUS_RACE",
        },
        { status: 409 },
      )
    }

    // If completing a customer order, create transaction and deduct stock.
    if (status === "COMPLETED" && order.order_type === "CUSTOMER") {
      const itemsWithProducts = (order.items as Array<{
        id: string
        product_id: string | null
        product_name: string
        quantity: number
        unit_price: number
        total_price: number
      }>).filter((item) => item.product_id !== null)

      if (itemsWithProducts.length > 0) {
        const revertOrder = async () => {
          await supabaseAdmin
            .from("pharmacy_orders")
            .update({ status: order.status, updated_at: new Date().toISOString() })
            .eq("id", id)
            .eq("tenant_id", tenantId)
            .eq("status", "COMPLETED")
        }
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
            payment_method: "CASH",
            status: "COMPLETED",
          })
          .select("id")
          .single()

        if (txError || !transaction) {
          console.error("Error creating transaction:", txError)
          await revertOrder()
          return NextResponse.json(
            { error: "Failed to record the sale for this order. The order was left unchanged." },
            { status: 500 },
          )
        }

        const debited: Array<{ productId: string; quantity: number }> = []
        // Undo a half-finished completion: put back the units already taken,
        // drop the sale row and return the order to its previous status, so it
        // can be completed again without a second transaction or a short shelf.
        const rollback = async () => {
          for (const done of debited) {
            await adjustPharmacyBatchStock(supabaseAdmin as any, {
              tenantId,
              productId: done.productId,
              quantity: done.quantity,
              type: "INCREASE",
              reason: `Order ${order.order_no} completion rolled back`,
              actorId: session.user.id,
            })
          }
          await supabaseAdmin
            .from("pharmacy_transactions")
            .delete()
            .eq("id", transaction.id)
            .eq("tenant_id", tenantId)
          await revertOrder()
        }

        const { error: itemsError } = await supabaseAdmin
          .from("pharmacy_transaction_items")
          .insert(
            itemsWithProducts.map((item) => ({
              tenant_id: tenantId,
              transaction_id: transaction.id,
              product_id: item.product_id!,
              quantity: item.quantity,
              unit_price: item.unit_price,
              cost_price: 0,
              total_price: item.total_price,
            })),
          )
        if (itemsError) {
          console.error("Error creating transaction items:", itemsError)
          await rollback()
          return NextResponse.json(
            { error: "Failed to record the sale for this order. The order was left unchanged." },
            { status: 500 },
          )
        }

        // Deduct sellable batch stock via FEFO (never product.quantity).
        for (const item of itemsWithProducts) {
          const debit = await adjustPharmacyBatchStock(supabaseAdmin as any, {
            tenantId,
            productId: item.product_id!,
            quantity: item.quantity,
            type: "DECREASE",
            reason: `Order ${order.order_no} completed`,
            actorId: session.user.id,
          })
          if (debit.error) {
            await rollback()
            return NextResponse.json(
              pharmacyDomainError(debit.error.code, debit.error.humanMessage, {
                productId: item.product_id!,
                requestedQuantity: item.quantity,
              }),
              { status: httpStatusForPharmacyError(debit.error.code) },
            )
          }
          debited.push({ productId: item.product_id!, quantity: item.quantity })
        }
      }
    }

    // Clean up notifications when order is completed or cancelled
    if (status === "COMPLETED" || status === "CANCELLED") {
      await supabaseAdmin
        .from("pharmacy_notifications")
        .delete()
        .eq("tenant_id", tenantId)
        .eq("related_id", id)
        .eq("type", "NEW_ORDER")

      await supabaseAdmin
        .from("pharmacy_notifications")
        .update({ is_read: true })
        .eq("tenant_id", tenantId)
        .eq("related_id", id)
        .eq("type", "ORDER_CLAIMED")
    }

    // Create audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "UPDATE_ORDER",
      entity: "Order",
      entity_id: order.id,
      details: `Changed status to ${status}`,
    })

    return NextResponse.json(updatedOrder)
  } catch (error) {
    console.error("Error updating order:", error)
    return NextResponse.json({ error: "Failed to update order" }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
  if (!auth.ok) return auth.response
  const { session, tenantId } = auth

    if (!isPharmacyAdmin(session)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (!tenantId) return NextResponse.json({ error: "Tenant not found" }, { status: 400 })

    const { searchParams } = new URL(request.url)
    const id = searchParams.get("id")

    if (!id) {
      return NextResponse.json({ error: "Order ID is required" }, { status: 400 })
    }

    const { data: order, error: orderFetchError } = await (supabaseAdmin as any)
      .from("pharmacy_orders")
      .select("id, order_no, status")
      .eq("tenant_id", tenantId)
      .eq("id", id)
      .single()

    if (orderFetchError || !order) {
      return NextResponse.json({ error: "Order not found" }, { status: 404 })
    }

    if (order.status === "COMPLETED") {
      return NextResponse.json({ error: "Cannot delete completed orders" }, { status: 400 })
    }

    // Delete notifications related to this order
    await supabaseAdmin
      .from("pharmacy_notifications")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("related_id", id)

    // Delete order items
    await supabaseAdmin
      .from("pharmacy_order_items")
      .delete()
      .eq("order_id", id)
      .eq("tenant_id", tenantId)

    // Delete order
    await supabaseAdmin
      .from("pharmacy_orders")
      .delete()
      .eq("id", id)
      .eq("tenant_id", tenantId)

    // Create audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "DELETE_ORDER",
      entity: "Order",
      entity_id: id,
      details: `Deleted order ${order.order_no}`,
    })

    return NextResponse.json({ message: "Order deleted successfully" })
  } catch (error) {
    console.error("Error deleting order:", error)
    return NextResponse.json({ error: "Failed to delete order" }, { status: 500 })
  }
}
