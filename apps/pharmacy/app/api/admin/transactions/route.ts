import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { decodePaidAmount, roundMoney } from "@/lib/pos/partial-payment"
import { listLedgerSalesForHistory, sumCompletedRevenue } from "@/lib/pos/sale-ledger"

interface TransactionItemRow {
  unitPrice: number
  costPrice: number | null
  quantity: number
  product?: { costPrice?: number | null } | null
}

function calculateProfit(items: TransactionItemRow[]): number {
  return items.reduce((total, item) => {
    const costAtSale = item.costPrice ?? item.product?.costPrice ?? 0
    const profit = (item.unitPrice - costAtSale) * Math.abs(item.quantity)
    return total + profit
  }, 0)
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission(["reports.operational", "pos.sell"])
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    if (!tenantId) {
      return NextResponse.json({ error: "No tenant" }, { status: 403 })
    }

    const search = request.nextUrl.searchParams.get("search")?.trim() ?? ""
    const ledger = await listLedgerSalesForHistory({
      tenantId,
      limit: 100,
      search: search || undefined,
    })

    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)
    const monthAgo = new Date()
    monthAgo.setMonth(monthAgo.getMonth() - 1)

    const [todayRev, weekRev, monthRev] = await Promise.all([
      sumCompletedRevenue({ tenantId, fromIso: today.toISOString() }),
      sumCompletedRevenue({ tenantId, fromIso: weekAgo.toISOString() }),
      sumCompletedRevenue({ tenantId, fromIso: monthAgo.toISOString() }),
    ])

    const inPeriod = (iso: string, from: Date) => Date.parse(iso) >= from.getTime()

    const profitFor = (from: Date) =>
      ledger
        .filter((r) => r.status === "COMPLETED" && inPeriod(r.createdAt, from))
        .reduce(
          (s, r) =>
            s +
            calculateProfit(
              r.items.map((i) => ({
                unitPrice: i.unitPrice,
                costPrice: i.costPrice,
                quantity: i.quantity,
                product: i.product ? { costPrice: i.product.cost_price ?? null } : null,
              })),
            ),
          0,
        )

    const normalized = ledger.map((row) => {
      // A refund hands back what the customer actually paid. For a POS sale
      // that is the settlement tag, not the sale total; a credit balance is
      // reversed in the ledger instead. A legacy order refunds its header.
      const paidAmount =
        row.source === "pos"
          ? decodePaidAmount({
              paymentRef: row.paymentRef ?? null,
              total: row.netAmount,
              method: row.paymentMethod,
            })
          : roundMoney(row.subtotal - row.discount + row.tax)
      const balanceDue = row.source === "pos" ? roundMoney(Math.max(0, row.netAmount - paidAmount)) : 0

      return {
        id: row.id,
        transactionNo: row.transactionNo,
        status: row.status,
        clientName: row.clientName,
        clientPhone: null,
        clientAddress: null,
        totalAmount: row.subtotal,
        netAmount: row.netAmount,
        paidAmount,
        balanceDue,
        discount: row.discount,
        tax: row.tax,
        paymentMethod: row.paymentMethod ?? "CASH",
        isEdited: false,
        createdAt: row.createdAt,
        source: row.source,
        printFailed: row.printFailed,
        user: { name: row.cashierName ?? "Unknown" },
        items: row.items.map((item) => ({
          id: item.id,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          costPrice: item.costPrice,
          totalPrice: item.totalPrice,
          packageName: null,
          packageQuantity: null,
          batch: item.batch
            ? {
                batchNumber: item.batch.batch_number,
                expiryDate: item.batch.expiry_date,
              }
            : null,
          product: {
            id: item.product?.id ?? "",
            name: item.product?.name ?? "Unknown product",
            sku: item.product?.sku ?? "",
            costPrice: item.product?.cost_price != null ? Number(item.product.cost_price) : 0,
            dosageForm: null,
            strength: null,
            expiryDate: null,
            batchNumber: null,
          },
        })),
      }
    })

    return NextResponse.json({
      transactions: normalized,
      stats: {
        today: todayRev.amount,
        week: weekRev.amount,
        month: monthRev.amount,
        todayProfit: profitFor(today),
        weekProfit: profitFor(weekAgo),
        monthProfit: profitFor(monthAgo),
        count: normalized.length,
      },
    })
  } catch (error) {
    console.error("Get transactions error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
