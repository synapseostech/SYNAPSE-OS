import { NextRequest, NextResponse } from "next/server"
import { isPharmacyAdmin, hasPermission } from "@/lib/auth"
import { requirePharmacyTenant } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { ensureDefaultPharmacyStore } from "@/lib/ensure-default-store"
import { listRecentLedgerSales, sumCompletedRevenue } from "@/lib/pos/sale-ledger"

async function countOpenPurchaseOrders(tenantId: string): Promise<number> {
  const { count } = await (supabaseAdmin as any)
    .from("pharmacy_purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .not("status", "in", '("RECEIVED","CANCELLED")')
  return count ?? 0
}

async function purchaseDashboard(tenantId: string, todayStartISO: string) {
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthISO = monthStart.toISOString().slice(0, 10)
  const todayDate = todayStartISO.slice(0, 10)
  const db = supabaseAdmin as any
  const [todayRows, monthRows] = await Promise.all([
    db
      .from("pharmacy_purchases")
      .select("id, total, balance, payment_status, status")
      .eq("tenant_id", tenantId)
      .gte("purchase_date", todayDate),
    db
      .from("pharmacy_purchases")
      .select("id, total, balance, payment_status, status")
      .eq("tenant_id", tenantId)
      .gte("purchase_date", monthISO),
  ])
  const today = todayRows.data ?? []
  const month = monthRows.data ?? []
  const receivedToday = today.filter((row: { status?: string }) => row.status === "RECEIVED")
  return {
    purchasesToday: today.length,
    purchasesThisMonth: month.length,
    purchaseValueMonth: month.reduce((sum: number, row: { total?: number }) => sum + Number(row.total ?? 0), 0),
    outstandingSupplierBalances: month.reduce(
      (sum: number, row: { balance?: number; payment_status?: string }) =>
        row.payment_status === "PAID" ? sum : sum + Number(row.balance ?? 0),
      0,
    ),
    stockReceivedToday: receivedToday.length,
  }
}

async function countPendingCustomerOrders(tenantId: string): Promise<number> {
  const { count } = await (supabaseAdmin as any)
    .from("pharmacy_orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", tenantId)
    .eq("status", "PENDING")
  return count ?? 0
}

export async function GET(request: NextRequest) {
  try {
    // Any authenticated pharmacy staff may load their dashboard (admin vs staff payload below).
    const auth = await requirePharmacyTenant()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    if (tenantId) {
      await ensureDefaultPharmacyStore(tenantId)
    }

    const adminUser = isPharmacyAdmin(session)
    const hasPOSAccess = adminUser || hasPermission(session, "MANAGE_POS")
    const hasInventoryAccess =
      adminUser ||
      hasPermission(session, "MANAGE_INVENTORY") ||
      hasPermission(session, "VIEW_INVENTORY")
    const hasTransactionAccess =
      adminUser ||
      hasPermission(session, "VIEW_TRANSACTIONS") ||
      hasPermission(session, "MANAGE_TRANSACTIONS")

    // Midnight in the business zone the ledger uses, not the server's clock.
    const kampalaToday = new Date(Date.now() + 3 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    const todayStartISO = new Date(`${kampalaToday}T00:00:00+03:00`).toISOString()
    const thirtyDaysFromNow = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000
    ).toISOString()
    const nowISO = new Date().toISOString()

    if (adminUser) {
      // Fetch settings first to get low_stock_threshold
      const { data: settings } = await (supabaseAdmin as any)
        .from("pharmacy_settings")
        .select("low_stock_threshold")
        .eq("tenant_id", tenantId)
        .single()

      const lowStockThreshold = settings?.low_stock_threshold ?? 10

      const [
        totalProductsResult,
        totalRevenue,
        todaySales,
        lowStockResult,
        expiringResult,
        recentActivityResult,
        staffSettingsResult,
        openPoCount,
        pendingCustomerOrders,
        purchaseStats,
      ] = await Promise.all([
        // Total active products
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("is_active", true),
        sumCompletedRevenue({ tenantId }),
        sumCompletedRevenue({ tenantId, fromIso: todayStartISO }),
        // Low stock count
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("id", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .lte("quantity", lowStockThreshold),
        // Expiring in 30 days
        (supabaseAdmin as any)
          .from("pharmacy_products")
          .select("id, name, sku, expiry_date, quantity")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .lte("expiry_date", thirtyDaysFromNow)
          .gte("expiry_date", nowISO)
          .order("expiry_date", { ascending: true }),
        // Recent activity logs (no implicit join)
        (supabaseAdmin as any)
          .from("pharmacy_audit_logs")
          .select("id, profile_id, action, entity, details, created_at")
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(8),
        // Staff settings (no implicit join)
        (supabaseAdmin as any)
          .from("pharmacy_user_settings")
          .select("profile_id, pharmacy_role")
          .eq("tenant_id", tenantId)
          .eq("is_active", true),
        countOpenPurchaseOrders(tenantId),
        countPendingCustomerOrders(tenantId),
        purchaseDashboard(tenantId, todayStartISO),
      ])

      const totalRevenueAmount = totalRevenue.amount
      const todaySalesAmount = todaySales.amount

      // Resolve profiles for activity logs and staff
      const activityLogs: any[] = recentActivityResult.data ?? []
      const staffRaw: any[] = staffSettingsResult.data ?? []
      const allProfileIds = [
        ...new Set([
          ...activityLogs.map((l: any) => l.profile_id).filter(Boolean),
          ...staffRaw.map((s: any) => s.profile_id).filter(Boolean),
        ]),
      ]
      const { data: profileRows } = await (supabaseAdmin as any)
        .from("profiles")
        .select("id, full_name, first_name, last_name")
        .in("id", allProfileIds)
      const profileMap = new Map((profileRows ?? []).map((p: any) => [p.id, p]))

      const resolveName = (profileId: string) => {
        const p: any = profileMap.get(profileId)
        return p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(" ") || "Unknown"
      }

      // Map recentActivity to expected shape
      const recentActivity = activityLogs.map((log: any) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        details: log.details,
        createdAt: log.created_at,
        user: { name: resolveName(log.profile_id), role: "STAFF" },
      }))

      const staffSettings = staffRaw

      const userStats = await Promise.all(
        staffSettings.map(async (pu) => {
          const today = await sumCompletedRevenue({
            tenantId,
            cashierId: pu.profile_id,
            fromIso: todayStartISO,
          })

          return {
            userId: pu.profile_id,
            userName: resolveName(pu.profile_id),
            userRole: pu.pharmacy_role,
            todaySales: today.amount,
            todayTransactions: today.count,
          }
        })
      )

      userStats.sort((a, b) => b.todaySales - a.todaySales)

      return NextResponse.json({
        totalUsers: staffSettings.length,
        totalProducts: totalProductsResult.count ?? 0,
        totalRevenue: totalRevenueAmount,
        todaySales: todaySalesAmount,
        lowStockCount: lowStockResult.count ?? 0,
        pendingOrders: openPoCount + pendingCustomerOrders,
        ...purchaseStats,
        expiringProducts: expiringResult.data ?? [],
        recentActivity,
        userStats,
        isAdmin: true,
      })
    }

    // Non-admin user dashboard
    const dashboardData: Record<string, unknown> = {
      isAdmin: false,
    }

    if (hasPOSAccess || hasInventoryAccess) {
      const { count } = await (supabaseAdmin as any)
        .from("pharmacy_products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
      dashboardData.totalProducts = count ?? 0
    }

    if (hasInventoryAccess) {
      const { data: settings } = await (supabaseAdmin as any)
        .from("pharmacy_settings")
        .select("low_stock_threshold")
        .eq("tenant_id", tenantId)
        .single()

      const threshold = settings?.low_stock_threshold ?? 10
      const { count } = await (supabaseAdmin as any)
        .from("pharmacy_products")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .lte("quantity", threshold)
      dashboardData.lowStockCount = count ?? 0
    }

    if (hasPOSAccess) {
      const [myToday, myAll, pendingOrders] = await Promise.all([
        sumCompletedRevenue({
          tenantId,
          cashierId: session.user.id,
          fromIso: todayStartISO,
        }),
        sumCompletedRevenue({ tenantId, cashierId: session.user.id }),
        countPendingCustomerOrders(tenantId),
      ])

      dashboardData.myTodaySales = myToday.amount
      dashboardData.myTodayTransactions = myToday.count
      dashboardData.myTotalSales = myAll.amount
      dashboardData.myTotalTransactions = myAll.count
      dashboardData.pendingOrders = pendingOrders
    }

    if (hasTransactionAccess) {
      dashboardData.recentTransactions = await listRecentLedgerSales({
        tenantId,
        cashierId: session.user.id,
        limit: 5,
      })
    }

    return NextResponse.json(dashboardData)
  } catch (error) {
    console.error("Dashboard stats error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
