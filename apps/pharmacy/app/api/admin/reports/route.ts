import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { decodePaidAmount } from "@/lib/pos/partial-payment"
import { summariseLineTax, type TaxLineRow } from "@/lib/pos/tax-summary"

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission(["reports.operational", "reports.financial"])
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const { searchParams } = new URL(request.url)
    const reportType = searchParams.get("type") || "sales"
    const period = searchParams.get("period") || "today"
    const startDate = searchParams.get("startDate")
    const endDate = searchParams.get("endDate")

    // Calculate date range
    let dateFrom: Date
    let dateTo: Date = new Date()

    switch (period) {
      case "today":
        dateFrom = new Date(new Date().setHours(0, 0, 0, 0))
        break
      case "yesterday":
        dateFrom = new Date(new Date().setHours(0, 0, 0, 0))
        dateFrom.setDate(dateFrom.getDate() - 1)
        dateTo = new Date(new Date().setHours(0, 0, 0, 0))
        break
      case "week":
        dateFrom = new Date()
        dateFrom.setDate(dateFrom.getDate() - 7)
        break
      case "month":
        dateFrom = new Date()
        dateFrom.setMonth(dateFrom.getMonth() - 1)
        break
      case "year":
        dateFrom = new Date()
        dateFrom.setFullYear(dateFrom.getFullYear() - 1)
        break
      case "custom":
        dateFrom = startDate ? new Date(startDate) : new Date()
        dateTo = endDate ? new Date(endDate) : new Date()
        break
      default:
        dateFrom = new Date(new Date().setHours(0, 0, 0, 0))
    }

    const dateFromISO = dateFrom.toISOString()
    const dateToISO = dateTo.toISOString()

    // ── SALES REPORT ─────────────────────────────────────────────────────────
    if (reportType === "sales") {
      const [txResult, itemsResult, posResult, posItemsResult, taxLinesResult] = await Promise.all([
        (supabaseAdmin as any)
          .from("pharmacy_transactions")
          .select(
            "id, transaction_no, total_amount, net_amount, discount, tax, payment_method, client_name, cashier_id, created_at, profiles(full_name, first_name, last_name)"
          )
          .eq("tenant_id", tenantId)
          .eq("status", "COMPLETED")
          .gte("created_at", dateFromISO)
          .lte("created_at", dateToISO)
          .order("created_at", { ascending: false }),
        (supabaseAdmin as any)
          .from("pharmacy_transaction_items")
          .select(
            "product_id, quantity, total_price, unit_price, pharmacy_transactions!inner(status, created_at), pharmacy_products(name, sku, category)"
          )
          .eq("tenant_id", tenantId)
          .eq("pharmacy_transactions.status", "COMPLETED")
          .gte("pharmacy_transactions.created_at", dateFromISO)
          .lte("pharmacy_transactions.created_at", dateToISO),
        (supabaseAdmin as any)
          .from("pharmacy_pos_sales")
          .select(
            "id, receipt_number, total_amount, discount_total, tax_amount, payment_method, cashier_id, created_at"
          )
          .eq("tenant_id", tenantId)
          .eq("status", "completed")
          .gte("created_at", dateFromISO)
          .lte("created_at", dateToISO)
          .order("created_at", { ascending: false }),
        (supabaseAdmin as any)
          .from("pharmacy_pos_sale_items")
          .select(
            "product_id, quantity, unit_price, discount_amount, line_total, pharmacy_pos_sales!inner(status, created_at), pharmacy_products(name, sku, category)"
          )
          .eq("tenant_id", tenantId)
          .eq("pharmacy_pos_sales.status", "completed")
          .gte("pharmacy_pos_sales.created_at", dateFromISO)
          .lte("pharmacy_pos_sales.created_at", dateToISO),
        // Line-level tax lives in its own query so a database without the
        // column (before 20261102110000) loses only the breakdown, not the
        // POS revenue that the report above still reads.
        (supabaseAdmin as any)
          .from("pharmacy_pos_sale_items")
          .select(
            "line_total, vat_category, taxable_amount, tax_amount, tax_source, pharmacy_pos_sales!inner(status, created_at)"
          )
          .eq("tenant_id", tenantId)
          .eq("pharmacy_pos_sales.status", "completed")
          .gte("pharmacy_pos_sales.created_at", dateFromISO)
          .lte("pharmacy_pos_sales.created_at", dateToISO),
      ])

      if (txResult.error) throw txResult.error
      if (itemsResult.error) throw itemsResult.error
      // POS queries may fail on older schemas — treat as empty
      if (posResult.error) console.warn("[reports] pos sales:", posResult.error.message)
      if (posItemsResult.error) console.warn("[reports] pos items:", posItemsResult.error.message)
      if (taxLinesResult.error)
        console.warn("[reports] pos line tax:", taxLinesResult.error.message)

      type TxRow = {
        id: string
        transaction_no: string | null
        total_amount: number | null
        net_amount: number | null
        discount: number | null
        tax: number | null
        payment_method: string | null
        client_name: string | null
        cashier_id: string | null
        created_at: string
        profiles: {
          full_name: string | null
          first_name: string | null
          last_name: string | null
        } | null
      }

      type ItemRow = {
        product_id: string | null
        quantity: number | null
        total_price: number | null
        unit_price: number | null
        pharmacy_transactions: { status: string; created_at: string } | null
        pharmacy_products: {
          name: string | null
          sku: string | null
          category: string | null
        } | null
      }

      // `net_amount` does not mean the same thing in every writer: the Tally
      // import stores the pre-tax voucher total there, while the edit route
      // stores what the customer owes (total - discount + tax). Summing it as
      // revenue charges VAT twice on an edited Tally sale. `total_amount` is
      // the pre-tax line sum everywhere and `discount` is what is taken off it,
      // so that difference is the tax-exclusive sales basis for every row.
      const orderTxs = ((txResult.data ?? []) as unknown as TxRow[]).map((tx) => ({
        ...tx,
        net_amount: Number(tx.total_amount ?? 0) - Number(tx.discount ?? 0),
      }))
      const posTxs = ((posResult.data ?? []) as Array<{
        id: string
        receipt_number: string
        total_amount: number
        discount_total: number
        tax_amount: number
        payment_method: string | null
        cashier_id: string | null
        created_at: string
      }>).map((s) => ({
        id: s.id,
        transaction_no: s.receipt_number,
        // `pharmacy_pos_sales.total_amount` is stored tax-inclusive
        // (subtotal - discount + tax). Reporting the tax-exclusive, net-of-
        // discount figure on both sides keeps the Tax card from being a slice
        // of Total Sales counted a second time.
        net_amount: Number(s.total_amount ?? 0) - Number(s.tax_amount ?? 0),
        discount: Number(s.discount_total ?? 0),
        tax: Number(s.tax_amount ?? 0),
        payment_method: s.payment_method,
        client_name: null,
        cashier_id: s.cashier_id,
        created_at: s.created_at,
        profiles: null,
      })) as TxRow[]

      // POS sales store only `cashier_id`; without this lookup every POS sale
      // is attributed to "Unknown Staff" in the staff breakdown.
      const posCashierIds = [
        ...new Set(posTxs.map((tx) => tx.cashier_id).filter(Boolean)),
      ] as string[]
      if (posCashierIds.length > 0) {
        const { data: posProfiles } = await (supabaseAdmin as any)
          .from("profiles")
          .select("id, full_name, first_name, last_name")
          .in("id", posCashierIds)
        const byId = new Map<string, TxRow["profiles"]>(
          (posProfiles ?? []).map(
            (p: { id: string; full_name: string | null; first_name: string | null; last_name: string | null }) => [
              p.id,
              { full_name: p.full_name, first_name: p.first_name, last_name: p.last_name },
            ],
          ),
        )
        for (const tx of posTxs) {
          tx.profiles = tx.cashier_id ? (byId.get(tx.cashier_id) ?? null) : null
        }
      }

      const transactions = [...posTxs, ...orderTxs].sort(
        (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
      )

      const orderItems = (itemsResult.data ?? []) as unknown as ItemRow[]
      const posItemsRaw = (posItemsResult.data ?? []) as Array<{
        product_id: string | null
        quantity: number | null
        unit_price: number | null
        discount_amount: number | null
        line_total: number | null
        pharmacy_products: ItemRow["pharmacy_products"]
      }>
      // POS discounts live on the lines, not on `discount_total` (the sale RPC
      // is called with `p_discount_total: 0` so it cannot double-count them),
      // so the summary has to read them from the items.
      const posLineDiscount = posItemsRaw.reduce(
        (sum, i) => sum + Number(i.discount_amount ?? 0),
        0,
      )
      const posItems = posItemsRaw.map((i) => ({
        product_id: i.product_id,
        quantity: i.quantity,
        total_price:
          i.line_total != null
            ? Number(i.line_total)
            : Number(i.quantity ?? 0) * Number(i.unit_price ?? 0) - Number(i.discount_amount ?? 0),
        unit_price: i.unit_price,
        pharmacy_transactions: null,
        pharmacy_products: i.pharmacy_products,
      })) as ItemRow[]

      const items = [...posItems, ...orderItems]

      // Aggregate totals
      let totalSalesAmt = 0
      let totalDiscountAmt = 0
      let totalTaxAmt = 0

      for (const tx of transactions) {
        totalSalesAmt += tx.net_amount ?? 0
        totalDiscountAmt += tx.discount ?? 0
        totalTaxAmt += tx.tax ?? 0
      }
      totalDiscountAmt += posLineDiscount

      // ── Tax breakdown from the persisted sale lines ───────────────────────
      const posHeaderTax = posTxs.reduce((sum, tx) => sum + Number(tx.tax ?? 0), 0)
      const { tax: taxBreakdown, reconciliation: posTaxReconciliation } = summariseLineTax(
        (taxLinesResult.data ?? []) as TaxLineRow[],
        posHeaderTax,
      )

      // Sales by payment method (JS aggregation — no groupBy in Supabase JS client)
      const paymentMethodMap = new Map<
        string,
        { payment_method: string; total: number; count: number }
      >()
      for (const tx of transactions) {
        const method = tx.payment_method ?? "UNKNOWN"
        const existing = paymentMethodMap.get(method) ?? {
          payment_method: method,
          total: 0,
          count: 0,
        }
        existing.total += tx.net_amount ?? 0
        existing.count += 1
        paymentMethodMap.set(method, existing)
      }
      const salesByPaymentMethod = Array.from(paymentMethodMap.values()).map((row) => ({
        paymentMethod: row.payment_method,
        payment_method: row.payment_method,
        total: row.total,
        count: row.count,
        _sum: { netAmount: row.total },
        _count: row.count,
      }))

      // Sales by day
      const salesByDayMap = new Map<
        string,
        { date: string; total: number; count: number }
      >()
      for (const tx of transactions) {
        const dateStr = tx.created_at.split("T")[0]
        const existing = salesByDayMap.get(dateStr) ?? {
          date: dateStr,
          total: 0,
          count: 0,
        }
        existing.total += tx.net_amount ?? 0
        existing.count += 1
        salesByDayMap.set(dateStr, existing)
      }
      const salesByDay = Array.from(salesByDayMap.values()).sort((a, b) =>
        a.date.localeCompare(b.date)
      )

      // Sales by category
      const salesByCategoryMap = new Map<
        string,
        { category: string; total: number; count: number }
      >()
      for (const item of items) {
        const category =
          item.pharmacy_products?.category ?? "Uncategorized"
        const existing = salesByCategoryMap.get(category) ?? {
          category,
          total: 0,
          count: 0,
        }
        existing.total += item.total_price ?? 0
        existing.count += 1
        salesByCategoryMap.set(category, existing)
      }
      const salesByCategory = Array.from(salesByCategoryMap.values()).sort(
        (a, b) => b.total - a.total
      )

      // Top customers
      const topCustomersMap = new Map<
        string,
        { name: string; total: number; count: number }
      >()
      for (const tx of transactions) {
        if (tx.client_name) {
          const existing = topCustomersMap.get(tx.client_name) ?? {
            name: tx.client_name,
            total: 0,
            count: 0,
          }
          existing.total += tx.net_amount ?? 0
          existing.count += 1
          topCustomersMap.set(tx.client_name, existing)
        }
      }
      const topCustomers = Array.from(topCustomersMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)

      // Top products (JS aggregation)
      const topProductsMap = new Map<
        string,
        {
          productId: string
          productName: string | null
          productSku: string | null
          quantity: number
          total: number
        }
      >()
      for (const item of items) {
        const pid = item.product_id ?? "unknown"
        const existing = topProductsMap.get(pid) ?? {
          productId: pid,
          productName: item.pharmacy_products?.name ?? null,
          productSku: item.pharmacy_products?.sku ?? null,
          quantity: 0,
          total: 0,
        }
        existing.quantity += item.quantity ?? 0
        existing.total += item.total_price ?? 0
        topProductsMap.set(pid, existing)
      }
      const topProducts = Array.from(topProductsMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 10)
        .map((row) => ({
          productId: row.productId,
          productName: row.productName,
          productSku: row.productSku,
          quantity: row.quantity,
          total: row.total,
          _sum: { quantity: row.quantity, totalPrice: row.total },
          product: {
            id: row.productId,
            name: row.productName ?? "Unknown",
            sku: row.productSku ?? "",
          },
        }))

      // Sales by user (JS aggregation)
      const salesByUserMap = new Map<
        string,
        { cashier_id: string; userName: string | null; total: number; count: number }
      >()
      for (const tx of transactions) {
        const uid = tx.cashier_id ?? "unknown"
        const profile = tx.profiles
        // `??` cannot drop the empty string a bare `.join(" ")` produces, so a
        // captured name of "" would suppress the "Unknown Staff" fallback.
        const name =
          profile?.full_name ||
          [profile?.first_name, profile?.last_name].filter(Boolean).join(" ") ||
          null
        const existing = salesByUserMap.get(uid) ?? {
          cashier_id: uid,
          userName: name,
          total: 0,
          count: 0,
        }
        existing.total += tx.net_amount ?? 0
        existing.count += 1
        salesByUserMap.set(uid, existing)
      }
      const salesByUser = Array.from(salesByUserMap.values()).map((row) => ({
        userId: row.cashier_id,
        cashier_id: row.cashier_id,
        userName: row.userName,
        total: row.total,
        count: row.count,
        _sum: { netAmount: row.total },
        _count: row.count,
        user: { id: row.cashier_id, name: row.userName ?? "Unknown Staff" },
      }))

      const transactionCount = transactions.length

      return NextResponse.json({
        type: "sales",
        period,
        dateFrom,
        dateTo,
        summary: {
          totalSales: totalSalesAmt,
          totalDiscount: totalDiscountAmt,
          totalTax: totalTaxAmt,
          transactionCount,
          averageTransaction:
            transactionCount > 0 ? totalSalesAmt / transactionCount : 0,
        },
        tax: taxBreakdown,
        taxReconciliation: posTaxReconciliation,
        salesByPaymentMethod,
        salesByDay,
        salesByCategory,
        topCustomers,
        topProducts,
        salesByUser,
        transactions: transactions.slice(0, 100),
      })
    }

    // ── INVENTORY REPORT ─────────────────────────────────────────────────────
    if (reportType === "inventory") {
      // Get low stock threshold from settings
      const { data: settingsRow } = await (supabaseAdmin as any)
        .from("pharmacy_settings")
        .select("low_stock_threshold")
        .eq("tenant_id", tenantId)
        .single()

      const lowStockThreshold = settingsRow?.low_stock_threshold ?? 10
      const nowISO = new Date().toISOString()
      const thirtyDaysFromNow = new Date(
        Date.now() + 30 * 24 * 60 * 60 * 1000
      ).toISOString()

      const [
        allProductsResult,
        lowStockResult,
        outOfStockResult,
        expiringResult,
        expiredResult,
        stockMovementsResult,
      ] = await Promise.all([
        // All active products (for totals, value calc, category grouping)
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("id, name, sku, category, quantity, cost_price, price, reorder_level, expiry_date, is_active")
          .eq("tenant_id", tenantId)
          .eq("is_active", true),
        // Low stock (between 1 and threshold)
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .gt("quantity", 0)
          .lte("quantity", lowStockThreshold)
          .order("quantity", { ascending: true }),
        // Out of stock
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .lte("quantity", 0),
        // Expiring in 30 days
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .gte("expiry_date", nowISO)
          .lte("expiry_date", thirtyDaysFromNow)
          .order("expiry_date", { ascending: true }),
        // Already expired
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("*")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .lt("expiry_date", nowISO),
        // Recent stock adjustments in range
        (supabaseAdmin as any)
          .from("pharmacy_stock_adjustments")
          .select("*, pharmacy_products(name, sku)")
          .eq("tenant_id", tenantId)
          .gte("created_at", dateFromISO)
          .lte("created_at", dateToISO)
          .order("created_at", { ascending: false })
          .limit(50),
      ])

      if (allProductsResult.error) throw allProductsResult.error

      type ProductRow = {
        id: string
        name: string | null
        sku: string | null
        category: string | null
        quantity: number | null
        cost_price: number | null
        price: number | null
        reorder_level: number | null
        expiry_date: string | null
        is_active: boolean | null
      }

      const allProducts = (allProductsResult.data ?? []) as ProductRow[]

      const totalProducts = allProducts.length
      const totalUnits = allProducts.reduce(
        (sum, p) => sum + (p.quantity ?? 0),
        0
      )
      const inventoryValueAtCost = allProducts.reduce(
        (sum, p) => sum + (p.quantity ?? 0) * (p.cost_price ?? 0),
        0
      )
      const inventoryValueAtRetail = allProducts.reduce(
        (sum, p) => sum + (p.quantity ?? 0) * (p.price ?? 0),
        0
      )

      // Products by category (JS aggregation)
      const productsByCategoryMap = new Map<
        string,
        { category: string; count: number; total_quantity: number }
      >()
      for (const p of allProducts) {
        const cat = p.category ?? "Uncategorized"
        const existing = productsByCategoryMap.get(cat) ?? {
          category: cat,
          count: 0,
          total_quantity: 0,
        }
        existing.count += 1
        existing.total_quantity += p.quantity ?? 0
        productsByCategoryMap.set(cat, existing)
      }
      const productsByCategory = Array.from(productsByCategoryMap.values()).map((row) => ({
        category: row.category,
        count: row.count,
        total_quantity: row.total_quantity,
        quantity: row.total_quantity,
        _count: row.count,
        _sum: { quantity: row.total_quantity },
      }))

      const mapProduct = (p: any) => ({
        id: p.id,
        name: p.name ?? "Unknown",
        sku: p.sku ?? "",
        quantity: p.quantity ?? 0,
        reorderLevel: p.reorder_level ?? p.reorderLevel ?? 0,
        expiryDate: p.expiry_date ?? p.expiryDate ?? null,
        category: p.category ?? "Uncategorized",
        ...p,
      })

      return NextResponse.json({
        type: "inventory",
        period,
        dateFrom,
        dateTo,
        summary: {
          totalProducts,
          totalUnits,
          inventoryValueAtCost,
          inventoryValueAtRetail,
          potentialProfit: inventoryValueAtRetail - inventoryValueAtCost,
          lowStockCount: lowStockResult.data?.length ?? 0,
          outOfStockCount: outOfStockResult.data?.length ?? 0,
          expiringCount: expiringResult.data?.length ?? 0,
          expiredCount: expiredResult.data?.length ?? 0,
        },
        lowStockProducts: (lowStockResult.data ?? []).map(mapProduct),
        outOfStockProducts: (outOfStockResult.data ?? []).map(mapProduct),
        expiringProducts: (expiringResult.data ?? []).map(mapProduct),
        expiredProducts: (expiredResult.data ?? []).map(mapProduct),
        productsByCategory,
        stockMovements: stockMovementsResult.data ?? [],
      })
    }

    // ── PROFIT REPORT (POS ledger + legacy order txs) ─────────────────────────
    if (reportType === "profit") {
      const { listLedgerSalesForHistory } = await import("@/lib/pos/sale-ledger")
      const ledgerRows = await listLedgerSalesForHistory({
        tenantId,
        limit: 5000,
        fromIso: dateFromISO,
        toIso: dateToISO,
      })

      let totalRevenue = 0
      let totalCost = 0

      const profitByProduct: Record<
        string,
        {
          name: string
          revenue: number
          cost: number
          profit: number
          quantity: number
        }
      > = {}

      const profitByCategory: Record<
        string,
        { category: string; revenue: number; cost: number; profit: number }
      > = {}

      const txSet = new Set<string>()

      for (const sale of ledgerRows) {
        if (sale.status !== "COMPLETED") continue
        txSet.add(sale.id)
        for (const item of sale.items) {
          const unitCost =
            item.costPrice != null
              ? item.costPrice
              : item.product?.cost_price != null
                ? Number(item.product.cost_price)
                : 0
          const cost = unitCost * item.quantity
          const revenue = item.totalPrice

          totalRevenue += revenue
          totalCost += cost

          const productId = item.product?.id ?? "unknown"
          if (!profitByProduct[productId]) {
            profitByProduct[productId] = {
              name: item.product?.name ?? "Unknown",
              revenue: 0,
              cost: 0,
              profit: 0,
              quantity: 0,
            }
          }
          profitByProduct[productId].revenue += revenue
          profitByProduct[productId].cost += cost
          profitByProduct[productId].profit += revenue - cost
          profitByProduct[productId].quantity += item.quantity

          const category = item.product?.category ?? "Uncategorized"
          if (!profitByCategory[category]) {
            profitByCategory[category] = {
              category,
              revenue: 0,
              cost: 0,
              profit: 0,
            }
          }
          profitByCategory[category].revenue += revenue
          profitByCategory[category].cost += cost
          profitByCategory[category].profit += revenue - cost
        }
      }

      const profitByProductArray = Object.values(profitByProduct).sort(
        (a, b) => b.profit - a.profit,
      )
      const profitByCategoryArray = Object.values(profitByCategory).sort(
        (a, b) => b.profit - a.profit,
      )

      return NextResponse.json({
        type: "profit",
        period,
        dateFrom,
        dateTo,
        summary: {
          totalRevenue,
          totalCost,
          grossProfit: totalRevenue - totalCost,
          profitMargin:
            totalRevenue > 0
              ? ((totalRevenue - totalCost) / totalRevenue) * 100
              : 0,
          transactionCount: txSet.size,
        },
        profitByProduct: profitByProductArray.slice(0, 50),
        profitByCategory: profitByCategoryArray,
      })
    }

    if (reportType === "purchases") {
      const { data: purchases, error } = await (supabaseAdmin as any)
        .from("pharmacy_purchases")
        .select(
          "id, purchase_no, supplier_id, total, amount_paid, balance, payment_status, status, purchase_date, received_by, created_at, pharmacy_suppliers(name), pharmacy_purchase_items(product_id, product_name, quantity, unit_cost, line_total, batch_number)",
        )
        .eq("tenant_id", tenantId)
        .gte("purchase_date", dateFromISO.slice(0, 10))
        .lte("purchase_date", dateToISO.slice(0, 10))
        .order("purchase_date", { ascending: false })

      if (error) {
        // Same rule as /api/ready (PR-003): the client gets a message, the log
        // gets the database error.
        console.error("[reports] purchases:", error)
        return NextResponse.json({ error: "Failed to load purchases" }, { status: 500 })
      }

      const rows = purchases ?? []
      const bySupplier = new Map<string, { supplier: string; total: number; paid: number; balance: number; count: number }>()
      const byProduct = new Map<string, { product: string; quantity: number; cost: number }>()
      for (const row of rows) {
        const supplierName = (row.pharmacy_suppliers as { name?: string } | null)?.name ?? "Unknown"
        const current = bySupplier.get(row.supplier_id) ?? {
          supplier: supplierName,
          total: 0,
          paid: 0,
          balance: 0,
          count: 0,
        }
        current.total += Number(row.total ?? 0)
        current.paid += Number(row.amount_paid ?? 0)
        current.balance += Number(row.balance ?? 0)
        current.count += 1
        bySupplier.set(row.supplier_id, current)
        for (const item of row.pharmacy_purchase_items ?? []) {
          const key = item.product_id ?? item.product_name
          const prod = byProduct.get(key) ?? { product: item.product_name, quantity: 0, cost: 0 }
          prod.quantity += Number(item.quantity ?? 0)
          prod.cost += Number(item.line_total ?? 0)
          byProduct.set(key, prod)
        }
      }

      return NextResponse.json({
        type: "purchases",
        period,
        dateFrom,
        dateTo,
        summary: {
          purchaseCount: rows.length,
          purchaseValue: rows.reduce((sum: number, row: { total?: number }) => sum + Number(row.total ?? 0), 0),
          amountPaid: rows.reduce((sum: number, row: { amount_paid?: number }) => sum + Number(row.amount_paid ?? 0), 0),
          outstanding: rows.reduce((sum: number, row: { balance?: number }) => sum + Number(row.balance ?? 0), 0),
        },
        purchasesBySupplier: Array.from(bySupplier.values()).sort((a, b) => b.total - a.total),
        purchasesByProduct: Array.from(byProduct.values()).sort((a, b) => b.cost - a.cost).slice(0, 50),
        rows: rows.map((row: Record<string, unknown>) => ({
          id: row.id,
          purchaseNo: row.purchase_no,
          supplier: (row.pharmacy_suppliers as { name?: string } | null)?.name ?? "",
          total: Number(row.total ?? 0),
          paymentStatus: row.payment_status,
          status: row.status,
          date: row.purchase_date,
        })),
      })
    }

    // ── REFUNDS REPORT ───────────────────────────────────────────────────────
    // A refund is not a negative sale: part of what went back may have been a
    // receivable the customer never paid, so cash out and credit reversed are
    // reported separately and never summed into a single "refunded" figure.
    if (reportType === "refunds") {
      const [voidsResult, ledgerResult, orderResult] = await Promise.all([
        (supabaseAdmin as any)
          .from("pharmacy_pos_sales")
          .select(
            "id, receipt_number, total_amount, payment_method, payment_ref, voided_reason, voided_at, cashier_id",
          )
          .eq("tenant_id", tenantId)
          .eq("status", "voided")
          .gte("voided_at", dateFromISO)
          .lte("voided_at", dateToISO)
          .order("voided_at", { ascending: false }),
        (supabaseAdmin as any)
          .from("pharmacy_credit_ledger")
          .select("idempotency_key, amount")
          .eq("tenant_id", tenantId)
          .eq("type", "refund")
          .gte("created_at", dateFromISO)
          .lte("created_at", dateToISO),
        (supabaseAdmin as any)
          .from("pharmacy_transactions")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "REFUNDED")
          .gte("updated_at", dateFromISO)
          .lte("updated_at", dateToISO),
      ])

      if (voidsResult.error) {
        console.error("[reports] refunds:", voidsResult.error)
        return NextResponse.json({ error: "Failed to load refunds" }, { status: 500 })
      }
      if (ledgerResult.error) {
        console.error("[reports] refund receivables:", ledgerResult.error)
        return NextResponse.json({ error: "Failed to load refunds" }, { status: 500 })
      }

      const reversedBySale = new Map<string, number>()
      for (const row of (ledgerResult.data ?? []) as Array<Record<string, unknown>>) {
        const key = String(row.idempotency_key ?? "")
        if (!key.startsWith("pos-refund:")) continue
        reversedBySale.set(key.slice("pos-refund:".length), Number(row.amount ?? 0))
      }

      const voids = (voidsResult.data ?? []) as Array<Record<string, unknown>>
      const cashierIds = [...new Set(voids.map((row) => row.cashier_id).filter(Boolean))] as string[]
      const cashierNames = new Map<string, string>()
      if (cashierIds.length > 0) {
        const { data: profiles } = await (supabaseAdmin as any)
          .from("profiles")
          .select("id, full_name, first_name, last_name")
          .in("id", cashierIds)
        for (const profile of profiles ?? []) {
          cashierNames.set(
            String(profile.id),
            profile.full_name ||
              [profile.first_name, profile.last_name].filter(Boolean).join(" ") ||
              "Unknown",
          )
        }
      }

      const money = (value: unknown) => Math.round(Number(value ?? 0) * 100) / 100

      const rows = voids.map((row) => {
        const total = money(row.total_amount)
        const cashRefunded = decodePaidAmount({
          paymentRef: row.payment_ref as string | null,
          total,
          method: row.payment_method as string | null,
        })
        const outstanding = money(Math.max(total - cashRefunded, 0))
        const receivableReversed = money(reversedBySale.get(String(row.id)) ?? 0)
        return {
          saleId: String(row.id),
          receiptNumber: String(row.receipt_number ?? ""),
          date: row.voided_at as string | null,
          cashier: cashierNames.get(String(row.cashier_id)) ?? "Unknown",
          paymentMethod: String(row.payment_method ?? "cash"),
          saleTotal: total,
          cashRefunded,
          receivableReversed,
          // A sale whose balance never reached the credit ledger still has an
          // unpaid part; saying so is the difference between a report and a guess.
          receivableUnposted: outstanding > 0 && receivableReversed === 0,
          reason: (row.voided_reason as string | null) ?? null,
        }
      })

      const round = (value: number) => Math.round(value * 100) / 100
      return NextResponse.json({
        type: "refunds",
        period,
        dateFrom,
        dateTo,
        summary: {
          refundCount: rows.length,
          cashRefunded: round(rows.reduce((sum, row) => sum + row.cashRefunded, 0)),
          receivableReversed: round(rows.reduce((sum, row) => sum + row.receivableReversed, 0)),
          refundedValue: round(
            rows.reduce((sum, row) => sum + row.cashRefunded + row.receivableReversed, 0),
          ),
          unpostedReceivables: rows.filter((row) => row.receivableUnposted).length,
          // Legacy order refunds carry no structured amount or till movement,
          // so they are counted here rather than estimated into the totals.
          excludedOrderRefunds: orderResult.error ? null : Number(orderResult.count ?? 0),
        },
        rows,
      })
    }

    return NextResponse.json({ error: "Invalid report type" }, { status: 400 })
  } catch (error) {
    console.error("Reports error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
