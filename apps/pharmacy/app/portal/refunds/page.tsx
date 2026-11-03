"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { Search, RotateCcw, X, AlertTriangle } from "lucide-react"
import { formatCurrency } from "@/lib/utils"

export const dynamic = 'force-dynamic'

interface Transaction {
  id: string
  transactionNo: string
  totalAmount: number
  discount: number
  netAmount: number
  /** Cash the customer actually handed over; this is what a refund pays back. */
  paidAmount: number
  /** Part of the sale that sits on the customer's account, not in the till. */
  balanceDue: number
  paymentMethod: string
  status: string
  notes?: string
  createdAt: string
  user: { name: string }
  customer?: { name: string }
  items: Array<{
    id: string
    productId: string
    quantity: number
    unitPrice: number
    totalPrice: number
    product: { name: string; sku: string }
  }>
}

export default function RefundsPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [transaction, setTransaction] = useState<Transaction | null>(null)
  const [refunds, setRefunds] = useState<Transaction[]>([])
  const [isSearching, setIsSearching] = useState(false)
  const [showRefundDialog, setShowRefundDialog] = useState(false)
  const [refundReason, setRefundReason] = useState("")
  const [restoreSellable, setRestoreSellable] = useState(false)
  const [isProcessing, setIsProcessing] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    fetchRefunds()
  }, [])

  const fetchRefunds = async () => {
    try {
      const response = await fetch("/api/admin/refunds")
      if (response.ok) {
        const data = await response.json()
        setRefunds(data)
      }
    } catch (error) {
      console.error("Failed to fetch refunds:", error)
    }
  }

  const searchTransaction = async () => {
    if (!searchQuery.trim()) return

    setIsSearching(true)
    try {
      const response = await fetch(`/api/admin/transactions?search=${encodeURIComponent(searchQuery)}`)
      if (!response.ok) throw new Error("Failed to search")
      
      const data = await response.json()
      const transactions: Transaction[] = Array.isArray(data) ? data : data.transactions || []
      const query = searchQuery.trim().toLowerCase()

      // Never fall back to the newest sale: refunding the wrong receipt is far
      // worse than asking the user to type more of the number.
      const exact = transactions.filter(
        (t) => String(t.transactionNo ?? "").toLowerCase() === query,
      )
      if (exact.length === 1) {
        setTransaction(exact[0])
      } else if (exact.length === 0 && transactions.length === 1) {
        setTransaction(transactions[0])
      } else if (transactions.length > 1) {
        toast({
          title: "Several matches",
          description: "Enter the complete receipt number so the right sale is refunded.",
          variant: "destructive",
        })
        setTransaction(null)
      } else {
        toast({
          title: "Not Found",
          description: "No transaction found with that number",
          variant: "destructive",
        })
        setTransaction(null)
      }
    } catch (error) {
      toast({
        title: "Error",
        description: "Failed to search for transaction",
        variant: "destructive",
      })
    } finally {
      setIsSearching(false)
    }
  }

  const processRefund = async () => {
    if (!transaction) return

    setIsProcessing(true)
    try {
      const response = await fetch("/api/admin/refunds", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactionId: transaction.id,
          reason: refundReason,
          restoreAs: restoreSellable ? "active" : "quarantined",
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || "Failed to process refund")
      }

      const data = await response.json()

      const parts = [`Cash refunded ${formatCurrency(data.refundAmount)}`]
      if (Number(data.receivableReversal ?? 0) > 0) {
        parts.push(`customer credit reduced by ${formatCurrency(data.receivableReversal)}`)
      }
      if (data.receivableUnposted) {
        parts.push("an unpaid balance remains that was never posted to the credit ledger")
      } else if (Number(data.receivableUnreversed ?? 0) > 0) {
        parts.push(
          `${formatCurrency(Number(data.receivableUnreversed))} of the unpaid balance stays on the customer's account`,
        )
      }
      toast({ title: "Refund Processed", description: parts.join("; ") })

      setShowRefundDialog(false)
      setTransaction(null)
      setSearchQuery("")
      setRefundReason("")
      setRestoreSellable(false)
      fetchRefunds()
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to process refund",
        variant: "destructive",
      })
    } finally {
      setIsProcessing(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">Refunds & Returns</h1>
        <p className="text-muted-foreground">Process refunds and view refund history</p>
      </div>

      {/* Search */}
      <Card>
        <CardHeader>
          <CardTitle>Search Transaction</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-4">
            <div className="flex-1">
              <Input
                placeholder="Enter transaction number (e.g., TXN-ABC123)"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && searchTransaction()}
              />
            </div>
            <Button onClick={searchTransaction} disabled={isSearching}>
              <Search className="mr-2 h-4 w-4" />
              {isSearching ? "Searching..." : "Search"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Transaction Details */}
      {transaction && (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>Transaction: {transaction.transactionNo}</CardTitle>
            <Button variant="ghost" size="icon" onClick={() => setTransaction(null)}>
              <X className="h-4 w-4" />
            </Button>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <Label className="text-sm text-muted-foreground">Date</Label>
                <p className="font-medium">{new Date(transaction.createdAt).toLocaleString()}</p>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground">Cashier</Label>
                <p className="font-medium">{transaction.user.name}</p>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground">Payment Method</Label>
                <p className="font-medium">{transaction.paymentMethod}</p>
              </div>
              <div>
                <Label className="text-sm text-muted-foreground">Status</Label>
                <p className={`font-medium ${transaction.status === "REFUNDED" ? "text-destructive" : "text-[#22C55E]"}`}>
                  {transaction.status}
                </p>
              </div>
            </div>

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead>SKU</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(transaction.items ?? []).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-medium">{item.product?.name || "Unknown"}</TableCell>
                    <TableCell>{item.product?.sku || "-"}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">{formatCurrency(item.unitPrice)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(item.totalPrice)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex justify-between items-center pt-4 border-t">
              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">Subtotal: {formatCurrency(transaction.totalAmount)}</p>
                {transaction.discount > 0 && (
                  <p className="text-sm text-muted-foreground">Discount: -{formatCurrency(transaction.discount)}</p>
                )}
                <p className="text-lg font-bold">Total: {formatCurrency(transaction.netAmount)}</p>
              </div>
              
              {transaction.status !== "REFUNDED" && (
                <Button 
                  variant="destructive" 
                  onClick={() => setShowRefundDialog(true)}
                >
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Process Refund
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Refund Confirmation Dialog */}
      {showRefundDialog && transaction && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md mx-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-yellow-500" />
                Confirm Refund
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p>Are you sure you want to refund transaction <strong>{transaction.transactionNo}</strong>?</p>

              <div className="space-y-1">
                <p className="text-sm text-muted-foreground">
                  Sale total: {formatCurrency(transaction.netAmount)}
                </p>
                <p className="text-lg font-bold">
                  Cash to refund: {formatCurrency(transaction.paidAmount ?? transaction.netAmount)}
                </p>
                {Number(transaction.balanceDue ?? 0) > 0 && (
                  <p className="text-sm text-muted-foreground">
                    Customer credit to reverse: {formatCurrency(transaction.balanceDue)}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label>Reason for Refund</Label>
                <Input
                  placeholder="Enter reason for refund"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                />
              </div>

              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={restoreSellable}
                  onChange={(e) => setRestoreSellable(e.target.checked)}
                />
                <span>
                  Returned units are sellable — put them back into their batch as active stock.
                  Leave unchecked to quarantine the batch until a pharmacist inspects it.
                </span>
              </label>

              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm">
                <p className="font-medium text-yellow-800">This action will:</p>
                <ul className="list-disc list-inside text-yellow-400 mt-1">
                  <li>Mark the transaction as refunded</li>
                  <li>
                    {restoreSellable
                      ? "Return the sold units to their batch as active stock"
                      : "Quarantine the returned units' batch so it cannot be sold until released"}
                  </li>
                  <li>Create an audit log entry</li>
                </ul>
              </div>

              <div className="flex gap-3 pt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowRefundDialog(false)
                    setRefundReason("")
                    setRestoreSellable(false)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  className="flex-1"
                  onClick={processRefund}
                  disabled={isProcessing}
                >
                  {isProcessing ? "Processing..." : "Confirm Refund"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Refund History */}
      <Card>
        <CardHeader>
          <CardTitle>Refund History</CardTitle>
        </CardHeader>
        <CardContent>
          {refunds.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">No refunds processed yet</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Transaction #</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Processed By</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refunds.map((refund) => (
                  <TableRow key={refund.id}>
                    <TableCell className="font-medium">{refund.transactionNo}</TableCell>
                    <TableCell>{new Date(refund.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell>{refund.customer?.name || "Walk-in"}</TableCell>
                    <TableCell>{refund.user.name}</TableCell>
                    <TableCell className="text-right text-destructive">
                      -{formatCurrency(refund.netAmount)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
