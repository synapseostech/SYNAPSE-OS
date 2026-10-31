"use client"

import { useEffect, useState } from "react"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"

// Force dynamic rendering
export const dynamic = 'force-dynamic'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { formatCurrency } from "@/lib/utils"
import { DollarSign, TrendingUp, Calendar, Filter, Download, Eye, Printer, X, RotateCcw, Edit, AlertTriangle } from "lucide-react"

interface TransactionItem {
  id: string
  quantity: number
  unitPrice: number
  costPrice?: number  // Cost price at time of sale
  totalPrice: number
  product: {
    id: string
    name: string
    sku: string
    costPrice: number
    expiryDate?: string
    batchNumber?: string
  }
}

interface Transaction {
  id: string
  transactionNo: string
  clientName?: string
  clientPhone?: string
  clientAddress?: string
  totalAmount: number
  netAmount: number
  discount?: number
  tax?: number
  paymentMethod: string
  isEdited?: boolean
  createdAt: string
  source?: "pos" | "order"
  user: {
    name: string
  }
  items: TransactionItem[]
}

interface PharmacySettings {
  pharmacyName: string
  location: string
  contact: string
  email: string
  footerText?: string
  currency?: string
  logo?: string
  receiptPaperWidth?: "58" | "80" | "a4"
  receiptFontScale?: number
}

interface Stats {
  today: number
  week: number
  month: number
  todayProfit: number
  weekProfit: number
  monthProfit: number
}

export default function TransactionsPage() {
  const { user } = usePharmacySession()
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [filteredTransactions, setFilteredTransactions] = useState<Transaction[]>([])
  const [stats, setStats] = useState<Stats>({
    today: 0, week: 0, month: 0,
    todayProfit: 0, weekProfit: 0, monthProfit: 0
  })
  const [isLoading, setIsLoading] = useState(true)
  const [showFilters, setShowFilters] = useState(true)
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null)
  const [settings, setSettings] = useState<PharmacySettings | null>(null)
  const [isResetting, setIsResetting] = useState(false)
  const [printTransactionData, setPrintTransactionData] = useState<Transaction | null>(null)
  const [isPrintingReceipt, setIsPrintingReceipt] = useState(false)
  const [showClientNameBeforePrintDialog, setShowClientNameBeforePrintDialog] = useState(false)
  const [clientNameBeforePrint, setClientNameBeforePrint] = useState("")
  const [pendingPrintTransaction, setPendingPrintTransaction] = useState<Transaction | null>(null)
  const [isSavingClientNameBeforePrint, setIsSavingClientNameBeforePrint] = useState(false)

  // Edit transaction state
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null)
  const [editItems, setEditItems] = useState<{ id: string, quantity: number, unitPrice: number, productName: string }[]>([])
  const [editPaymentMethod, setEditPaymentMethod] = useState("")
  const [editReason, setEditReason] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  // Delete transaction state
  const [transactionToDelete, setTransactionToDelete] = useState<Transaction | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Mirror isPharmacyAdmin: the reset and delete routes accept pharmacy_ceo and
  // profile-level admins too, so keying the buttons off pharmacy_admin alone
  // hides them from people the API would allow.
  const isAdmin =
    Boolean(user?.isAdmin) ||
    user?.pharmacyRole === "pharmacy_admin" ||
    user?.pharmacyRole === "pharmacy_ceo"

  // Check if current user can view profit (Admin or CEO only)
  const canViewProfit = user?.pharmacyRole === "pharmacy_admin" || user?.pharmacyRole === "pharmacy_ceo"

  // Filter states
  const [cashierFilter, setCashierFilter] = useState("")
  const [paymentFilter, setPaymentFilter] = useState("")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [txnSearch, setTxnSearch] = useState("")

  useEffect(() => {
    fetchTransactions()
    fetchSettings()
  }, [])

  useEffect(() => {
    applyFilters()
  }, [transactions, cashierFilter, paymentFilter, startDate, endDate, txnSearch])

  useEffect(() => {
    const handleAfterPrint = () => {
      setIsPrintingReceipt(false)
      setPrintTransactionData(null)
    }
    window.addEventListener("afterprint", handleAfterPrint)
    return () => window.removeEventListener("afterprint", handleAfterPrint)
  }, [])

  const triggerReliablePrint = () => {
    // Wait for React to paint the print tree before opening the print dialog.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => window.print(), 50)
      })
    })
  }

  const applyFilters = () => {
    let filtered = [...transactions]

    if (txnSearch.trim()) {
      const q = txnSearch.trim().toLowerCase()
      filtered = filtered.filter(
        (t) =>
          t.transactionNo.toLowerCase().includes(q) ||
          (t.clientName ?? "").toLowerCase().includes(q) ||
          (t.clientPhone ?? "").toLowerCase().includes(q),
      )
    }

    if (cashierFilter) {
      filtered = filtered.filter(t =>
        t.user.name.toLowerCase().includes(cashierFilter.toLowerCase())
      )
    }

    if (paymentFilter) {
      filtered = filtered.filter(t => t.paymentMethod === paymentFilter)
    }

    if (startDate) {
      filtered = filtered.filter(t =>
        new Date(t.createdAt) >= new Date(startDate)
      )
    }

    if (endDate) {
      const end = new Date(endDate)
      end.setHours(23, 59, 59, 999)
      filtered = filtered.filter(t =>
        new Date(t.createdAt) <= end
      )
    }

    setFilteredTransactions(filtered)
  }

  const calculateProfit = (transaction: Transaction) => {
    return (transaction.items ?? []).reduce((total, item) => {
      // Use stored costPrice if available, otherwise fall back to current product cost
      const costAtSale = item.costPrice ?? item.product?.costPrice ?? 0
      const profit = (item.unitPrice - costAtSale) * Math.abs(item.quantity ?? 0)
      return total + profit
    }, 0)
  }

  const clearFilters = () => {
    setCashierFilter("")
    setPaymentFilter("")
    setStartDate("")
    setEndDate("")
    setTxnSearch("")
  }

  const handleResetTransactions = async () => {
    if (!confirm("WARNING: This will permanently delete ALL sales transactions and cannot be undone. Are you absolutely sure you want to reset all sales to zero?")) {
      return
    }

    // Double confirmation
    if (!confirm("This is your FINAL confirmation. ALL transaction data will be permanently deleted. Continue?")) {
      return
    }

    setIsResetting(true)
    try {
      const response = await fetch("/api/admin/transactions", {
        method: "DELETE",
      })

      if (response.ok) {
        const data = await response.json()
        alert(`Successfully reset. ${data.deletedCount} transactions deleted.`)
        fetchTransactions()
      } else {
        const error = await response.json()
        alert(`Error: ${error.error || "Failed to reset transactions"}`)
      }
    } catch (error) {
      console.error("Reset error:", error)
      alert("An error occurred while resetting transactions")
    } finally {
      setIsResetting(false)
    }
  }

  const handleDeleteTransaction = async () => {
    if (!transactionToDelete) return

    setIsDeleting(true)
    try {
      const response = await fetch(`/api/admin/transactions/${transactionToDelete.id}`, {
        method: "DELETE",
      })

      if (response.ok) {
        const data = await response.json()
        alert(`Transaction ${transactionToDelete.transactionNo} has been successfully deleted. Stock levels have been restored.`)
        setTransactionToDelete(null)
        fetchTransactions()
      } else {
        const error = await response.json()
        alert(`Error: ${error.error || "Failed to delete transaction"}`)
      }
    } catch (error) {
      console.error("Delete error:", error)
      alert("An error occurred while deleting the transaction")
    } finally {
      setIsDeleting(false)
    }
  }

  const fetchTransactions = async () => {
    try {
      const response = await fetch("/api/admin/transactions")
      const data = await response.json()
      setTransactions(data.transactions)
      setFilteredTransactions(data.transactions)
      setStats(data.stats)
    } catch (error) {
      console.error("Failed to fetch transactions:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/admin/settings")
      if (response.ok) {
        const data = await response.json()
        setSettings(data)
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error)
    }
  }

  // Start editing a transaction
  const startEditTransaction = (transaction: Transaction) => {
    if (transaction.source === "pos") {
      alert("POS sales are append-only. Use Refunds/Void to reverse stock and cash.")
      return
    }
    setEditingTransaction(transaction)
    setEditItems((transaction.items ?? []).map(item => ({
      id: item.id,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      productName: item.product?.name ?? "Unknown"
    })))
    setEditPaymentMethod(transaction.paymentMethod)
    setEditReason("")
  }

  // Handle item change during edit
  const handleEditItemChange = (id: string, field: "quantity" | "unitPrice", value: number) => {
    setEditItems(prev => prev.map(item =>
      item.id === id ? { ...item, [field]: value } : item
    ))
  }

  // Save edited transaction
  const saveEditedTransaction = async () => {
    if (!editingTransaction) return

    if (!editReason || editReason.trim().length < 10) {
      alert("Please provide a reason for the edit (minimum 10 characters)")
      return
    }

    setIsSaving(true)
    try {
      const response = await fetch(`/api/admin/transactions/${editingTransaction.id}/edit`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: editItems.map(item => ({
            id: item.id,
            quantity: item.quantity,
            unitPrice: item.unitPrice
          })),
          paymentMethod: editPaymentMethod,
          reason: editReason.trim()
        })
      })

      if (response.ok) {
        const data = await response.json()
        alert("Transaction updated successfully! CEO and Admin have been notified.")
        setEditingTransaction(null)
        setEditReason("")
        fetchTransactions()

        if (data.transaction && confirm("Would you like to print the updated receipt?")) {
          beginPrintTransaction(data.transaction)
        }
      } else {
        const error = await response.json()
        alert(`Error: ${error.error || "Failed to update transaction"}`)
      }
    } catch (error) {
      console.error("Save edit error:", error)
      alert("An error occurred while saving changes")
    } finally {
      setIsSaving(false)
    }
  }

  const resetPrintFlow = () => {
    setShowClientNameBeforePrintDialog(false)
    setClientNameBeforePrint("")
    setPendingPrintTransaction(null)
    setIsSavingClientNameBeforePrint(false)
  }

  const beginPrintTransaction = (transaction: Transaction) => {
    setPendingPrintTransaction(transaction)
    setClientNameBeforePrint(transaction.clientName || "")
    setShowClientNameBeforePrintDialog(true)
  }

  const confirmClientNameBeforePrint = async () => {
    if (!pendingPrintTransaction) {
      resetPrintFlow()
      return
    }

    const desiredClientName = clientNameBeforePrint.trim()

    setIsSavingClientNameBeforePrint(true)
    let updatedTransaction = pendingPrintTransaction

    try {
      const response = await fetch(`/api/admin/transactions/${pendingPrintTransaction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName: desiredClientName }),
      })

      if (response.ok) {
        const data = await response.json()
        if (data?.transaction) {
          updatedTransaction = data.transaction
        }
      }
    } catch (error) {
      console.error("Failed to update client name before printing:", error)
    } finally {
      setIsSavingClientNameBeforePrint(false)
    }

    setPrintTransactionData(updatedTransaction)
    setIsPrintingReceipt(true)
    triggerReliablePrint()

    resetPrintFlow()
  }

  return (
    <div>
      {isPrintingReceipt && printTransactionData && (
        <div className="print-area fixed inset-0 z-[9999] bg-card p-4 overflow-visible">
          <TransactionReceipt transaction={printTransactionData} settings={settings} />
        </div>
      )}

      {showClientNameBeforePrintDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Client Name</CardTitle>
              <p className="text-sm text-muted-foreground">Optional: set a client name before printing</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="clientNameBeforePrint">Client Name</Label>
                <Input
                  id="clientNameBeforePrint"
                  value={clientNameBeforePrint}
                  onChange={(e) => setClientNameBeforePrint(e.target.value)}
                  placeholder="e.g. John Doe"
                />
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={resetPrintFlow}
                  disabled={isSavingClientNameBeforePrint}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onClick={confirmClientNameBeforePrint}
                  disabled={isSavingClientNameBeforePrint}
                >
                  Print
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Transactions</h1>
          <p className="text-muted-foreground mt-1 sm:mt-2 text-sm sm:text-base">View and track all sales transactions</p>
        </div>
        {isAdmin && (
          <Button
            variant="destructive"
            size="sm"
            onClick={handleResetTransactions}
            disabled={isResetting}
          >
            <RotateCcw className={`h-4 w-4 mr-2 ${isResetting ? 'animate-spin' : ''}`} />
            {isResetting ? "Resetting..." : "Reset All Transactions"}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Today's Sales</CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(stats.today)}</div>
            {canViewProfit && (
              <p className="text-xs text-[#22C55E] mt-1">
                Profit: {formatCurrency(stats.todayProfit)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">This Week</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(stats.week)}</div>
            {canViewProfit && (
              <p className="text-xs text-[#22C55E] mt-1">
                Profit: {formatCurrency(stats.weekProfit)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">This Month</CardTitle>
            <Calendar className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{formatCurrency(stats.month)}</div>
            {canViewProfit && (
              <p className="text-xs text-[#22C55E] mt-1">
                Profit: {formatCurrency(stats.monthProfit)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Filters</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowFilters(!showFilters)}
            >
              <Filter className="h-4 w-4 mr-2" />
              {showFilters ? "Hide" : "Show"} Filters
            </Button>
          </div>
        </CardHeader>
        {showFilters && (
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="space-y-2">
                <Label htmlFor="txnSearch">Receipt / client search</Label>
                <Input
                  id="txnSearch"
                  placeholder="e.g. R-20260810-0002 or client name"
                  value={txnSearch}
                  onChange={(e) => setTxnSearch(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Receipt number, client name, or phone</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="cashier">Cashier name</Label>
                <Input
                  id="cashier"
                  placeholder="Type part of the cashier’s name"
                  value={cashierFilter}
                  onChange={(e) => setCashierFilter(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Matches staff who completed the sale</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="payment">Payment method</Label>
                <select
                  id="payment"
                  value={paymentFilter}
                  onChange={(e) => setPaymentFilter(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  title="Filter by Payment Method"
                >
                  <option value="">All methods</option>
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="MOBILE_MONEY">Mobile Money</option>
                  <option value="CREDIT">Credit / on account</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="startDate">From date</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Inclusive start of range</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">To date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Inclusive end of range</p>
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <Button variant="outline" onClick={clearFilters}>
                Clear Filters
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>
              Transactions ({filteredTransactions.length})
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Transaction #</TableHead>
                <TableHead>Date</TableHead>
                <TableHead>Cashier</TableHead>
                <TableHead>Payment Method</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                {canViewProfit && <TableHead className="text-right">Profit</TableHead>}
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTransactions.map((transaction) => (
                <TableRow key={transaction.id} className={transaction.isEdited ? "bg-accent/10" : ""}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {transaction.transactionNo}
                      {transaction.isEdited && (
                        <span className="px-1.5 py-0.5 text-xs rounded bg-amber-100 text-[#E8B84B] font-medium">
                          EDITED
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>{new Date(transaction.createdAt).toLocaleString()}</TableCell>
                  <TableCell>{transaction.user.name}</TableCell>
                  <TableCell>
                    <span className="px-2 py-1 text-xs rounded-full bg-blue-500/15 text-blue-400">
                      {transaction.paymentMethod}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-semibold">
                    {formatCurrency(transaction.netAmount)}
                  </TableCell>
                  {canViewProfit && (
                    <TableCell className="text-right text-[#22C55E] font-semibold">
                      {formatCurrency(calculateProfit(transaction))}
                    </TableCell>
                  )}
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedTransaction(transaction)}
                        title="View Details"
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {transaction.source !== "pos" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => startEditTransaction(transaction)}
                        title="Edit Transaction"
                        className="text-[#E8B84B] hover:text-[#E8B84B] hover:bg-accent/10"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => beginPrintTransaction(transaction)}
                        title="Print Receipt"
                      >
                        <Printer className="h-4 w-4" />
                      </Button>
                      {isAdmin && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setTransactionToDelete(transaction)}
                          title="Delete Transaction"
                          className="text-destructive hover:text-destructive hover:bg-red-50"
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Transaction Details Modal */}
      {selectedTransaction && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Transaction Details</CardTitle>
                <Button variant="ghost" size="sm" onClick={() => setSelectedTransaction(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label className="text-muted-foreground">Transaction #</Label>
                  <p className="font-semibold">{selectedTransaction.transactionNo}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Date & Time</Label>
                  <p className="font-semibold">{new Date(selectedTransaction.createdAt).toLocaleString()}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Cashier</Label>
                  <p className="font-semibold">{selectedTransaction.user.name}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Payment Method</Label>
                  <p className="font-semibold">
                    <span className="px-2 py-1 text-xs rounded-full bg-blue-500/15 text-blue-400">
                      {selectedTransaction.paymentMethod}
                    </span>
                  </p>
                </div>
              </div>

              <div>
                <Label className="text-muted-foreground mb-2 block">Items Sold</Label>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>SKU</TableHead>
                      <TableHead className="text-right">Qty</TableHead>
                      <TableHead className="text-right">Unit Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right">Profit</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(selectedTransaction.items ?? []).map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.product?.name ?? "Unknown"}</TableCell>
                        <TableCell className="text-muted-foreground">{item.product?.sku ?? "—"}</TableCell>
                        <TableCell className="text-right">{item.quantity}</TableCell>
                        <TableCell className="text-right">{formatCurrency(item.unitPrice)}</TableCell>
                        <TableCell className="text-right font-semibold">{formatCurrency(item.totalPrice)}</TableCell>
                        <TableCell className="text-right text-[#22C55E]">
                          {formatCurrency((item.unitPrice - (item.costPrice ?? item.product?.costPrice ?? 0)) * Math.abs(item.quantity ?? 0))}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="bg-muted/20 p-4 rounded-lg">
                <div className="flex justify-between items-center text-lg">
                  <span>Total Amount:</span>
                  <span className="font-bold">{formatCurrency(selectedTransaction.netAmount)}</span>
                </div>
                <div className="flex justify-between items-center text-[#22C55E] mt-2">
                  <span>Total Profit:</span>
                  <span className="font-bold">{formatCurrency(calculateProfit(selectedTransaction))}</span>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button variant="outline" onClick={() => beginPrintTransaction(selectedTransaction)}>
                  <Printer className="h-4 w-4 mr-2" />
                  Print Receipt
                </Button>
                <Button onClick={() => setSelectedTransaction(null)}>
                  Close
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Edit Transaction Modal */}
      {editingTransaction && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader className="bg-accent/10 border-b">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-[#E8B84B]" />
                  <CardTitle className="text-amber-900">Edit Transaction</CardTitle>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setEditingTransaction(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-sm text-[#E8B84B] mt-1">
                Editing {editingTransaction.transactionNo} - CEO and Admin will be notified
              </p>
            </CardHeader>
            <CardContent className="space-y-4 pt-4">
              {/* Warning */}
              <div className="bg-accent/10 border border-accent/20 rounded-lg p-3">
                <p className="text-sm text-[#E8B84B]">
                  <strong>Important:</strong> All edits are logged and CEO/Admin will receive priority notifications.
                  Stock levels will be adjusted based on quantity changes.
                </p>
              </div>

              {/* Edit Items */}
              <div>
                <Label className="text-muted-foreground mb-2 block">Items</Label>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead className="w-24">Qty</TableHead>
                      <TableHead className="w-32">Unit Price</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {editItems.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell>{item.productName}</TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min="1"
                            value={item.quantity}
                            onChange={(e) => handleEditItemChange(item.id, "quantity", parseInt(e.target.value) || 1)}
                            className="w-20"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min="0"
                            step="100"
                            value={item.unitPrice}
                            onChange={(e) => handleEditItemChange(item.id, "unitPrice", parseFloat(e.target.value) || 0)}
                            className="w-28"
                          />
                        </TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatCurrency(item.quantity * item.unitPrice)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {/* Payment Method */}
              <div className="space-y-2">
                <Label htmlFor="editPaymentMethod">Payment Method</Label>
                <select
                  id="editPaymentMethod"
                  value={editPaymentMethod}
                  onChange={(e) => setEditPaymentMethod(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="CASH">Cash</option>
                  <option value="CARD">Card</option>
                  <option value="MOBILE_MONEY">Mobile Money</option>
                  <option value="BANK_TRANSFER">Bank Transfer</option>
                </select>
              </div>

              {/* New Total */}
              <div className="bg-muted/30 p-4 rounded-lg">
                <div className="flex justify-between items-center text-lg">
                  <span>New Total:</span>
                  <span className="font-bold">
                    {formatCurrency(editItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0))}
                  </span>
                </div>
              </div>

              {/* Reason - REQUIRED */}
              <div className="space-y-2">
                <Label htmlFor="editReason" className="text-destructive font-semibold">
                  Reason for Edit * (Required - minimum 10 characters)
                </Label>
                <textarea
                  id="editReason"
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  placeholder="Please explain why you are editing this transaction..."
                  className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {editReason.length}/10 characters minimum
                </p>
              </div>

              {/* Actions */}
              <div className="flex justify-end gap-2 pt-4 border-t">
                <Button
                  variant="outline"
                  onClick={() => setEditingTransaction(null)}
                  disabled={isSaving}
                >
                  Cancel
                </Button>
                <Button
                  onClick={saveEditedTransaction}
                  disabled={isSaving || editReason.trim().length < 10}
                  className="bg-amber-600 hover:bg-amber-700"
                >
                  {isSaving ? "Saving..." : "Save Changes & Notify CEO/Admin"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Delete Transaction Confirmation Modal */}
      {transactionToDelete && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-destructive" />
                  <CardTitle className="text-destructive">Delete Transaction</CardTitle>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTransactionToDelete(null)}
                  disabled={isDeleting}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                <p className="text-sm text-red-800 font-semibold mb-2">
                  Are you sure you want to delete this transaction?
                </p>
                <div className="space-y-2 text-sm text-destructive">
                  <p>
                    <strong>Transaction:</strong> {transactionToDelete.transactionNo}
                  </p>
                  <p>
                    <strong>Amount:</strong> {formatCurrency(transactionToDelete.netAmount)}
                  </p>
                  <p>
                    <strong>Date:</strong> {new Date(transactionToDelete.createdAt).toLocaleString()}
                  </p>
                  <p>
                    <strong>Cashier:</strong> {transactionToDelete.user.name}
                  </p>
                  <p>
                    <strong>Items:</strong> {transactionToDelete.items.length}
                  </p>
                </div>
              </div>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-blue-800">
                  <strong>Note:</strong> When deleted, stock levels will be automatically restored and all admins will be notified.
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setTransactionToDelete(null)}
                  disabled={isDeleting}
                >
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={handleDeleteTransaction}
                  disabled={isDeleting}
                >
                  {isDeleting ? "Deleting..." : "Delete Transaction"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}

function TransactionReceipt({
  transaction,
  settings,
}: {
  transaction: Transaction
  settings: PharmacySettings | null
}) {
  const currency = settings?.currency || "UGX"
  const pharmacyName = settings?.pharmacyName || "SYNAPSE Pharm"
  const location = settings?.location || ""
  const contact = settings?.contact || ""
  const email = settings?.email || ""
  const footerText = settings?.footerText || "Thank you for your purchase!"

  const receiptDate = transaction?.createdAt ? new Date(transaction.createdAt) : new Date()
  const subtotal = typeof transaction.totalAmount === "number" ? transaction.totalAmount : 0
  const taxAmount = typeof transaction.tax === "number" ? transaction.tax : 0
  const discount = typeof transaction.discount === "number" ? transaction.discount : 0
  const grandTotal = typeof transaction.netAmount === "number" ? transaction.netAmount : subtotal + taxAmount
  // Same paper and scale the POS print uses, so a reprint from Transactions
  // comes out at the till's width instead of a full-width sheet.
  const paperWidth =
    settings?.receiptPaperWidth === "58" || settings?.receiptPaperWidth === "a4"
      ? settings.receiptPaperWidth
      : "80"
  const fontScale = Number(settings?.receiptFontScale ?? 1) || 1

  return (
    <div
      className={`thermal-receipt paper-${paperWidth}`}
      style={{ ["--receipt-font-scale" as string]: String(fontScale) }}
    >
      {transaction.isEdited && (
        <p className="tr-center tr-bold tr-sm">*** EDITED RECEIPT ***</p>
      )}

      {settings?.logo && (
        <div className="tr-center" style={{ padding: "1mm 0" }}>
          <img
            src={settings.logo}
            alt="Logo"
            style={{
              maxWidth: paperWidth === "58" ? "90px" : paperWidth === "a4" ? "160px" : "110px",
              maxHeight: "30px",
              objectFit: "contain",
              margin: "0 auto",
              display: "block",
            }}
          />
        </div>
      )}
      <p className="tr-center tr-bold tr-lg">{pharmacyName}</p>
      {location && <p className="tr-center tr-sm">{location}</p>}
      {(contact || email) && (
        <p className="tr-center tr-sm">
          {contact ? `Tel: ${contact}` : ""}
          {contact && email ? " | " : ""}
          {email || ""}
        </p>
      )}

      <div className="tr-heavy" />
      <p className="tr-center tr-bold">SALES RECEIPT</p>
      <div className="tr-dash" />

      {/* One pair per line: a 15-character receipt number plus a time cannot
          share a 52mm line without wrapping mid-value. */}
      <div className="tr-row tr-kv tr-sm"><span>Bill No</span><span>{transaction.transactionNo}</span></div>
      <div className="tr-row tr-kv tr-sm">
        <span>Date</span>
        <span>
          {receiptDate.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" })}
          {" "}
          {receiptDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
        </span>
      </div>
      <div className="tr-row tr-kv tr-sm"><span>User</span><span>{transaction.user.name}</span></div>

      {transaction.clientName && (
        <>
          <div className="tr-dash" />
          <div className="tr-row tr-kv tr-sm"><span>Client</span><span>{transaction.clientName}</span></div>
          {transaction.clientPhone && (
            <div className="tr-row tr-kv tr-sm"><span>Phone</span><span>{transaction.clientPhone}</span></div>
          )}
        </>
      )}

      <div className="tr-dash" />
      <div className="tr-row tr-bold tr-sm"><span>ITEM</span><span>AMOUNT</span></div>
      <div className="tr-dash" />

      {(transaction.items ?? []).map((item) => (
        <div key={item.id} className="tr-item print-no-break">
          <p className="tr-bold">{item.product?.name ?? "Unknown"}</p>
          <div className="tr-row">
            <span className="tr-sm tr-muted">
              {item.quantity} x {formatCurrency(item.unitPrice, currency)}
            </span>
            <span className="tr-bold">{formatCurrency(item.totalPrice, currency)}</span>
          </div>
          {(item.product?.batchNumber || item.product?.expiryDate) && (
            <p className="tr-sm tr-muted">
              {item.product?.batchNumber ? `Batch: ${item.product.batchNumber}` : ""}
              {item.product?.batchNumber && item.product?.expiryDate ? "  " : ""}
              {item.product?.expiryDate
                ? `Exp: ${new Date(item.product.expiryDate).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}`
                : ""}
            </p>
          )}
        </div>
      ))}

      <div className="tr-heavy" />
      {discount > 0 && (
        <div className="tr-row"><span>Subtotal</span><span>{formatCurrency(subtotal, currency)}</span></div>
      )}
      {discount > 0 && (
        <div className="tr-row"><span>Discount</span><span>-{formatCurrency(discount, currency)}</span></div>
      )}
      {taxAmount > 0 && (
        <div className="tr-row"><span>Tax</span><span>{formatCurrency(taxAmount, currency)}</span></div>
      )}
      <div className="tr-row tr-bold tr-lg"><span>TOTAL</span><span>{formatCurrency(grandTotal, currency)}</span></div>
      <div className="tr-heavy" />

      <div className="tr-row">
        <span>Payment</span>
        <span>{transaction.paymentMethod === "MOBILE_MONEY" ? "Mobile Money" : transaction.paymentMethod}</span>
      </div>

      <div className="tr-dash" />
      <p className="tr-center tr-sm">Served by: {transaction.user.name}</p>
      <p className="tr-center tr-sm">{footerText}</p>
      <p className="tr-center tr-sm">Thank You!</p>
      <p className="tr-center tr-sm tr-mono">{transaction.transactionNo}</p>
    </div>
  )
}

