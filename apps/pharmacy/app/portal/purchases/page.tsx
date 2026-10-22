"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { Loader2, Plus, Search, Eye, X } from "lucide-react"
import { formatCurrency } from "@/lib/utils"
import { purchaseMargin, purchaseTotals } from "@synapse/db/pharmacy-purchases"

export const dynamic = "force-dynamic"

type Supplier = { id: string; name: string; email: string | null; phone: string | null }
type Match = {
  id: string
  name: string
  sku?: string | null
  barcode?: string | null
  genericName?: string | null
  strength?: string | null
  dosageForm?: string | null
  price?: number | null
  costPrice?: number | null
  quantity?: number | null
  score: number
}
type Line = {
  clientItemId: string
  productId: string
  productName: string
  quantity: string
  unitCost: string
  batchNumber: string
  expiryDate: string
  sellingPrice: string
  updateSellingPrice: boolean
}
type Purchase = {
  id: string
  purchaseNo: string
  status: string
  paymentStatus: string
  supplierInvoiceNo: string | null
  total: number
  amountPaid: number
  balance: number
  paymentMethod: string | null
  purchaseDate: string | null
  receivedByName: string | null
  createdByName: string
  supplier: { id: string; name: string }
  items: Array<{
    productName: string
    quantity: number
    unitCost: number
    lineTotal: number
    batchNumber: string | null
    expiryDate: string | null
  }>
}

const SECTIONS = [
  { id: "new", label: "New Purchase" },
  { id: "history", label: "Purchase History" },
  { id: "orders", label: "Purchase Orders", href: "/portal/purchase-orders" },
  { id: "receive", label: "Receive Stock", href: "/portal/purchase-orders" },
  { id: "suppliers", label: "Suppliers", href: "/portal/suppliers" },
] as const

export default function PurchasesPage() {
  const { user } = usePharmacySession()
  const { toast } = useToast()
  const [section, setSection] = useState<"new" | "history">("new")
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [query, setQuery] = useState("")
  const [matches, setMatches] = useState<Match[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Purchase | null>(null)
  const [supplierPaymentTotal, setSupplierPaymentTotal] = useState("")
  const [supplierPaymentMethod, setSupplierPaymentMethod] = useState("cash")
  const [savingSupplierPayment, setSavingSupplierPayment] = useState(false)
  const [createProduct, setCreateProduct] = useState(false)
  const [dupes, setDupes] = useState<Match[]>([])
  const [supplierId, setSupplierId] = useState("")
  const [invoice, setInvoice] = useState("")
  const [receiptRef, setReceiptRef] = useState("")
  const [purchaseDate, setPurchaseDate] = useState(new Date().toISOString().slice(0, 10))
  const [paymentStatus, setPaymentStatus] = useState("UNPAID")
  const [paymentMethod, setPaymentMethod] = useState("")
  const [amountPaid, setAmountPaid] = useState("0")
  const [tax, setTax] = useState("0")
  const [discount, setDiscount] = useState("0")
  const [otherCost, setOtherCost] = useState("0")
  const [notes, setNotes] = useState("")
  const [lines, setLines] = useState<Line[]>([])
  const [newSupplier, setNewSupplier] = useState({ name: "", phone: "", email: "", contactPerson: "", taxNumber: "" })
  const [newProduct, setNewProduct] = useState({
    name: "",
    genericName: "",
    brand: "",
    strength: "",
    dosageForm: "Tablet",
    unit: "Tablet",
    barcode: "",
    sku: "",
    manufacturer: "",
    category: "General",
    costPrice: "",
    sellingPrice: "",
    reorderLevel: "10",
  })
  const [draftQty, setDraftQty] = useState("1")
  const [draftCost, setDraftCost] = useState("")
  const [draftBatch, setDraftBatch] = useState("")
  const [draftExpiry, setDraftExpiry] = useState("")
  const [draftSell, setDraftSell] = useState("")
  const [picked, setPicked] = useState<Match | null>(null)
  const [filter, setFilter] = useState({ supplierId: "", status: "", paymentStatus: "", q: "" })

  const totals = useMemo(
    () =>
      purchaseTotals({
        lines: lines.map((line) => ({ quantity: Number(line.quantity) || 0, unitCost: Number(line.unitCost) || 0 })),
        tax: Number(tax) || 0,
        discount: Number(discount) || 0,
        otherCost: Number(otherCost) || 0,
      }),
    [lines, tax, discount, otherCost],
  )

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      fetch("/api/admin/suppliers").then((r) => r.json()),
      fetch("/api/admin/purchases").then((r) => r.json()),
    ])
      .then(([supplierData, purchaseData]) => {
        if (cancelled) return
        const nextSuppliers = Array.isArray(supplierData) ? supplierData : []
        setSuppliers(nextSuppliers)
        setPurchases(Array.isArray(purchaseData?.purchases) ? purchaseData.purchases : [])
        setSupplierId((current) => current || nextSuppliers[0]?.id || "")
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => {
      if (query.trim().length >= 2) {
        void searchProducts(query)
      } else {
        setMatches([])
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [query])

  const searchProducts = async (q: string) => {
    setQuery(q)
    if (q.trim().length < 2) {
      setMatches([])
      return
    }
    setSearching(true)
    try {
      const res = await fetch(`/api/admin/purchases/products?q=${encodeURIComponent(q.trim())}`)
      const data = await res.json()
      setMatches(data.matches ?? [])
    } catch {
      setMatches([])
    } finally {
      setSearching(false)
    }
  }

  useEffect(() => {
    if (query.trim().length < 2) {
      setMatches([])
      return
    }
    const handle = window.setTimeout(() => {
      void searchProducts(query)
    }, 280)
    return () => window.clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- debounce only on query text
  }, [query])

  const addPickedLine = () => {
    if (!picked) return
    const qty = Number(draftQty)
    const cost = Number(draftCost)
    const sell = Number(draftSell)
    if (!draftBatch.trim() || !(qty > 0) || !draftExpiry.trim() || !draftCost.trim() || !(cost >= 0)) {
      toast({ variant: "destructive", title: "Batch, quantity, expiry and cost price are required" })
      return
    }
    if (!draftSell.trim() || !(sell >= 0)) {
      toast({ variant: "destructive", title: "Selling price is required" })
      return
    }
    setLines((prev) => [
      ...prev,
      {
        clientItemId: crypto.randomUUID(),
        productId: picked.id,
        productName: picked.name,
        quantity: draftQty,
        unitCost: draftCost,
        batchNumber: draftBatch.trim(),
        expiryDate: draftExpiry,
        sellingPrice: draftSell,
        updateSellingPrice: true,
      },
    ])
    setPicked(null)
    setQuery("")
    setMatches([])
    setDraftQty("1")
    setDraftCost("")
    setDraftBatch("")
    setDraftExpiry("")
    setDraftSell("")
  }

  const createSupplier = async () => {
    if (!newSupplier.name.trim()) {
      toast({ variant: "destructive", title: "Supplier name is required" })
      return
    }
    const res = await fetch("/api/admin/suppliers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newSupplier),
    })
    const data = await res.json()
    if (!res.ok) {
      toast({ variant: "destructive", title: data.error || "Could not create supplier" })
      return
    }
    const created = data.supplier as Supplier
    setSuppliers((prev) => [created, ...prev])
    setSupplierId(created.id)
    toast({ title: "Supplier created" })
  }

  const submitNewProduct = async (createAnyway = false) => {
    const cost = Number(newProduct.costPrice)
    const sell = Number(newProduct.sellingPrice)
    if (!newProduct.name.trim()) {
      toast({ variant: "destructive", title: "Product name is required" })
      return
    }
    if (!newProduct.costPrice.trim() || !(cost >= 0) || !newProduct.sellingPrice.trim() || !(sell >= 0)) {
      toast({ variant: "destructive", title: "Cost price and selling price are required" })
      return
    }
    const res = await fetch("/api/admin/purchases/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...newProduct,
        price: sell,
        sellingPrice: sell,
        costPrice: cost,
        createAnyway,
      }),
    })
    const data = await res.json()
    if (res.status === 409) {
      setDupes(data.candidates ?? [])
      toast({ variant: "destructive", title: "A similar product already exists." })
      return
    }
    if (!res.ok) {
      toast({ variant: "destructive", title: data.error || "Could not create product" })
      return
    }
    setPicked({
      id: data.product.id,
      name: data.product.name,
      sku: data.product.sku,
      barcode: data.product.barcode,
      price: data.product.price,
      costPrice: data.product.costPrice,
      quantity: 0,
      score: 100,
    })
    setDraftCost(String(cost))
    setDraftSell(String(sell))
    if (data.product.barcode) setQuery(data.product.barcode)
    setCreateProduct(false)
    setDupes([])
    toast({ title: "Product created — continue this purchase line" })
  }

  const receivePurchase = async () => {
    if (!supplierId || lines.length === 0) {
      toast({ variant: "destructive", title: "Select a supplier and add at least one item" })
      return
    }
    setSaving(true)
    try {
      const idempotencyKey = crypto.randomUUID()
      const res = await fetch("/api/admin/purchases", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({
          supplierId,
          supplierInvoiceNo: invoice || null,
          supplierReceiptRef: receiptRef || null,
          purchaseDate,
          paymentStatus,
          paymentMethod: paymentMethod || null,
          amountPaid: Number(amountPaid) || 0,
          tax: Number(tax) || 0,
          discount: Number(discount) || 0,
          otherCost: Number(otherCost) || 0,
          notes: notes || null,
          receiveNow: true,
          idempotencyKey,
          lines: lines.map((line) => ({
            ...line,
            quantity: Number(line.quantity),
            unitCost: Number(line.unitCost),
            sellingPrice: line.sellingPrice ? Number(line.sellingPrice) : null,
            updateSellingPrice: line.updateSellingPrice !== false,
          })),
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        toast({ variant: "destructive", title: data.error || "Receive failed" })
        return
      }
      toast({ title: data.replay ? "Already received" : `Received ${data.purchase?.purchaseNo ?? "purchase"}` })
      setLines([])
      setInvoice("")
      setReceiptRef("")
      setNotes("")
      const refreshed = await fetch("/api/admin/purchases").then((r) => r.json())
      setPurchases(Array.isArray(refreshed.purchases) ? refreshed.purchases : [])
      setSection("history")
    } finally {
      setSaving(false)
    }
  }

  const recordSupplierPayment = async () => {
    if (!selected) return
    const newTotalPaid = Number(supplierPaymentTotal)
    if (!Number.isFinite(newTotalPaid) || newTotalPaid <= selected.amountPaid || newTotalPaid > selected.total) {
      toast({ variant: "destructive", title: `Enter a new paid total above ${selected.amountPaid} and no more than ${selected.total}` })
      return
    }
    setSavingSupplierPayment(true)
    try {
      const response = await fetch(`/api/admin/purchases/${selected.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountPaid: newTotalPaid, paymentMethod: supplierPaymentMethod }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not record supplier payment.")
      toast({ title: `Supplier payment recorded. Remaining balance: ${formatCurrency(data.balance)}` })
      const refreshed = await fetch("/api/admin/purchases").then((r) => r.json())
      const nextPurchases = Array.isArray(refreshed.purchases) ? refreshed.purchases : []
      setPurchases(nextPurchases)
      setSelected(nextPurchases.find((purchase: Purchase) => purchase.id === selected.id) ?? null)
      setSupplierPaymentTotal("")
    } catch (error) {
      toast({ variant: "destructive", title: error instanceof Error ? error.message : "Could not record supplier payment." })
    } finally {
      setSavingSupplierPayment(false)
    }
  }

  const filtered = purchases.filter((p) => {
    if (filter.supplierId && p.supplier.id !== filter.supplierId) return false
    if (filter.status && p.status !== filter.status) return false
    if (filter.paymentStatus && p.paymentStatus !== filter.paymentStatus) return false
    if (filter.q) {
      const hay = `${p.purchaseNo} ${p.supplier.name} ${p.supplierInvoiceNo ?? ""}`.toLowerCase()
      if (!hay.includes(filter.q.toLowerCase())) return false
    }
    return true
  })

  const margin = picked
    ? purchaseMargin(Number(draftCost) || Number(picked.costPrice) || 0, Number(draftSell) || Number(picked.price) || 0)
    : null

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Purchases</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Record a supplier purchase even without a purchase order. Stock still enters through genuine batches.
          </p>
        </div>
        <Button onClick={() => setSection("new")}>
          <Plus className="h-4 w-4 mr-2" />
          New Purchase
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {SECTIONS.map((item) =>
          "href" in item && item.href ? (
            <Button key={item.id} variant="outline" size="sm" asChild>
              <Link href={item.href}>{item.label}</Link>
            </Button>
          ) : (
            <Button
              key={item.id}
              size="sm"
              variant={section === item.id ? "default" : "outline"}
              onClick={() => setSection(item.id as "new" | "history")}
            >
              {item.label}
            </Button>
          ),
        )}
      </div>

      {section === "new" && (
        <div className="grid lg:grid-cols-3 gap-6">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Receive purchase</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <Label>Supplier</Label>
                  <select
                    className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                    value={supplierId}
                    onChange={(e) => setSupplierId(e.target.value)}
                  >
                    <option value="">Select supplier</option>
                    {suppliers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label htmlFor="new-supplier-name">New supplier name</Label>
                    <Input
                      id="new-supplier-name"
                      placeholder="e.g. Cipla Uganda"
                      value={newSupplier.name}
                      onChange={(e) => setNewSupplier({ ...newSupplier, name: e.target.value })}
                    />
                  </div>
                  <div className="flex items-end">
                    <Button type="button" variant="outline" className="w-full" onClick={() => void createSupplier()}>
                      + Create Supplier
                    </Button>
                  </div>
                </div>
                <div>
                  <Label>Supplier invoice</Label>
                  <Input value={invoice} onChange={(e) => setInvoice(e.target.value)} />
                </div>
                <div>
                  <Label>Receipt / reference</Label>
                  <Input value={receiptRef} onChange={(e) => setReceiptRef(e.target.value)} />
                </div>
                <div>
                  <Label>Purchase date</Label>
                  <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
                </div>
                <div>
                  <Label>Payment status</Label>
                  <select
                    className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                    value={paymentStatus}
                    onChange={(e) => setPaymentStatus(e.target.value)}
                  >
                    <option value="UNPAID">UNPAID</option>
                    <option value="PARTIAL">PARTIAL</option>
                    <option value="PAID">PAID</option>
                    <option value="CREDIT">CREDIT</option>
                  </select>
                </div>
              </div>

              <div className="rounded-lg border p-3 space-y-3">
                <Label>Add item — scan barcode or search catalog</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Barcode, SKU, generic, brand, strength…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && query.trim().length >= 2) void searchProducts(query)
                    }}
                  />
                  <Button type="button" variant="outline" onClick={() => void searchProducts(query)}>
                    <Search className="h-4 w-4" />
                  </Button>
                </div>
                {searching && <p className="text-xs text-muted-foreground">Searching…</p>}
                {matches.length > 0 && (
                  <div className="space-y-2">
                    {matches.map((m) => (
                      <div key={m.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                        <div>
                          <p className="text-sm font-medium">{m.name}</p>
                          <p className="text-xs text-muted-foreground">
                            Stock {m.quantity ?? 0} · Cost {m.costPrice != null ? formatCurrency(m.costPrice) : "—"} · Sell{" "}
                            {m.price != null ? formatCurrency(m.price) : "—"}
                            {m.sku || m.barcode ? ` · ${m.sku || m.barcode}` : ""}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setPicked(m)
                            setDraftCost(m.costPrice != null ? String(m.costPrice) : "")
                            setDraftSell(m.price != null ? String(m.price) : "")
                          }}
                        >
                          Use Existing Product
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
                {query.trim().length >= 2 && matches.length === 0 && !searching && (
                  <Button type="button" variant="secondary" onClick={() => { setCreateProduct(true); setNewProduct((p) => ({ ...p, name: query, barcode: /^\d{8,}$/.test(query) ? query : p.barcode })) }}>
                    + Create New Product
                  </Button>
                )}

                {picked && (
                  <div className="grid sm:grid-cols-2 gap-2 rounded-md bg-muted/40 p-3">
                    <div className="sm:col-span-2 space-y-1">
                      <p className="text-sm font-medium">{picked.name}</p>
                      <p className="text-xs text-muted-foreground">
                        Existing stock: <strong>{picked.quantity ?? 0}</strong>
                        {" · "}
                        Current cost:{" "}
                        <strong>{picked.costPrice != null ? formatCurrency(picked.costPrice) : "—"}</strong>
                        {" · "}
                        Current sell:{" "}
                        <strong>{picked.price != null ? formatCurrency(picked.price) : "—"}</strong>
                      </p>
                    </div>
                    <div>
                      <Label htmlFor="draft-qty">Quantity (basic units)</Label>
                      <Input id="draft-qty" type="number" min="1" placeholder="e.g. 100" value={draftQty} onChange={(e) => setDraftQty(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="draft-cost">Cost price (bought at) *</Label>
                      <Input id="draft-cost" type="number" min="0" step="0.01" placeholder="Cost per unit" value={draftCost} onChange={(e) => setDraftCost(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="draft-batch">Batch number</Label>
                      <Input id="draft-batch" placeholder="Supplier batch / LOT" value={draftBatch} onChange={(e) => setDraftBatch(e.target.value)} />
                    </div>
                    <div>
                      <Label htmlFor="draft-expiry">Expiry date</Label>
                      <Input id="draft-expiry" type="date" value={draftExpiry} onChange={(e) => setDraftExpiry(e.target.value)} />
                    </div>
                    <div className="sm:col-span-2">
                      <Label htmlFor="draft-sell">Selling price *</Label>
                      <Input id="draft-sell" type="number" min="0" step="0.01" placeholder="Retail price per unit" value={draftSell} onChange={(e) => setDraftSell(e.target.value)} />
                    </div>
                    {margin && margin.selling > 0 && (
                      <p className="text-xs text-muted-foreground sm:col-span-2">
                        After receive: cost {formatCurrency(margin.cost)} · sell {formatCurrency(margin.selling)} ·
                        Margin {margin.marginPct ?? 0}% · Markup {margin.markupPct ?? 0}%
                      </p>
                    )}
                    <Button type="button" onClick={addPickedLine} className="sm:col-span-2">
                      Add line
                    </Button>
                  </div>
                )}
              </div>

              {lines.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Product</TableHead>
                      <TableHead>Qty</TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead>Expiry</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lines.map((line) => (
                      <TableRow key={line.clientItemId}>
                        <TableCell>{line.productName}</TableCell>
                        <TableCell>{line.quantity}</TableCell>
                        <TableCell className="font-mono text-xs">{line.batchNumber}</TableCell>
                        <TableCell>{line.expiryDate}</TableCell>
                        <TableCell>{formatCurrency(Number(line.unitCost) * Number(line.quantity))}</TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" onClick={() => setLines((prev) => prev.filter((l) => l.clientItemId !== line.clientItemId))}>
                            <X className="h-4 w-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Review</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between"><span>Subtotal</span><span>{formatCurrency(totals.subtotal)}</span></div>
                <div>
                  <Label htmlFor="purchase-tax">Tax</Label>
                  <Input id="purchase-tax" type="number" min="0" step="0.01" value={tax} onChange={(e) => setTax(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="purchase-discount">Discount</Label>
                  <Input id="purchase-discount" type="number" min="0" step="0.01" value={discount} onChange={(e) => setDiscount(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="purchase-other">Other cost</Label>
                  <Input id="purchase-other" type="number" min="0" step="0.01" value={otherCost} onChange={(e) => setOtherCost(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="purchase-paid">Amount paid</Label>
                  <Input id="purchase-paid" type="number" min="0" step="0.01" value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="purchase-pay-method">Payment method</Label>
                  <select
                    id="purchase-pay-method"
                    className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                  >
                    <option value="">Select method</option>
                    <option value="cash">Cash</option>
                    <option value="mobile_money">Mobile money</option>
                    <option value="card">Card</option>
                    <option value="bank_transfer">Bank transfer</option>
                  </select>
                </div>
                <div>
                  <Label htmlFor="purchase-notes">Notes</Label>
                  <Input id="purchase-notes" placeholder="Optional note for this receipt" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                <div className="flex justify-between font-semibold pt-2">
                  <span>Grand total</span>
                  <span>{formatCurrency(totals.grandTotal)}</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Receiving adds today&apos;s inbound stock through genuine batches. Cost and selling prices on each line update the product catalog.
                </p>
                <Button className="w-full" disabled={saving || loading} onClick={() => void receivePurchase()}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Receive Purchase & Update Stock"}
                </Button>
              </CardContent>
            </Card>
            <p className="text-xs text-muted-foreground">Signed in as {user?.fullName ?? user?.email}</p>
          </div>
        </div>
      )}

      {section === "history" && (
        <Card>
          <CardHeader>
            <CardTitle>Purchase history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-4 gap-2">
              <div>
                <Label htmlFor="hist-q">Search</Label>
                <Input id="hist-q" placeholder="Purchase no. / supplier / invoice" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="hist-supplier">Supplier</Label>
                <select id="hist-supplier" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={filter.supplierId} onChange={(e) => setFilter({ ...filter, supplierId: e.target.value })}>
                  <option value="">All suppliers</option>
                  {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <Label htmlFor="hist-status">Status</Label>
                <select id="hist-status" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
                  <option value="">All statuses</option>
                  <option value="DRAFT">DRAFT</option>
                  <option value="RECEIVED">RECEIVED</option>
                  <option value="PARTIALLY_RECEIVED">PARTIALLY_RECEIVED</option>
                  <option value="CANCELLED">CANCELLED</option>
                </select>
              </div>
              <div>
                <Label htmlFor="hist-pay">Payment</Label>
                <select id="hist-pay" className="h-10 w-full rounded-md border bg-background px-3 text-sm" value={filter.paymentStatus} onChange={(e) => setFilter({ ...filter, paymentStatus: e.target.value })}>
                  <option value="">All payments</option>
                  <option value="UNPAID">UNPAID</option>
                  <option value="PARTIAL">PARTIAL</option>
                  <option value="PAID">PAID</option>
                  <option value="CREDIT">CREDIT</option>
                </select>
              </div>
            </div>
            {loading ? (
              <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Purchase No.</TableHead>
                    <TableHead>Supplier</TableHead>
                    <TableHead>Invoice</TableHead>
                    <TableHead>Items</TableHead>
                    <TableHead>Total</TableHead>
                    <TableHead>Payment</TableHead>
                    <TableHead>Received by</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>{p.purchaseDate ?? "—"}</TableCell>
                      <TableCell className="font-mono text-xs">{p.purchaseNo}</TableCell>
                      <TableCell>{p.supplier.name}</TableCell>
                      <TableCell>{p.supplierInvoiceNo ?? "—"}</TableCell>
                      <TableCell>{p.items.length}</TableCell>
                      <TableCell>{formatCurrency(p.total)}</TableCell>
                      <TableCell>{p.paymentStatus}</TableCell>
                      <TableCell>{p.receivedByName ?? "—"}</TableCell>
                      <TableCell>{p.status}</TableCell>
                      <TableCell>
                        <Button size="sm" variant="outline" onClick={() => {
                          setSelected(p)
                          setSupplierPaymentTotal("")
                          setSupplierPaymentMethod(p.paymentMethod ?? "cash")
                        }}>
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {createProduct && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <Card className="w-full max-w-lg">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>Create new product</CardTitle>
              <Button variant="ghost" size="icon" onClick={() => setCreateProduct(false)}><X className="h-4 w-4" /></Button>
            </CardHeader>
            <CardContent className="grid sm:grid-cols-2 gap-2">
              <Input placeholder="Name" value={newProduct.name} onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })} />
              <Input placeholder="Generic name" value={newProduct.genericName} onChange={(e) => setNewProduct({ ...newProduct, genericName: e.target.value })} />
              <Input placeholder="Brand" value={newProduct.brand} onChange={(e) => setNewProduct({ ...newProduct, brand: e.target.value })} />
              <Input placeholder="Strength" value={newProduct.strength} onChange={(e) => setNewProduct({ ...newProduct, strength: e.target.value })} />
              <Input placeholder="Dosage form" value={newProduct.dosageForm} onChange={(e) => setNewProduct({ ...newProduct, dosageForm: e.target.value })} />
              <Input placeholder="Unit" value={newProduct.unit} onChange={(e) => setNewProduct({ ...newProduct, unit: e.target.value })} />
              <Input placeholder="Barcode / SKU" value={newProduct.barcode} onChange={(e) => setNewProduct({ ...newProduct, barcode: e.target.value })} />
              <Input placeholder="Manufacturer" value={newProduct.manufacturer} onChange={(e) => setNewProduct({ ...newProduct, manufacturer: e.target.value })} />
              <Input placeholder="Category" value={newProduct.category} onChange={(e) => setNewProduct({ ...newProduct, category: e.target.value })} />
              <Input placeholder="Cost price (bought at) *" type="number" min="0" step="0.01" value={newProduct.costPrice} onChange={(e) => setNewProduct({ ...newProduct, costPrice: e.target.value })} />
              <Input placeholder="Selling price *" type="number" min="0" step="0.01" value={newProduct.sellingPrice} onChange={(e) => setNewProduct({ ...newProduct, sellingPrice: e.target.value })} />
              {dupes.length > 0 && (
                <div className="sm:col-span-2 rounded-md border border-amber-500/40 p-2 text-sm">
                  <p className="font-medium">A similar product already exists.</p>
                  {dupes.map((d) => (
                    <button key={d.id} className="block text-left w-full py-1" onClick={() => { setPicked(d); setCreateProduct(false); setDupes([]) }}>
                      Use existing: {d.name}
                    </button>
                  ))}
                  <div className="flex gap-2 mt-2">
                    <Button variant="outline" onClick={() => void submitNewProduct(true)}>Create anyway</Button>
                    <Button variant="ghost" onClick={() => { setCreateProduct(false); setDupes([]) }}>Cancel</Button>
                  </div>
                </div>
              )}
              <div className="sm:col-span-2 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCreateProduct(false)}>Cancel</Button>
                <Button onClick={() => void submitNewProduct(false)}>Create product</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {selected && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <CardHeader className="flex flex-row items-center justify-between">
              <CardTitle>{selected.purchaseNo}</CardTitle>
              <Button variant="ghost" size="icon" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>Supplier: {selected.supplier.name}</p>
              <p>Invoice: {selected.supplierInvoiceNo ?? "—"}</p>
              <p>Dates: {selected.purchaseDate ?? "—"}</p>
              <p>Payment: {selected.paymentStatus} · Status: {selected.status}</p>
              <p>Paid: {formatCurrency(selected.amountPaid)} · Balance: {formatCurrency(selected.balance)}</p>
              <p>Created by {selected.createdByName} · Received by {selected.receivedByName ?? "—"}</p>
              {selected.status === "RECEIVED" && selected.balance > 0 && (
                <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-3">
                  <div className="space-y-1">
                    <Label htmlFor="supplier-payment-total">New total paid</Label>
                    <Input
                      id="supplier-payment-total"
                      type="number"
                      min={selected.amountPaid + 0.01}
                      max={selected.total}
                      step="0.01"
                      value={supplierPaymentTotal}
                      onChange={(event) => setSupplierPaymentTotal(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="supplier-payment-method">Payment method</Label>
                    <select
                      id="supplier-payment-method"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                      value={supplierPaymentMethod}
                      onChange={(event) => setSupplierPaymentMethod(event.target.value)}
                    >
                      <option value="cash">Cash</option>
                      <option value="mobile_money">Mobile money</option>
                      <option value="card">Card</option>
                      <option value="bank_transfer">Bank transfer</option>
                    </select>
                  </div>
                  <Button type="button" className="self-end" disabled={savingSupplierPayment} onClick={() => void recordSupplierPayment()}>
                    {savingSupplierPayment ? <Loader2 className="h-4 w-4 animate-spin" /> : "Record payment"}
                  </Button>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Qty</TableHead>
                    <TableHead>Batch</TableHead>
                    <TableHead>Expiry</TableHead>
                    <TableHead>Unit cost</TableHead>
                    <TableHead>Line</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.items.map((item, i) => (
                    <TableRow key={i}>
                      <TableCell>{item.productName}</TableCell>
                      <TableCell>{item.quantity}</TableCell>
                      <TableCell className="font-mono text-xs">{item.batchNumber}</TableCell>
                      <TableCell>{item.expiryDate}</TableCell>
                      <TableCell>{formatCurrency(item.unitCost)}</TableCell>
                      <TableCell>{formatCurrency(item.lineTotal)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="flex justify-between font-semibold">
                <span>Total</span>
                <span>{formatCurrency(selected.total)}</span>
              </div>
              <Button variant="outline" onClick={() => window.print()}>Print / Export</Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
