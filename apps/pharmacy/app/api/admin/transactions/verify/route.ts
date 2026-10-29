import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyAdmin } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { isTallyMirrorNote } from "@/lib/tally/types"

/**
 * Comprehensive transaction data integrity verification
 * Checks for:
 * 1. Orphaned transaction items (items without transactions)
 * 2. Missing product references
 * 3. Stock adjustment mismatches
 * 4. Profit calculation consistency
 * 5. Missing batch references
 * 6. Data loss scenarios
 *
 * NOTE: The `verified` field does NOT exist in pharmacy_transactions.
 * Verification is an analysis-only operation — no column is updated.
 */
export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    if (!tenantId) {
      return NextResponse.json({ error: "No tenant" }, { status: 403 })
    }

    const report: {
      timestamp: string
      totalTransactions: number
      totalTransactionItems: number
      issues: {
        orphanedTransactionItems: Array<Record<string, unknown>>
        missingProductReferences: Array<Record<string, unknown>>
        missingUserReferences: Array<Record<string, unknown>>
        invalidStockAdjustments: Array<Record<string, unknown>>
        missingBatchReferences: Array<Record<string, unknown>>
        inconsistentProfitData: Array<Record<string, unknown>>
        negativeNetAmounts: Array<Record<string, unknown>>
        missingCostPrices: Array<Record<string, unknown>>
      }
      summary: {
        totalIssuesFound: number
        dataIntegrityScore: number
        recommendedActions: string[]
      }
    } = {
      timestamp: new Date().toISOString(),
      totalTransactions: 0,
      totalTransactionItems: 0,
      issues: {
        orphanedTransactionItems: [],
        missingProductReferences: [],
        missingUserReferences: [],
        invalidStockAdjustments: [],
        missingBatchReferences: [],
        inconsistentProfitData: [],
        negativeNetAmounts: [],
        missingCostPrices: [],
      },
      summary: {
        totalIssuesFound: 0,
        dataIntegrityScore: 100,
        recommendedActions: [],
      },
    }

    // 1. Count total records
    const [{ count: txCount }, { count: itemCount }] = await Promise.all([
      (supabaseAdmin as any)
        .from("pharmacy_transactions")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId),
      (supabaseAdmin as any)
        .from("pharmacy_transaction_items")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId),
    ])

    report.totalTransactions = txCount ?? 0
    report.totalTransactionItems = itemCount ?? 0

    // 2. Fetch all transaction items with product join
    const { data: allItems } = await (supabaseAdmin as any)
      .from("pharmacy_transaction_items")
      .select(`
        id, transaction_id, product_id, quantity, unit_price, cost_price, batch_id,
        product:pharmacy_products ( id, name )
      `)
      .eq("tenant_id", tenantId)

    // 3. Fetch all transactions with cashier join
    const { data: allTransactions } = await (supabaseAdmin as any)
      .from("pharmacy_transactions")
      .select(`
        id, transaction_no, cashier_id, net_amount, total_amount, tax, notes,
        items:pharmacy_transaction_items ( id, cost_price )
      `)
      .eq("tenant_id", tenantId)

    // Build a set of valid transaction IDs
    const validTransactionIds = new Set(
      (allTransactions ?? []).map((t: { id: string }) => t.id)
    )

    // Tally vouchers carry no cost of sale, so the importer stores a null cost
    // on purpose. Reporting those as integrity failures would drown the real
    // ones after a cut-over.
    const tallyMirrorIds = new Set(
      (allTransactions ?? [])
        .filter((t: { notes: string | null }) => isTallyMirrorNote(t.notes))
        .map((t: { id: string }) => t.id),
    )

    for (const item of allItems ?? []) {
      const typedItem = item as unknown as {
        id: string
        transaction_id: string
        product_id: string
        quantity: number
        unit_price: number
        cost_price: number | null
        batch_id: string | null
        product: { id: string; name: string } | null
      }

      // Orphaned items (transaction reference broken)
      if (!validTransactionIds.has(typedItem.transaction_id)) {
        report.issues.orphanedTransactionItems.push({
          itemId: typedItem.id,
          transactionId: typedItem.transaction_id,
          productId: typedItem.product_id,
          quantity: typedItem.quantity,
          reason: "Transaction reference broken",
        })
      }

      // Missing product references
      if (!typedItem.product) {
        report.issues.missingProductReferences.push({
          itemId: typedItem.id,
          productId: typedItem.product_id,
          transactionId: typedItem.transaction_id,
          reason: "Product was deleted or ID is invalid",
        })
      }

      // Missing cost prices
      if (typedItem.cost_price === null && !tallyMirrorIds.has(typedItem.transaction_id)) {
        report.issues.missingCostPrices.push({
          itemId: typedItem.id,
          transactionId: typedItem.transaction_id,
          productId: typedItem.product_id,
          quantity: typedItem.quantity,
          unitPrice: typedItem.unit_price,
          reason: "Cost price not recorded at time of sale",
        })
      }
    }

    // 4. Check transactions
    for (const transaction of allTransactions ?? []) {
      const typedTx = transaction as {
        id: string
        transaction_no: string
        cashier_id: string | null
        net_amount: number
        total_amount: number
        tax: number
        items: Array<{ id: string; cost_price: number | null }>
      }

      // Check cashier reference
      if (!typedTx.cashier_id) {
        report.issues.missingUserReferences.push({
          transactionId: typedTx.id,
          transactionNo: typedTx.transaction_no,
          cashierId: typedTx.cashier_id,
          itemCount: typedTx.items.length,
          reason: "Staff user account was deleted or cashier_id is null",
        })
      }

      // Negative net amounts
      if (typedTx.net_amount < 0) {
        report.issues.negativeNetAmounts.push({
          transactionId: typedTx.id,
          transactionNo: typedTx.transaction_no,
          netAmount: typedTx.net_amount,
          totalAmount: typedTx.total_amount,
          tax: typedTx.tax,
          reason: "Negative net amount indicates calculation error",
        })
      }

      // Inconsistent profit data (missing cost prices on items)
      const itemsWithCosts = typedTx.items.filter(
        (item) => item.cost_price !== null
      )
      if (
        itemsWithCosts.length !== typedTx.items.length &&
        typedTx.items.length > 0 &&
        !tallyMirrorIds.has(typedTx.id)
      ) {
        report.issues.inconsistentProfitData.push({
          transactionId: typedTx.id,
          transactionNo: typedTx.transaction_no,
          itemsWithoutCost: typedTx.items.length - itemsWithCosts.length,
          totalItems: typedTx.items.length,
          reason: "Cannot calculate profit accurately - missing cost prices",
        })
      }
    }

    // 5. Check stock adjustments referencing transactions
    const { data: stockAdjustments } = await supabaseAdmin
      .from("pharmacy_stock_adjustments")
      .select("id, reason, product_id, quantity")
      .eq("tenant_id", tenantId)
      .like("reason", "Sale - Transaction%")

    const transactionNoSet = new Set(
      (allTransactions ?? []).map((t: { transaction_no: string }) => t.transaction_no)
    )

    for (const adjustment of stockAdjustments ?? []) {
      const typedAdj = adjustment as {
        id: string
        reason: string | null
        product_id: string
        quantity: number
      }

      if (typedAdj.reason) {
        const match = typedAdj.reason.match(/Sale - Transaction (TXN\w+)/)
        if (match) {
          const transactionNo = match[1]
          if (!transactionNoSet.has(transactionNo)) {
            report.issues.invalidStockAdjustments.push({
              adjustmentId: typedAdj.id,
              transactionNo,
              productId: typedAdj.product_id,
              quantity: typedAdj.quantity,
              reason: "Transaction referenced in stock adjustment does not exist",
            })
          }
        }
      }
    }

    // 6. Check batch references on items
    const itemsWithBatchIds = (allItems ?? []).filter(
      (item: { batch_id: string | null }) => item.batch_id !== null
    ) as Array<{ id: string; batch_id: string; transaction_id: string }>

    const batchIdsToCheck = [
      ...new Set(itemsWithBatchIds.map((i) => i.batch_id)),
    ]

    if (batchIdsToCheck.length > 0) {
      const { data: existingBatches } = await supabaseAdmin
        .from("pharmacy_product_batches")
        .select("id")
        .eq("tenant_id", tenantId)
        .in("id", batchIdsToCheck)

      const existingBatchSet = new Set(
        (existingBatches ?? []).map((b: { id: string }) => b.id)
      )

      for (const item of itemsWithBatchIds) {
        if (!existingBatchSet.has(item.batch_id)) {
          report.issues.missingBatchReferences.push({
            itemId: item.id,
            batchId: item.batch_id,
            transactionId: item.transaction_id,
            reason: "Batch was deleted or ID is invalid",
          })
        }
      }
    }

    // Calculate summary
    const issueValues = Object.values(report.issues)
    report.summary.totalIssuesFound = issueValues.reduce(
      (sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0),
      0
    )

    const maxPossibleIssues = report.totalTransactionItems + report.totalTransactions
    if (maxPossibleIssues > 0) {
      report.summary.dataIntegrityScore = Math.max(
        0,
        100 - (report.summary.totalIssuesFound / maxPossibleIssues) * 100
      )
    }

    // Recommendations
    if (report.issues.orphanedTransactionItems.length > 0) {
      report.summary.recommendedActions.push(
        `Found ${report.issues.orphanedTransactionItems.length} orphaned transaction items. Run cleanup to delete them.`
      )
    }
    if (report.issues.missingProductReferences.length > 0) {
      report.summary.recommendedActions.push(
        `Found ${report.issues.missingProductReferences.length} items with missing product references. These items cannot be analyzed.`
      )
    }
    if (report.issues.missingUserReferences.length > 0) {
      report.summary.recommendedActions.push(
        `Found ${report.issues.missingUserReferences.length} transactions with deleted staff users. Update staff records or reassign.`
      )
    }
    if (report.issues.invalidStockAdjustments.length > 0) {
      report.summary.recommendedActions.push(
        `Found ${report.issues.invalidStockAdjustments.length} stock adjustments for non-existent transactions. Verify stock levels.`
      )
    }
    if (report.issues.missingCostPrices.length > 0) {
      report.summary.recommendedActions.push(
        `Found ${report.issues.missingCostPrices.length} items without recorded cost prices. Profit calculations may be inaccurate for these items.`
      )
    }

    if (report.summary.totalIssuesFound === 0) {
      report.summary.recommendedActions.push(
        "All transaction data is consistent and complete. No issues found."
      )
    }

    return NextResponse.json(report)
  } catch (error) {
    console.error("Verification error:", error)
    return NextResponse.json(
      {
        error: "Internal server error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

/**
 * POST /api/admin/transactions/verify
 * Handles cleanup operations and single-transaction verification (Admin only)
 * NOTE: The `verified` field does NOT exist in pharmacy_transactions.
 * Single-transaction verification confirms the record exists — no column is written.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyAdmin()
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    if (!tenantId) {
      return NextResponse.json({ error: "No tenant" }, { status: 403 })
    }

    const body = await request.json()
    const { action, id } = body as { action?: string; id?: string }

    if (action) {
      if (action === "cleanup-orphaned-items") {
        // Fetch all valid transaction IDs for this tenant
        const { data: txRows } = await supabaseAdmin
          .from("pharmacy_transactions")
          .select("id")
          .eq("tenant_id", tenantId)

        const validIds = (txRows ?? []).map((t: { id: string }) => t.id)

        if (validIds.length === 0) {
          // No transactions at all — delete all items for this tenant
          const { data: deleted } = await supabaseAdmin
            .from("pharmacy_transaction_items")
            .delete()
            .eq("tenant_id", tenantId)
            .select("id")

          const cleanedCount = deleted?.length ?? 0

          await supabaseAdmin.from("pharmacy_audit_logs").insert({
            tenant_id: tenantId,
            profile_id: session.user.id,
            action: "CLEANUP_ORPHANED_TRANSACTION_ITEMS",
            entity: "TRANSACTION",
            details: `Cleaned up ${cleanedCount} orphaned transaction items`,
          })

          return NextResponse.json({
            success: true,
            message: `Cleaned up ${cleanedCount} orphaned transaction items`,
            cleaned: cleanedCount,
          })
        }

        // Delete items whose transaction_id is not in validIds
        const { data: orphaned } = await supabaseAdmin
          .from("pharmacy_transaction_items")
          .select("id")
          .eq("tenant_id", tenantId)
          .not("transaction_id", "in", `(${validIds.join(",")})`)

        if (!orphaned || orphaned.length === 0) {
          return NextResponse.json({
            success: true,
            message: "No orphaned items found",
            cleaned: 0,
          })
        }

        const orphanedIds = orphaned.map((o: { id: string }) => o.id)

        await supabaseAdmin
          .from("pharmacy_transaction_items")
          .delete()
          .in("id", orphanedIds)
          .eq("tenant_id", tenantId)

        await supabaseAdmin.from("pharmacy_audit_logs").insert({
          tenant_id: tenantId,
          profile_id: session.user.id,
          action: "CLEANUP_ORPHANED_TRANSACTION_ITEMS",
          entity: "TRANSACTION",
          details: `Cleaned up ${orphanedIds.length} orphaned transaction items`,
        })

        return NextResponse.json({
          success: true,
          message: `Cleaned up ${orphanedIds.length} orphaned transaction items`,
          cleaned: orphanedIds.length,
        })
      }

      return NextResponse.json({ error: "Invalid action" }, { status: 400 })
    }

    // Single transaction verification — confirm it exists, no write needed
    if (id) {
      const { data: transaction, error } = await (supabaseAdmin as any)
        .from("pharmacy_transactions")
        .select("id, transaction_no")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .single()

      if (error || !transaction) {
        return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
      }

      // NOTE: `verified` column does not exist — analysis only
      return NextResponse.json({
        success: true,
        message: "Transaction verified successfully",
        transactionNo: transaction.transaction_no,
      })
    }

    return NextResponse.json(
      { error: "Either action or transaction ID required" },
      { status: 400 }
    )
  } catch (error) {
    console.error("Operation error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
