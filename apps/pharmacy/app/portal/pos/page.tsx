"use client"

import { useEffect, useState, useMemo, useCallback, useRef } from "react"
import { useRouter } from "next/navigation"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"

// Force dynamic rendering
export const dynamic = 'force-dynamic'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { formatCurrency, generateTransactionNo } from "@/lib/utils"
import { Search, ShoppingCart, Trash2, Printer, Clock, Eye, Calculator, Package, Wifi, WifiOff, Download } from "lucide-react"
import { getPendingActions, saveMetadata, getMetadata } from "@/lib/offlineStorage"
import { LiveRegion } from "@synapse/ui"
import { TillBanner } from "@/components/till-banner"
import {
  resolvePosEnterAction,
  usePosKeyboardShortcuts,
  POS_SHORTCUT_CHEATSHEET,
} from "@/lib/pos/keyboard"
import { settlePayment } from "@/lib/pos/partial-payment"
import {
  allocateFefoBatches,
  DISCOUNT_REASONS,
  expiryBadgeClass,
  expiryTone,
  expiryToneLabel,
  type BatchAllocation,
  type DiscountReasonValue,
} from "@/lib/pos/fefo"

// Debounce hook for search
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value)

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value)
    }, delay)

    return () => {
      clearTimeout(handler)
    }
  }, [value, delay])

  return debouncedValue
}

interface ProductPackage {
  id: string
  name: string  // "Strip", "Box", "Dozen"
  unitsPerPackage: number
  price: number
  isDefault: boolean
}

interface ProductBatch {
  id: string
  batchNumber: string
  quantity: number
  expiryDate: string
  costPrice: number | null
  sellingPrice: number
  manufacturer?: string | null
}

interface Product {
  id: string
  name: string
  sku: string
  price: number
  costPrice: number
  quantity: number
  unitOfMeasure: string
  strength?: string
  dosageForm?: string
  activeIngredient?: string
  genericName?: string
  requiresPrescription?: boolean
  supplierId?: string
  supplier?: { name: string }
  barcode?: string
  expiryDate?: string
  batchNumber?: string
  packages?: ProductPackage[]
  batches?: ProductBatch[]
}

interface CartItem extends Product {
  cartQuantity: number
  /** Catalog unit/package price — locked for cashiers */
  listPrice: number
  unitListPrice: number
  costPrice: number
  /** Effective sold unit price after discount */
  sellingPrice: number
  unitSellingPrice: number
  subtotal: number
  discountAmount: number
  discountReason: DiscountReasonValue | ""
  discountReasonOther: string
  discountApprovedBy: string | null
  expiryDate?: string
  batchNumber?: string
  selectedPackage?: ProductPackage | null
  packageQuantity?: number
  baseUnitsTotal?: number
  selectedBatchId?: string
  /** FEFO split when qty spans batches */
  batchAllocations: BatchAllocation[]
}

interface Settings {
  pharmacyName: string
  location: string
  contact: string
  email: string
  logo?: string
  footerText?: string
  currency: string
  taxRate: number
  discountApprovalThresholdPct?: number
  mandatoryReceiptPrint?: boolean
  vatEnabled?: boolean
  vatRate?: number
  printerType?: string
  receiptPaperWidth?: "58" | "80" | "a4"
  receiptFontScale?: number
  autoPrintReceipt?: boolean
}

interface StaffMember {
  id: string
  name: string
  email: string
}

type CreditCustomer = {
  id: string
  name: string
  phone?: string | null
}

function formatPaymentLabel(method: string) {
  if (method === "MOBILE_MONEY") return "Mobile Money"
  if (method === "CREDIT") return "Credit"
  return method
}

export default function POSPage() {
  const router = useRouter()
  const { user } = usePharmacySession()
  const cashierCanEditPrice = Boolean(user?.isAdmin || user?.pharmacyRole === "pharmacy_admin")
  const [products, setProducts] = useState<Product[]>([])
  const [productsLoaded, setProductsLoaded] = useState(false)
  const [cart, setCart] = useState<CartItem[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [paymentMethod, setPaymentMethod] = useState<string>("CASH")
  const [isProcessing, setIsProcessing] = useState(false)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [showOrderDialog, setShowOrderDialog] = useState(false)
  const [showReceiptPreview, setShowReceiptPreview] = useState(false)
  const [amountPaid, setAmountPaid] = useState("")
  const [displayCount, setDisplayCount] = useState(20)
  const [showMobileCart, setShowMobileCart] = useState(false)
  const [showStaffDialog, setShowStaffDialog] = useState(false)
  const [staffMembers, setStaffMembers] = useState<StaffMember[]>([])
  const [selectedStaff, setSelectedStaff] = useState<StaffMember | null>(null)
  const [showPrintPrompt, setShowPrintPrompt] = useState(false)
  const [pendingTransaction, setPendingTransaction] = useState<any>(null)
  const [receiptStaffNamePending, setReceiptStaffNamePending] = useState<string>("")
  const [pendingReceiptMeta, setPendingReceiptMeta] = useState<{
    paymentMethod: string
    amountPaid: string
    change: number
    balanceDue: number
  } | null>(null)
  const [showClientNameBeforePrintDialog, setShowClientNameBeforePrintDialog] = useState(false)
  const [clientNameBeforePrint, setClientNameBeforePrint] = useState("")
  const [isSavingClientNameBeforePrint, setIsSavingClientNameBeforePrint] = useState(false)
  const [showClientDetailsBeforeSaleDialog, setShowClientDetailsBeforeSaleDialog] = useState(false)
  const [clientDetailsBeforeSale, setClientDetailsBeforeSale] = useState({ name: "", phone: "", address: "" })
  const [isSavingClientDetailsBeforeSale, setIsSavingClientDetailsBeforeSale] = useState(false)
  const [creditCustomers, setCreditCustomers] = useState<CreditCustomer[]>([])
  const [creditCustomerId, setCreditCustomerId] = useState("")
  const [creditDueDate, setCreditDueDate] = useState("")
  const [printReceiptData, setPrintReceiptData] = useState<any>(null)
  const [isPrintingReceipt, setIsPrintingReceipt] = useState(false)
  const [isOnline, setIsOnline] = useState(typeof navigator !== 'undefined' ? navigator.onLine : true)
  const [showSupervisorDialog, setShowSupervisorDialog] = useState(false)
  const [supervisorId, setSupervisorId] = useState("")
  const [supervisorPassword, setSupervisorPassword] = useState("")
  const [supervisorApproving, setSupervisorApproving] = useState(false)
  const [discountApprovedBy, setDiscountApprovedBy] = useState<string | null>(null)
  const [pendingSaleAfterApproval, setPendingSaleAfterApproval] = useState<{
    staffForReceipt: StaffMember | null
    client: { name: string; phone: string; address: string }
  } | null>(null)
  const [pendingSyncCount, setPendingSyncCount] = useState(0)
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const { toast } = useToast()
  const productSearchRef = useRef<HTMLInputElement>(null)
  const firstProductResultRef = useRef<HTMLButtonElement>(null)
  const paymentRef = useRef<HTMLSelectElement>(null)
  const patientRef = useRef<HTMLInputElement>(null)
  const amountPaidRef = useRef<HTMLInputElement>(null)
  const creditCustomerRef = useRef<HTMLSelectElement>(null)
  const creditDueDateRef = useRef<HTMLInputElement>(null)
  const completeSaleRef = useRef<HTMLButtonElement>(null)
  const [liveMessage, setLiveMessage] = useState("")

  // Debounce search query for better performance
  const debouncedSearchQuery = useDebounce(searchQuery, 300)

  useEffect(() => {
    if (paymentMethod !== "CREDIT") return

    fetch("/api/admin/customers")
      .then((res) => res.json())
      .then((data) => {
        setCreditCustomers(Array.isArray(data) ? data : [])
      })
      .catch(() => setCreditCustomers([]))
  }, [paymentMethod])

  useEffect(() => {
    if (!creditCustomerId) return
    const customer = creditCustomers.find((c) => c.id === creditCustomerId)
    if (customer) {
      setClientDetailsBeforeSale((prev) => ({
        ...prev,
        name: customer.name,
        phone: customer.phone ?? prev.phone,
      }))
    }
  }, [creditCustomerId, creditCustomers])

  // Load cart from localStorage on mount
  useEffect(() => {
    const handleOnline = () => setIsOnline(true)
    const handleOffline = () => setIsOnline(false)
    const handleBeforeInstallPrompt = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt)

    const savedCart = localStorage.getItem('pos-cart')
    if (savedCart) {
      try {
        setCart(JSON.parse(savedCart))
      } catch (e) {
        console.error('Failed to parse saved cart:', e)
      }
    }
    fetchProducts()
    fetchSettings()
    fetchStaffMembers()
    updatePendingSyncCount()

    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt)
    }
  }, [])

  const updatePendingSyncCount = async () => {
    const pending = await getPendingActions()
    setPendingSyncCount(pending.length)
  }

  // Check for sync updates periodically or when online status changes
  useEffect(() => {
    const interval = setInterval(updatePendingSyncCount, 10000)
    updatePendingSyncCount()
    return () => clearInterval(interval)
  }, [isOnline])

  const handleInstallClick = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setDeferredPrompt(null)
    }
  }

  // Save cart to localStorage whenever it changes. The header badge reads this
  // key, and `storage` does not fire in the tab that wrote it, so announce it.
  useEffect(() => {
    if (cart.length > 0) {
      localStorage.setItem('pos-cart', JSON.stringify(cart))
    } else {
      localStorage.removeItem('pos-cart')
    }
    window.dispatchEvent(new Event('pos-cart-changed'))
  }, [cart])

  useEffect(() => {
    const handleAfterPrint = () => {
      setIsPrintingReceipt(false)
      setPrintReceiptData(null)
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

  // Check if current user is SYNAPSE PHARM master account
  const isSynapsePharmAccount = useMemo(() => {
    return user?.fullName === "SYNAPSE POS" || user?.email === "pos@synapseos.tech"
  }, [user])

  const fetchStaffMembers = async () => {
    try {
      if (navigator.onLine) {
        const response = await fetch("/api/admin/staff-list")
        if (response.ok) {
          const data = await response.json()
          setStaffMembers(data)
          saveMetadata('staff-members', data)
          return
        }
      }
      // Offline fallback
      const cachedStaff = await getMetadata('staff-members')
      if (Array.isArray(cachedStaff)) setStaffMembers(cachedStaff as StaffMember[])
    } catch (error) {
      console.error("Failed to fetch staff:", error)
      const cachedStaff = await getMetadata('staff-members')
      if (Array.isArray(cachedStaff)) setStaffMembers(cachedStaff as StaffMember[])
    }
  }

  const fetchSettings = async () => {
    try {
      if (navigator.onLine) {
        const response = await fetch("/api/admin/settings")
        if (response.ok) {
          const data = await response.json()
          setSettings(data)
          saveMetadata('settings', data)
          return
        }
      }
      // Offline fallback
      const cachedSettings = await getMetadata('settings')
      if (cachedSettings && typeof cachedSettings === 'object') setSettings(cachedSettings as Settings)
    } catch (error) {
      console.error("Failed to fetch settings:", error)
      const cachedSettings = await getMetadata('settings')
      if (cachedSettings && typeof cachedSettings === 'object') setSettings(cachedSettings as Settings)
    }
  }

  const fetchProducts = async () => {
    try {
      if (navigator.onLine) {
        const response = await fetch("/api/admin/inventory")
        if (response.ok) {
          const data = await response.json()
          const productList = Array.isArray(data) ? data : []
          setProducts(productList)
          setProductsLoaded(true)
          saveMetadata('products', productList)
          return
        }
        throw new Error('Failed to fetch products')
      }
      // Offline fallback
      const cachedProducts = await getMetadata('products')
      if (Array.isArray(cachedProducts)) {
        setProducts(cachedProducts as Product[])
        setProductsLoaded(true)
      }
    } catch (error) {
      console.error("Failed to fetch products:", error)
      const cachedProducts = await getMetadata('products')
      if (Array.isArray(cachedProducts)) {
        setProducts(cachedProducts as Product[])
        setProductsLoaded(true)
      }

      if (navigator.onLine) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to fetch products",
        })
      }
    }
  }

  // Use memoized filtered products with debounced search for better INP
  const allFilteredProducts = useMemo(() => {
    const query = debouncedSearchQuery.toLowerCase()
    if (!query) return products
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.sku.toLowerCase().includes(query) ||
        (p.barcode && p.barcode.toLowerCase().includes(query))
    )
  }, [products, debouncedSearchQuery])

  // Paginate: show displayCount items, or all when searching
  const filteredProducts = useMemo(() => {
    if (debouncedSearchQuery) return allFilteredProducts
    return allFilteredProducts.slice(0, displayCount)
  }, [allFilteredProducts, displayCount, debouncedSearchQuery])

  const hasMoreProducts = !debouncedSearchQuery && displayCount < products.length

  const rebuildCartLine = useCallback((
    base: Product,
    opts: {
      cartQuantity: number
      selectedPackage?: ProductPackage | null
      discountAmount?: number
      discountReason?: DiscountReasonValue | ""
      discountReasonOther?: string
      discountApprovedBy?: string | null
    },
  ): CartItem => {
    const selectedPackage = opts.selectedPackage ?? null
    const cartQuantity = opts.cartQuantity
    const baseUnits = selectedPackage ? cartQuantity * selectedPackage.unitsPerPackage : cartQuantity
    const allocations = allocateFefoBatches(
      (base.batches ?? []).map((b) => ({
        id: b.id,
        batchNumber: b.batchNumber,
        quantity: b.quantity,
        expiryDate: b.expiryDate,
        manufacturer: b.manufacturer,
        costPrice: b.costPrice,
        sellingPrice: b.sellingPrice ?? base.price,
      })),
      baseUnits,
    )
    const allocatedUnits = allocations.reduce((total, allocation) => total + allocation.quantity, 0)
    const baseListTotal =
      allocations.reduce(
        (total, allocation) => total + allocation.quantity * (allocation.sellingPrice ?? base.price),
        0,
      ) +
      Math.max(0, baseUnits - allocatedUnits) * base.price
    const unitListPrice = baseUnits > 0 ? baseListTotal / baseUnits : base.price
    const listPrice = selectedPackage
      ? unitListPrice * selectedPackage.unitsPerPackage
      : unitListPrice
    const discountAmount = Math.max(0, opts.discountAmount ?? 0)
    const lineListTotal = listPrice * cartQuantity
    const soldTotal = Math.max(0, lineListTotal - discountAmount)
    const sellingPrice = cartQuantity > 0 ? soldTotal / cartQuantity : listPrice
    const unitSellingPrice = baseUnits > 0 ? soldTotal / baseUnits : unitListPrice
    const first = allocations[0]
    return {
      ...base,
      cartQuantity,
      listPrice,
      unitListPrice,
      costPrice: first?.costPrice ?? base.costPrice,
      sellingPrice,
      unitSellingPrice,
      subtotal: soldTotal,
      discountAmount,
      discountReason: opts.discountReason ?? "",
      discountReasonOther: opts.discountReasonOther ?? "",
      discountApprovedBy: opts.discountApprovedBy ?? null,
      selectedPackage,
      packageQuantity: selectedPackage ? cartQuantity : undefined,
      baseUnitsTotal: baseUnits,
      selectedBatchId: first?.batchId,
      batchNumber: first?.batchNumber ?? base.batchNumber,
      expiryDate: first?.expiryDate ?? base.expiryDate,
      batchAllocations: allocations,
    }
  }, [])

  const repriceCart = useCallback((items: CartItem[]) => {
    const productsById = new Map(products.map((product) => [product.id, product]))
    const repriced: CartItem[] = []
    for (const item of items) {
      const product = productsById.get(item.id)
      // The catalogue lists active products only. A line left over from an
      // earlier visit whose product has since been deactivated or merged away
      // can never be sold, and would reject the whole sale with
      // "Product not found" — drop it instead of carrying it forward.
      if (!product) continue
      const selectedPackage =
        product.packages?.find(
          (pkg) => pkg.id === item.selectedPackage?.id || pkg.name === item.selectedPackage?.name,
        ) ?? null
      repriced.push(
        rebuildCartLine(product, {
          cartQuantity: item.cartQuantity,
          selectedPackage,
          discountAmount: item.discountAmount,
          discountReason: item.discountReason,
          discountReasonOther: item.discountReasonOther,
          discountApprovedBy: item.discountApprovedBy,
        }),
      )
    }
    return repriced
  }, [products, rebuildCartLine])

  useEffect(() => {
    if (productsLoaded) setCart((current) => repriceCart(current))
  }, [products, productsLoaded, repriceCart])

  const addToCart = (product: Product, selectedPackage?: ProductPackage | null) => {
    // Stock may never go negative on a sale (server enforces INSUFFICIENT_STOCK too).
    if (Number(product.quantity ?? 0) <= 0) {
      setLiveMessage(`${product.name} is out of stock`)
      toast({ title: "Out of stock", description: `${product.name} has no sellable stock. Receive stock first.`, variant: "destructive" })
      return
    }
    setLiveMessage(`${product.name} added to cart`)
    const existingItem = cart.find((item) => item.id === product.id &&
      item.selectedPackage?.id === selectedPackage?.id)

    if (existingItem) {
      const newQty = existingItem.cartQuantity + 1
      const updatedItem = rebuildCartLine(product, {
        cartQuantity: newQty,
        selectedPackage: selectedPackage || null,
        discountAmount: existingItem.discountAmount,
        discountReason: existingItem.discountReason,
        discountReasonOther: existingItem.discountReasonOther,
        discountApprovedBy: existingItem.discountApprovedBy,
      })
      setCart([
        updatedItem,
        ...cart.filter((item) => !(item.id === product.id && item.selectedPackage?.id === selectedPackage?.id))
      ])
    } else {
      setCart([
        rebuildCartLine(product, {
          cartQuantity: 1,
          selectedPackage: selectedPackage || null,
        }),
        ...cart,
      ])
    }
  }

  const removeFromCart = (productId: string) => {
    setCart(cart.filter((item) => item.id !== productId))
  }

  const updateCartQuantity = (productId: string, quantity: number, packageId?: string) => {
    if (quantity <= 0) {
      removeFromCart(productId)
      return
    }

    setCart(
      cart.map((item) => {
        const matches = item.id === productId &&
          (packageId === undefined || item.selectedPackage?.id === packageId)
        if (!matches) return item
        return rebuildCartLine(item, {
          cartQuantity: quantity,
          selectedPackage: item.selectedPackage,
          discountAmount: item.discountAmount,
          discountReason: item.discountReason,
          discountReasonOther: item.discountReasonOther,
          discountApprovedBy: item.discountApprovedBy,
        })
      })
    )
  }

  const updateLineDiscount = (
    productId: string,
    patch: Partial<Pick<CartItem, "discountAmount" | "discountReason" | "discountReasonOther">>,
    packageId?: string,
  ) => {
    setDiscountApprovedBy(null)
    setCart(
      cart.map((item) => {
        const matches = item.id === productId &&
          (packageId === undefined || item.selectedPackage?.id === packageId)
        if (!matches) return item
        return rebuildCartLine(item, {
          cartQuantity: item.cartQuantity,
          selectedPackage: item.selectedPackage,
          discountAmount: patch.discountAmount ?? item.discountAmount,
          discountReason: patch.discountReason ?? item.discountReason,
          discountReasonOther: patch.discountReasonOther ?? item.discountReasonOther,
          discountApprovedBy: null,
        })
      }),
    )
  }

  const discountThreshold = settings?.discountApprovalThresholdPct ?? 5
  const cartDiscountPct =
    cart.reduce((s, i) => s + i.listPrice * i.cartQuantity, 0) > 0
      ? (cart.reduce((s, i) => s + i.discountAmount, 0) /
          cart.reduce((s, i) => s + i.listPrice * i.cartQuantity, 0)) *
        100
      : 0
  const needsSupervisorApproval =
    !cashierCanEditPrice && cartDiscountPct > discountThreshold && !discountApprovedBy

  const total = cart.reduce((sum, item) => sum + item.subtotal, 0)
  const taxRate = settings?.taxRate || 0
  const taxAmount = total * (taxRate / 100)
  const grandTotal = total + taxAmount
  const settlement = settlePayment(
    grandTotal,
    paymentMethod === "CREDIT" ? 0 : amountPaid || 0,
  )
  const change = settlement.change
  const balanceDue = settlement.balanceDue
  const isPartialPayment = settlement.isPartial && paymentMethod !== "CREDIT"

  // For SYNAPSE PHARM account, use selected staff name; otherwise use logged-in user
  const staffName = isSynapsePharmAccount && selectedStaff
    ? `${selectedStaff.name} of SYNAPSE PHARM`
    : user?.fullName ?? "Staff"

  // The actual staff ID for transaction recording
  const transactionStaffId = isSynapsePharmAccount && selectedStaff
    ? selectedStaff.id
    : user?.id

  const handleCompleteSale = () => {
    if (cart.length === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Cart is empty",
      })
      return
    }

    // If logged in as SYNAPSE PHARM, show staff selection dialog
    if (isSynapsePharmAccount && !selectedStaff) {
      setShowStaffDialog(true)
      return
    }
    // Show client details dialog before processing transaction
    if (isPartialPayment && !creditCustomerId && !clientDetailsBeforeSale.name.trim()) {
      // Will collect name in the client-details dialog
    }
    if (paymentMethod === "CREDIT" && !creditCustomerId) {
      toast({
        variant: "destructive",
        title: "Customer required",
        description: "Select a customer for credit sales, or enter details in the next step.",
      })
    }
    setClientNameBeforePrint("")
    setShowClientDetailsBeforeSaleDialog(true)
  }

  // A new sale starts from a clean slate: nothing from the previous one (items,
  // tender, method, credit customer, staff, discount approval) carries over.
  const startNewSale = useCallback(() => {
    setCart([])
    localStorage.removeItem("pos-cart")
    setSelectedStaff(null)
    setAmountPaid("")
    setPaymentMethod("CASH")
    setCreditCustomerId("")
    setCreditDueDate("")
    setClientDetailsBeforeSale({ name: "", phone: "", address: "" })
    setDiscountApprovedBy(null)
    setSearchQuery("")
    setTimeout(() => productSearchRef.current?.focus(), 0)
  }, [])

  const processTransaction = async (
    staffForReceipt: StaffMember | null,
    client: { name: string; phone: string; address: string },
    approvedByOverride?: string | null,
  ) => {
    // Discount lines must include a reason (DB constraint + UX).
    const badDiscount = cart.find((i) => i.discountAmount > 0 && !i.discountReason)
    if (badDiscount) {
      toast({
        variant: "destructive",
        title: "Discount reason required",
        description: `Add a reason for the discount on ${badDiscount.name}.`,
      })
      return
    }
    const effectiveApproval = approvedByOverride ?? discountApprovedBy
    const needsApprovalNow =
      !cashierCanEditPrice && cartDiscountPct > discountThreshold && !effectiveApproval
    if (needsApprovalNow) {
      setPendingSaleAfterApproval({ staffForReceipt, client })
      setShowSupervisorDialog(true)
      return
    }

    setIsProcessing(true)

    // Determine staff name for this specific transaction
    const receiptStaffName = isSynapsePharmAccount && staffForReceipt
      ? `${staffForReceipt.name} of SYNAPSE PHARM`
      : user?.fullName ?? "Staff"

    const txnNo = generateTransactionNo()
    const idempotencyKey =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `pos-${txnNo}-${Date.now()}`

    const transactionPayload = {
      transactionNo: txnNo,
      idempotencyKey,
      items: cart.map((item) => {
        const reason =
          item.discountReason === "other"
            ? `other:${item.discountReasonOther || "unspecified"}`
            : item.discountReason || null
        return {
          productId: item.id,
          quantity: item.baseUnitsTotal || item.cartQuantity,
          listPrice: item.unitListPrice,
          unitPrice: item.unitSellingPrice,
          batchAllocations: item.batchAllocations.map((allocation) => ({
            batchId: allocation.batchId,
            quantity: allocation.quantity,
            sellingPrice: allocation.sellingPrice,
          })),
          discountAmount: item.discountAmount,
          discountReason: reason,
          discountApprovedBy: effectiveApproval,
          costPrice: item.costPrice,
          packageName: item.selectedPackage?.name || null,
          packageQuantity: item.packageQuantity || null,
          batchId: item.selectedBatchId || null,
        }
      }),
      paymentMethod,
      // Receipt display name only — cashier identity is always the authenticated session user.
      receiptStaffName,
      taxAmount,
      discountApprovedBy: effectiveApproval,
      clientName: client.name,
      clientPhone: client.phone,
      clientAddress: client.address,
      amountPaid: paymentMethod === "CREDIT" ? 0 : settlement.amountPaid,
      ...(paymentMethod === "CREDIT" || isPartialPayment
        ? {
            customerId: creditCustomerId || undefined,
            creditDueDate: creditDueDate || undefined,
          }
        : {}),
    };

    if (!navigator.onLine) {
      toast({
        variant: "destructive",
        title: "You are offline",
        description:
          "Sales cannot be completed offline. Stay connected — nothing was charged or deducted from stock.",
      })
      setIsProcessing(false)
      return
    }

    // Online: Proceed with API call
    try {
        const response = await fetch("/api/admin/pos/complete-sale", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify(transactionPayload),
        });

        const data = await response.json();

        if (response.ok) {
          const sale = data.sale ?? data
          toast({
            title: "Success",
            description: sale?.receipt_number
              ? `Sale ${sale.receipt_number} completed`
              : "Sale completed successfully",
          })
          setLiveMessage(
            sale?.receipt_number
              ? `Payment completed. Sale ${sale.receipt_number}`
              : "Payment completed",
          )
          if (data.creditWarning) {
            // The sale went through but the receivable did not — never leave
            // this as a silent success.
            toast({
              variant: "destructive",
              title: "Credit not recorded",
              description: String(data.creditWarning),
            })
          }

          const printTxn = {
            id: sale?.sale_id ?? sale?.id ?? `sale-${Date.now()}`,
            transactionNo: sale?.receipt_number ?? txnNo,
            createdAt: new Date().toISOString(),
            clientName: client.name,
            clientPhone: client.phone,
            clientAddress: client.address,
            totalAmount: Number(sale?.subtotal ?? total),
            tax: Number(sale?.tax_amount ?? taxAmount),
            netAmount: Number(sale?.total_amount ?? grandTotal),
            paymentMethod,
            items: cart.map((item, idx) => ({
              id: `item-${idx}`,
              quantity: item.baseUnitsTotal || item.cartQuantity,
              unitPrice: item.unitSellingPrice,
              totalPrice: item.subtotal,
              packageName: item.selectedPackage?.name || null,
              packageQuantity: item.packageQuantity || null,
              product: { name: item.name, sku: item.sku },
              batch: item.batchNumber
                ? { batchNumber: item.batchNumber, expiryDate: item.expiryDate }
                : null,
            })),
          }

          setPendingTransaction(printTxn)
          setReceiptStaffNamePending(receiptStaffName)
          const receiptMeta = {
            paymentMethod,
            amountPaid: String(settlement.amountPaid),
            change: settlement.change,
            balanceDue: settlement.balanceDue,
          }
          setPendingReceiptMeta(receiptMeta)
          if (settings?.autoPrintReceipt) {
            setPrintReceiptData({
              transaction: printTxn,
              staffName: receiptStaffName,
              meta: receiptMeta,
              settings,
            })
            setIsPrintingReceipt(true)
            triggerReliablePrint()
            setPendingTransaction(null)
            setReceiptStaffNamePending("")
            setPendingReceiptMeta(null)
          } else {
            setShowPrintPrompt(true)
          }

          startNewSale()
          fetchProducts()
        } else {
          const missingId = String(data.error ?? "")
            .match(/^Product not found: (.+)$/)?.[1]
            ?.trim()
          if (response.status === 404 && missingId) {
            // The catalogue moved on while this cart was open — the item was
            // removed or deactivated. Drop the dead line so the rest of the
            // sale can go through instead of failing again on every retry.
            setCart((current) => current.filter((line) => line.id !== missingId))
            fetchProducts()
            toast({
              variant: "destructive",
              title: "Item no longer available",
              description:
                "It was removed from the cart. Check the sale and try again.",
            })
          } else {
            toast({
              variant: "destructive",
              title: "Error",
              description: data.error || "Failed to process transaction",
            })
          }
        }
      } catch (error) {
        toast({
          variant: "destructive",
          title: "Error",
          description: "An error occurred",
        })
      }

    setIsProcessing(false);
  }

  const resetPendingPrintFlow = () => {
    setPendingTransaction(null)
    setReceiptStaffNamePending("")
    setPendingReceiptMeta(null)
    setShowPrintPrompt(false)
    setShowClientNameBeforePrintDialog(false)
    setClientNameBeforePrint("")
    setIsSavingClientNameBeforePrint(false)
  }

  const handlePrintPromptResponse = (shouldPrint: boolean) => {
    if (!shouldPrint) {
      resetPendingPrintFlow()
      return
    }

    if (!pendingTransaction) {
      resetPendingPrintFlow()
      return
    }

    setClientNameBeforePrint(pendingTransaction.clientName || "")
    setShowPrintPrompt(false)
    setShowClientNameBeforePrintDialog(true)
  }

  const confirmClientNameBeforePrint = async () => {
    if (!pendingTransaction) {
      resetPendingPrintFlow()
      return
    }

    const desiredClientName = clientNameBeforePrint.trim()

    setIsSavingClientNameBeforePrint(true)
    let updatedTransaction = pendingTransaction

    try {
      const response = await fetch(`/api/admin/transactions/${pendingTransaction.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientName: desiredClientName }),
      })

      if (response.ok) {
        // Merge only clientName — pendingTransaction is already camelCase-normalized
        updatedTransaction = { ...pendingTransaction, clientName: desiredClientName }
      }
    } catch (error) {
      console.error("Failed to update client name before printing:", error)
    } finally {
      setIsSavingClientNameBeforePrint(false)
    }

    setPrintReceiptData({
      transaction: updatedTransaction,
      staffName: receiptStaffNamePending,
      meta: pendingReceiptMeta,
      settings,
    })
    setIsPrintingReceipt(true)
    triggerReliablePrint()

    resetPendingPrintFlow()
  }

  const confirmClientDetailsBeforeSale = async () => {
    if (paymentMethod === "CREDIT" && !creditCustomerId && !clientDetailsBeforeSale.name.trim()) {
      toast({
        variant: "destructive",
        title: "Customer required",
        description: "Enter a customer name or select an existing customer for credit sales.",
      })
      return
    }
    if (isPartialPayment && !creditCustomerId && !clientDetailsBeforeSale.name.trim()) {
      toast({
        variant: "destructive",
        title: "Customer required for balance",
        description: "Enter the customer name so the unpaid balance can be recorded on their account.",
      })
      return
    }

    setIsSavingClientDetailsBeforeSale(true)
    
    try {
      // Proceed with transaction using the entered client details
      processTransaction(selectedStaff, {
        name: clientDetailsBeforeSale.name.trim(),
        phone: clientDetailsBeforeSale.phone.trim(),
        address: clientDetailsBeforeSale.address.trim(),
      })
      
      // Close the dialog after processing
      setShowClientDetailsBeforeSaleDialog(false)
    } catch (error) {
      console.error("Error processing client details:", error)
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to process transaction",
      })
    } finally {
      setIsSavingClientDetailsBeforeSale(false)
    }
  }

  const saveAsOrder = () => {
    if (cart.length === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Cart is empty",
      })
      return
    }
    setShowOrderDialog(true)
  }

  const handlePosEnterKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>,
    field:
      | "productSearch"
      | "cartQuantity"
      | "paymentMethod"
      | "amountPaid"
      | "creditCustomer"
      | "creditDueDate",
    lineIndex?: number,
  ) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.nativeEvent.isComposing
    ) {
      return
    }

    const query = searchQuery.trim()
    const normalizedQuery = query.toLowerCase()
    const matches = field === "productSearch" && normalizedQuery
      ? products.filter(
          (product) =>
            product.name.toLowerCase().includes(normalizedQuery) ||
            product.sku.toLowerCase().includes(normalizedQuery) ||
            Boolean(product.barcode?.toLowerCase().includes(normalizedQuery)),
        )
      : []
    const action = resolvePosEnterAction(field, {
      matches: field === "productSearch" ? matches.length : 0,
      cartCount: cart.length,
      query,
      paymentMethod,
      lineIndex,
      lineCount: cart.length,
    })

    if (!action) return

    if (action === "chooseProduct" && !firstProductResultRef.current) return
    event.preventDefault()

    switch (action) {
      case "addProduct":
        if (matches[0]) {
          addToCart(matches[0])
          setSearchQuery("")
          productSearchRef.current?.focus()
        }
        break
      case "chooseProduct":
        firstProductResultRef.current?.focus()
        break
      case "focusNextQuantity":
        if (event.currentTarget instanceof HTMLInputElement) {
          const inputs = Array.from(
            document.querySelectorAll<HTMLInputElement>("[data-pos-cart-quantity]"),
          )
          const currentIndex = inputs.indexOf(event.currentTarget)
          inputs[currentIndex + 1]?.focus()
        }
        break
      case "focusPayment":
        paymentRef.current?.focus()
        break
      case "focusAmountPaid":
        amountPaidRef.current?.focus()
        break
      case "focusCreditCustomer":
        creditCustomerRef.current?.focus()
        break
      case "focusCreditDueDate":
        creditDueDateRef.current?.focus()
        break
      case "completeSale":
        completeSaleRef.current?.click()
        break
    }
  }

  usePosKeyboardShortcuts({
    onPatientSearch: () => patientRef.current?.focus(),
    onProductSearch: () => productSearchRef.current?.focus(),
    onPayment: () => paymentRef.current?.focus(),
    onAmountPaid: () => {
      setPaymentMethod("CASH")
      setTimeout(() => amountPaidRef.current?.focus(), 0)
    },
    onCustomer: () => {
      setShowClientDetailsBeforeSaleDialog(true)
    },
    onCompleteSale: () => {
      if (!isProcessing && cart.length > 0) handleCompleteSale()
    },
    onDeleteLine: () => {
      if (cart.length === 0) {
        setLiveMessage("Cart is empty")
        return
      }
      const last = cart[cart.length - 1]
      removeFromCart(last.id)
      setLiveMessage(`Removed ${last.name}`)
    },
    onClearCart: () => {
      if (cart.length === 0) return
      setCart([])
      setAmountPaid("")
      setLiveMessage("Cart cleared")
      toast({ title: "Cart cleared", description: "Alt+D · like Tally delete voucher" })
    },
    onPrintReceipt: () => {
      if (cart.length === 0) {
        setLiveMessage("Cart is empty — nothing to print")
        return
      }
      setShowReceiptPreview(true)
    },
    onCreditMode: () => {
      setPaymentMethod("CREDIT")
      setLiveMessage("Credit mode")
      toast({ title: "Credit sale", description: "Ctrl+F8 · select or enter customer (Alt+C)" })
    },
    onSaveOrder: () => {
      saveAsOrder()
    },
    onHoldSale: () => {
      if (cart.length === 0) {
        setLiveMessage("Cart is empty — nothing to hold")
        return
      }
      localStorage.setItem("pos-cart-held", JSON.stringify(cart))
      setCart([])
      setLiveMessage("Sale held")
      toast({ title: "Sale held", description: "Press F10 to resume. Shift+F8 holds." })
    },
    onResumeSale: () => {
      const held = localStorage.getItem("pos-cart-held")
      if (!held) {
        setLiveMessage("No held sale")
        return
      }
      try {
        const heldItems = JSON.parse(held) as CartItem[]
        setCart(repriceCart(heldItems))
        setLiveMessage("Held sale resumed")
        toast({ title: "Sale resumed" })
      } catch {
        setLiveMessage("Could not resume held sale")
      }
    },
    onClose: () => {
      const dialogOpen =
        showMobileCart ||
        showReceiptPreview ||
        showClientDetailsBeforeSaleDialog ||
        showOrderDialog ||
        showPrintPrompt ||
        showClientNameBeforePrintDialog ||
        showSupervisorDialog ||
        showStaffDialog
      setShowMobileCart(false)
      setShowReceiptPreview(false)
      setShowClientDetailsBeforeSaleDialog(false)
      setShowOrderDialog(false)
      setShowSupervisorDialog(false)
      setShowStaffDialog(false)
      if (showPrintPrompt || showClientNameBeforePrintDialog) resetPendingPrintFlow()
      // Escape closes the open dialog first; on a bare till it goes back, like
      // the browser Back button, instead of trapping the cashier on the page.
      if (!dialogOpen) router.back()
    },
  })

  return (
    <div>
      <LiveRegion message={liveMessage} politeness="polite" />
      <TillBanner />
      {isPrintingReceipt && printReceiptData && (
        <div className="print-area fixed inset-0 z-[9999] overflow-auto" style={{ background: 'rgba(0,0,0,0.88)' }}>
          <div className="flex min-h-full items-start justify-center py-10">
            <TransactionReceipt
              transaction={printReceiptData.transaction}
              staffName={printReceiptData.staffName}
              settings={printReceiptData.settings}
              meta={printReceiptData.meta}
            />
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Point of Sale</h1>
          <p className="text-muted-foreground mt-1 sm:mt-2 text-sm sm:text-base">
            Tally-style keys: F8 Sales · Ctrl+A Accept · F5 Payment · F6 Receipt · Alt+C Customer · Ctrl+D Del line · F9 Order.
            {" "}Enter adds a unique product match, advances cart quantity lines and checkout fields, then completes from the final field.
            {isSynapsePharmAccount && selectedStaff && (
              <span className="ml-2 text-primary font-medium">
                {" "}Selling as: {selectedStaff.name}
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {deferredPrompt && (
            <Button
              onClick={handleInstallClick}
              variant="outline"
              size="sm"
              className="border-primary/25 bg-primary/10 text-primary hover:bg-primary/15"
            >
              <Download className="h-4 w-4 mr-2" />
              Install POS
            </Button>
          )}

          <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium border ${isOnline ? 'bg-green-50 border-green-200 text-green-700 dark:text-[#22C55E]' : 'bg-orange-50 border-orange-200 text-orange-700'
            }`}>
            {isOnline ? (
              <><Wifi className="h-3 w-3" /> Online</>
            ) : (
              <><WifiOff className="h-3 w-3" /> Offline — sales paused</>
            )}
          </div>

          {pendingSyncCount > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-accent/10 border border-accent/25 text-[#E8B84B] animate-pulse">
              <Clock className="h-3 w-3" />
              {pendingSyncCount} pending sync
            </div>
          )}
        </div>
      </div>

      {/* Staff Selection Dialog for SYNAPSE PHARM account */}
      {showStaffDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Who is making this sale?</CardTitle>
              <p className="text-sm text-muted-foreground">Select your name to complete the sale</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {staffMembers.map((staff) => (
                  <button
                    key={staff.id}
                    onClick={() => {
                      setSelectedStaff(staff)
                      setShowStaffDialog(false)
                      processTransaction(staff, { name: "", phone: "", address: "" })
                    }}
                    className="w-full p-3 text-left border rounded-lg hover:bg-muted/20 hover:border-primary transition-colors"
                  >
                    <div className="font-medium">{staff.name}</div>
                    <div className="text-xs text-muted-foreground">{staff.email}</div>
                  </button>
                ))}
                {staffMembers.length === 0 && (
                  <p className="text-center text-muted-foreground py-4">No staff members found</p>
                )}
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShowStaffDialog(false)}
              >
                Cancel
              </Button>
            </CardContent>
          </Card>
        </div>
      )}

      {showSupervisorDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Supervisor approval</CardTitle>
              <p className="text-sm text-muted-foreground">
                Discount {cartDiscountPct.toFixed(1)}% exceeds the {discountThreshold}% threshold.
                Enter a supervisor password to continue.
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <div>
                <Label>Supervisor</Label>
                <select
                  className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={supervisorId}
                  onChange={(e) => setSupervisorId(e.target.value)}
                >
                  <option value="">Select…</option>
                  {staffMembers.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <Label>Password</Label>
                <Input
                  type="password"
                  className="mt-1 font-mono"
                  value={supervisorPassword}
                  onChange={(e) => setSupervisorPassword(e.target.value)}
                />
              </div>
              <div className="flex gap-2 pt-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowSupervisorDialog(false)
                    setPendingSaleAfterApproval(null)
                    setSupervisorPassword("")
                  }}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1 bg-[#1FA6A6] hover:bg-[#1FA6A6]/90"
                  disabled={supervisorApproving || !supervisorId || !supervisorPassword}
                  onClick={async () => {
                    setSupervisorApproving(true)
                    try {
                      const res = await fetch("/api/admin/pos/supervisor-approve", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          supervisorId,
                          password: supervisorPassword,
                        }),
                      })
                      const data = await res.json()
                      if (!res.ok) {
                        toast({
                          variant: "destructive",
                          title: "Approval failed",
                          description: data.error || "Incorrect password",
                        })
                        return
                      }
                      // Server-issued, cashier-bound approval token (not the raw supervisor id).
                      setDiscountApprovedBy(data.approvalToken)
                      setShowSupervisorDialog(false)
                      setSupervisorPassword("")
                      const pending = pendingSaleAfterApproval
                      setPendingSaleAfterApproval(null)
                      if (pending) {
                        await processTransaction(
                          pending.staffForReceipt,
                          pending.client,
                          data.approvalToken as string,
                        )
                      }
                    } finally {
                      setSupervisorApproving(false)
                    }
                  }}
                >
                  {supervisorApproving ? "Checking…" : "Approve"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {showClientDetailsBeforeSaleDialog && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle>Client Details</CardTitle>
              <p className="text-sm text-muted-foreground">
                {paymentMethod === "CREDIT"
                  ? "Customer name is required for credit sales. Phone helps track repayments."
                  : isPartialPayment
                    ? `Partial payment: ${formatCurrency(balanceDue)} remains as balance due. Customer name is required.`
                    : "Enter client information for the receipt (optional)"}
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="clientName">Client Name</Label>
                <Input
                  id="clientName"
                  ref={patientRef}
                  value={clientDetailsBeforeSale.name}
                  onChange={(e) => setClientDetailsBeforeSale({ ...clientDetailsBeforeSale, name: e.target.value })}
                  placeholder="e.g. John Doe"
                  autoComplete="name"
                  required={paymentMethod === "CREDIT"}
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="clientPhone">Phone Number</Label>
                <Input
                  id="clientPhone"
                  value={clientDetailsBeforeSale.phone}
                  onChange={(e) => setClientDetailsBeforeSale({ ...clientDetailsBeforeSale, phone: e.target.value })}
                  placeholder="e.g. 0741234567"
                />
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="clientAddress">Address</Label>
                <Input
                  id="clientAddress"
                  value={clientDetailsBeforeSale.address}
                  onChange={(e) => setClientDetailsBeforeSale({ ...clientDetailsBeforeSale, address: e.target.value })}
                  placeholder="e.g. Kampala, Uganda"
                />
              </div>

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setShowClientDetailsBeforeSaleDialog(false)}
                  disabled={isSavingClientDetailsBeforeSale}
                >
                  Cancel
                </Button>
                <Button
                  className="flex-1"
                  onClick={confirmClientDetailsBeforeSale}
                  disabled={isSavingClientDetailsBeforeSale}
                >
                  {isSavingClientDetailsBeforeSale ? "Processing..." : "Proceed"}
                </Button>
              </div>
            </CardContent>
          </Card>
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
                  onClick={resetPendingPrintFlow}
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

      {showOrderDialog && (
        <SaveOrderDialog
          cart={cart}
          onClose={() => setShowOrderDialog(false)}
          onSuccess={() => {
            setCart([])
            setShowOrderDialog(false)
            fetchProducts()
          }}
        />
      )}

      {showReceiptPreview && (
        <ReceiptPreviewDialog
          cart={cart}
          settings={settings}
          total={total}
          taxRate={taxRate}
          taxAmount={taxAmount}
          grandTotal={grandTotal}
          amountPaid={amountPaid}
          change={change}
          balanceDue={balanceDue}
          paymentMethod={paymentMethod}
          staffName={staffName}
          onClose={() => setShowReceiptPreview(false)}
        />
      )}

      {showPrintPrompt && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-sm">
            <CardHeader>
              <CardTitle>Print Receipt?</CardTitle>
              <p className="text-sm text-muted-foreground mt-2">Your sale has been recorded successfully. Would you like to print the receipt?</p>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-accent/10 border border-accent/25 rounded-lg p-3">
                <p className="text-sm text-foreground">
                  <strong>Important:</strong> The transaction has already been saved to the system regardless of your choice.
                </p>
              </div>
              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => handlePrintPromptResponse(false)}
                >
                  Skip Printing
                </Button>
                <Button
                  className="flex-1"
                  onClick={() => handlePrintPromptResponse(true)}
                >
                  <Printer className="h-4 w-4 mr-2" />
                  Print Receipt
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Products */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Products</CardTitle>
                  <p className="text-sm text-muted-foreground mt-1">
                    Showing {filteredProducts.length} of {debouncedSearchQuery ? allFilteredProducts.length : products.length} products
                  </p>
                </div>
              </div>
              <div className="relative mt-4">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Label htmlFor="pos-product-search" className="sr-only">Product search</Label>
                <Input
                  id="pos-product-search"
                  ref={productSearchRef}
                  onKeyDown={(event) => handlePosEnterKeyDown(event, "productSearch")}
                  placeholder="Search by name, SKU, or scan barcode..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value)
                    setDisplayCount(20) // Reset display count when searching
                  }}
                  className="pl-10"
                  autoComplete="off"
                  aria-describedby="pos-product-search-help"
                />
                <p id="pos-product-search-help" className="sr-only">
                  Shortcut F3 focuses this search. Results update as you type.
                </p>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-[600px] overflow-y-auto">
                {filteredProducts.map((product, index) => (
                  <div
                    key={product.id}
                    className="p-4 border rounded-lg hover:bg-muted/20 text-left transition-colors"
                  >
                    <button
                      ref={index === 0 ? firstProductResultRef : undefined}
                      type="button"
                      onClick={() => addToCart(product)}
                      className="w-full text-left"
                      aria-label={`Add ${product.name} to cart, ${formatCurrency(product.price)}, stock ${product.quantity}`}
                    >
                      <div className="font-medium text-sm">{product.name} {product.strength && <span className="text-muted-foreground text-[10px]">({product.strength})</span>}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-1">{product.activeIngredient}</div>
                      <div className="text-xs text-muted-foreground mt-1">{product.sku}</div>
                      <div className="mt-2 space-y-1">
                        <div className="flex justify-between items-center">
                          <span className="text-xs text-muted-foreground">Cost:</span>
                          <span className="text-xs text-muted-foreground font-medium">{formatCurrency(product.costPrice)}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-xs text-green-700 dark:text-[#22C55E]">Sell:</span>
                          <span className="text-primary font-bold">{formatCurrency(product.price)}</span>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1 pt-1 border-t">
                        {product.quantity < 0 ? (
                          <span className="text-destructive font-medium">
                            Negative stock: {product.quantity} {product.unitOfMeasure}
                          </span>
                        ) : product.quantity === 0 ? (
                          <span className="text-amber-700 font-medium">
                            Out of stock · cannot be sold
                          </span>
                        ) : (
                          <span>Stock: {product.quantity}</span>
                        )}
                      </div>
                    </button>
                    {/* Package options */}
                    {product.packages && product.packages.length > 0 && (
                      <div className="mt-2 pt-2 border-t space-y-1">
                        <div className="text-xs text-muted-foreground flex items-center gap-1">
                          <Package className="h-3 w-3" />
                          Packages:
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {product.packages.map((pkg) => (
                            <button
                              key={pkg.id}
                              onClick={(e) => {
                                e.stopPropagation()
                                addToCart(product, pkg)
                              }}
                              className="text-xs bg-primary/10 text-primary px-2 py-1 rounded-full hover:bg-primary/15 transition-colors"
                              title={`${pkg.name}: ${pkg.unitsPerPackage} units @ ${formatCurrency(pkg.price)}`}
                            >
                              {pkg.name} ({pkg.unitsPerPackage})
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                    {/* Batch expiry info */}
                    {product.batches && product.batches.length > 0 && (
                      <div className="text-xs text-primary mt-1">
                        Exp: {new Date(product.batches[0].expiryDate).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {hasMoreProducts && (
                <div className="flex justify-center mt-4 pt-4 border-t">
                  <Button
                    variant="outline"
                    onClick={() => setDisplayCount((prev) => prev + 20)}
                  >
                    Load More ({products.length - displayCount} remaining)
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Cart */}
        <div>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="flex items-center">
                  <ShoppingCart className="h-5 w-5 mr-2" />
                  Cart ({cart.length})
                </CardTitle>
                {cart.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (!confirm("Clear the held cart? This only removes items saved on this device.")) return
                      setCart([])
                      localStorage.removeItem("pos-cart")
                      toast({ title: "Held cart cleared" })
                    }}
                  >
                    Clear held cart
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-4 max-h-[400px] overflow-y-auto">
                {cart.map((item, lineIndex) => (
                  <div key={`${item.id}-${item.selectedPackage?.id || 'base'}`} className="border rounded-lg p-3">
                    <div className="flex justify-between items-start">
                      <div className="flex-1">
                        <div className="font-medium text-sm">{item.name}</div>
                        {item.selectedPackage && (
                          <div className="text-xs text-primary flex items-center gap-1">
                            <Package className="h-3 w-3" />
                            {item.selectedPackage.name} ({item.selectedPackage.unitsPerPackage} {item.unitOfMeasure}s)
                          </div>
                        )}
                        <div className="mt-1 space-y-0.5">
                          {(item.batchAllocations?.length ? item.batchAllocations : [{
                            batchId: item.selectedBatchId ?? "",
                            batchNumber: item.batchNumber ?? "—",
                            expiryDate: item.expiryDate ?? null,
                            manufacturer: null,
                            quantity: item.baseUnitsTotal || item.cartQuantity,
                            costPrice: item.costPrice,
                            sellingPrice: item.price,
                          }]).map((alloc) => {
                            const tone = expiryTone(alloc.expiryDate)
                            return (
                              <div
                                key={`${item.id}-${alloc.batchId}-${alloc.batchNumber}`}
                                className={`font-mono text-[11px] tabular-nums ${expiryBadgeClass(tone)}`}
                              >
                                <span className="sr-only">{expiryToneLabel(tone)}. </span>
                                {alloc.batchNumber}
                                {alloc.expiryDate
                                  ? ` · Exp ${new Date(alloc.expiryDate).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}`
                                  : ""}
                                {alloc.manufacturer ? ` · ${alloc.manufacturer}` : " · Mfg —"}
                                {` · ${formatCurrency(alloc.sellingPrice ?? item.price)}/unit`}
                                {item.batchAllocations?.length > 1 ? ` · ×${alloc.quantity}` : ""}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeFromCart(item.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                    {/* Locked unit price + discount control */}
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex-1">
                        <Label className="text-xs text-muted-foreground">
                          {item.selectedPackage ? `List / ${item.selectedPackage.name}` : "Unit price"}
                        </Label>
                        <div className="h-8 flex items-center font-mono text-sm tabular-nums border border-border rounded-md px-2 bg-muted/30">
                          {formatCurrency(item.listPrice)}
                        </div>
                      </div>
                      <div className="flex-1">
                        <Label className="text-xs text-muted-foreground">
                          {item.selectedPackage ? `${item.selectedPackage.name}s` : "Qty"}
                        </Label>
                        <Input
                          type="number"
                          min="1"
                          value={item.cartQuantity}
                          data-pos-cart-quantity
                          onKeyDown={(event) =>
                            handlePosEnterKeyDown(event, "cartQuantity", lineIndex)
                          }
                          onChange={(e) =>
                            updateCartQuantity(item.id, parseInt(e.target.value), item.selectedPackage?.id)
                          }
                          className="h-8 text-sm font-mono tabular-nums"
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2">
                      <div>
                        <Label className="text-xs text-muted-foreground">Discount (UGX)</Label>
                        <Input
                          type="number"
                          min="0"
                          value={item.discountAmount || ""}
                          onChange={(e) =>
                            updateLineDiscount(
                              item.id,
                              { discountAmount: Math.max(0, parseFloat(e.target.value) || 0) },
                              item.selectedPackage?.id,
                            )
                          }
                          className="h-8 text-sm font-mono tabular-nums"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Reason</Label>
                        <select
                          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
                          value={item.discountReason}
                          onChange={(e) =>
                            updateLineDiscount(
                              item.id,
                              { discountReason: e.target.value as DiscountReasonValue | "" },
                              item.selectedPackage?.id,
                            )
                          }
                        >
                          <option value="">—</option>
                          {DISCOUNT_REASONS.map((r) => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    {item.discountReason === "other" && (
                      <Input
                        className="h-8 text-xs mt-2"
                        placeholder="Describe other reason"
                        value={item.discountReasonOther}
                        onChange={(e) =>
                          updateLineDiscount(
                            item.id,
                            { discountReasonOther: e.target.value },
                            item.selectedPackage?.id,
                          )
                        }
                      />
                    )}
                    {item.selectedPackage && item.baseUnitsTotal && (
                      <div className="text-xs text-muted-foreground mt-1">
                        = {item.baseUnitsTotal} {item.unitOfMeasure}s total
                      </div>
                    )}
                    <div className="flex items-center justify-between mt-2 pt-2 border-t">
                      <span className="text-xs text-muted-foreground">Subtotal</span>
                      <div className="font-semibold font-mono tabular-nums text-[#E8B84B]">{formatCurrency(item.subtotal)}</div>
                    </div>
                    {item.discountAmount > 0 && (
                      <div className="text-xs mt-1 text-[#E8B84B] font-mono tabular-nums">
                        −{formatCurrency(item.discountAmount)} off list {formatCurrency(item.listPrice * item.cartQuantity)}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className="border-t mt-4 pt-4 space-y-3" data-checkout-section>
                {needsSupervisorApproval && (
                  <p className="text-xs text-[#F97316]">
                    Cart discount {cartDiscountPct.toFixed(1)}% exceeds {discountThreshold}% — supervisor PIN required at checkout.
                  </p>
                )}
                <div className="flex justify-between text-sm">
                  <span>Subtotal</span>
                  <span className="font-mono tabular-nums">{formatCurrency(total)}</span>
                </div>
                {taxRate > 0 && (
                  <div className="flex justify-between text-sm text-muted-foreground">
                    <span>Tax ({taxRate}%)</span>
                    <span>{formatCurrency(taxAmount)}</span>
                  </div>
                )}
                <div className="flex justify-between text-lg font-bold">
                  <span>Total</span>
                  <span>{formatCurrency(grandTotal)}</span>
                </div>

                <div className="space-y-2">
                  <label htmlFor="pos-payment" className="text-sm font-medium">Payment Method</label>
                  <select
                    id="pos-payment"
                    ref={paymentRef}
                    onKeyDown={(event) => handlePosEnterKeyDown(event, "paymentMethod")}
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value)}
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    title="Select Payment Method"
                    aria-label="Payment Method"
                  >
                    <option value="CASH">Cash</option>
                    <option value="CARD">Card</option>
                    <option value="MOBILE_MONEY">Mobile Money</option>
                    <option value="CREDIT">Credit (Buy Now, Pay Later)</option>
                  </select>
                </div>

                {paymentMethod === "CREDIT" && (
                  <div className="space-y-3 rounded-lg border border-[#E8B84B]/30 bg-[#E8B84B]/5 p-3">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Credit Customer</label>
                      <select
                        ref={creditCustomerRef}
                        onKeyDown={(event) => handlePosEnterKeyDown(event, "creditCustomer")}
                        value={creditCustomerId}
                        onChange={(e) => setCreditCustomerId(e.target.value)}
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        aria-label="Credit Customer"
                      >
                        <option value="">New or walk-in customer</option>
                        {creditCustomers.map((customer) => (
                          <option key={customer.id} value={customer.id}>
                            {customer.name}
                            {customer.phone ? ` (${customer.phone})` : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">Due Date (optional)</label>
                      <Input
                        ref={creditDueDateRef}
                        onKeyDown={(event) => handlePosEnterKeyDown(event, "creditDueDate")}
                        type="date"
                        value={creditDueDate}
                        onChange={(e) => setCreditDueDate(e.target.value)}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Sale total is added to the customer&apos;s credit balance. Record repayments in Credit Ledger.
                    </p>
                  </div>
                )}

                {paymentMethod === "CASH" && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium flex items-center">
                      <Calculator className="h-4 w-4 mr-1" />
                      Amount Paid (F5)
                    </label>
                    <Input
                      ref={amountPaidRef}
                      onKeyDown={(event) => handlePosEnterKeyDown(event, "amountPaid")}
                      type="number"
                      placeholder="Enter amount paid"
                      value={amountPaid}
                      onChange={(e) => setAmountPaid(e.target.value)}
                    />
                    {amountPaid && !isPartialPayment && settlement.amountPaid >= grandTotal && (
                      <div className="bg-green-50 border border-green-200 rounded-lg p-2">
                        <div className="flex justify-between text-green-800 font-semibold">
                          <span>Change</span>
                          <span>{formatCurrency(change)}</span>
                        </div>
                      </div>
                    )}
                    {isPartialPayment && (
                      <div className="bg-amber-50 border border-amber-300 rounded-lg p-2 space-y-1">
                        <div className="flex justify-between text-amber-900 text-sm font-semibold">
                          <span>Paid now</span>
                          <span>{formatCurrency(settlement.amountPaid)}</span>
                        </div>
                        <div className="flex justify-between text-amber-900 text-sm font-bold">
                          <span>BALANCE DUE</span>
                          <span>{formatCurrency(balanceDue)}</span>
                        </div>
                        <p className="text-xs text-amber-800">
                          Sale will complete. Balance is recorded on the customer account and printed on the receipt.
                          Customer name is required (Alt+C).
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <Button
                  ref={completeSaleRef}
                  onClick={handleCompleteSale}
                  className="w-full"
                  disabled={isProcessing || cart.length === 0}
                  aria-busy={isProcessing}
                >
                  {isProcessing ? "Processing..." : "Complete Sale (F8 / Ctrl+A)"}
                </Button>

                <Button
                  onClick={saveAsOrder}
                  variant="outline"
                  className="w-full"
                  disabled={cart.length === 0}
                >
                  <Clock className="h-4 w-4 mr-2" />
                  Save as Order (F9)
                </Button>

                {/* Tally-style shortcut strip */}
                <div
                  className="rounded-lg border border-border bg-muted/40 p-2"
                  aria-label="Keyboard shortcuts"
                >
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Tally shortcuts
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {POS_SHORTCUT_CHEATSHEET.map((row) => (
                      <span
                        key={row.keys}
                        className="inline-flex items-center gap-1 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground"
                      >
                        <kbd className="font-mono font-semibold text-[#F97316]">{row.keys}</kbd>
                        <span className="text-muted-foreground">{row.label}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Floating Cart Button for Mobile */}
      <button
        onClick={() => setShowMobileCart(!showMobileCart)}
        className="lg:hidden fixed bottom-6 right-6 z-50 bg-gradient-to-r from-[#F97316] to-[#E8B84B] text-white p-4 rounded-full shadow-2xl hover:shadow-[#F97316]/30 transition-all duration-300 hover:scale-110 active:scale-95"
        aria-label="Shopping Cart"
      >
        <div className="relative">
          <ShoppingCart className="h-6 w-6" />
          {cart.length > 0 && (
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold rounded-full h-5 w-5 flex items-center justify-center animate-pulse">
              {cart.length}
            </span>
          )}
        </div>
      </button>

      {/* Mobile Cart Modal */}
      {showMobileCart && (
        <div className="lg:hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-end">
          <div className="bg-card w-full max-h-[85vh] rounded-t-3xl overflow-hidden flex flex-col animate-in slide-in-from-bottom duration-300">
            {/* Mobile Cart Header */}
            <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-[#F97316] to-[#E8B84B] text-white">
              <h3 className="text-lg font-bold flex items-center gap-2">
                <ShoppingCart className="h-5 w-5" />
                Cart ({cart.length})
              </h3>
              <button
                onClick={() => setShowMobileCart(false)}
                className="p-2 hover:bg-card/20 rounded-full transition-colors"
              >
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Mobile Cart Content */}
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {cart.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <ShoppingCart className="h-16 w-16 mx-auto mb-4 opacity-30" />
                  <p>Your cart is empty</p>
                </div>
              ) : (
                cart.map((item) => (
                  <div key={item.id} className="bg-muted/20 rounded-xl p-3 border">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1 min-w-0">
                        <h4 className="font-semibold text-sm truncate">{item.name}</h4>
                        <p className="text-xs text-muted-foreground">{item.sku}</p>
                      </div>
                      <button
                        onClick={() => removeFromCart(item.id)}
                        className="ml-2 p-1 text-destructive hover:bg-red-50 rounded"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => updateCartQuantity(item.id, item.cartQuantity - 1)}
                          className="w-8 h-8 bg-card border rounded-lg flex items-center justify-center hover:bg-muted/30 active:scale-95"
                        >
                          -
                        </button>
                        <input
                          type="number"
                          value={item.cartQuantity}
                          onChange={(e) => updateCartQuantity(item.id, parseInt(e.target.value) || 1)}
                          className="w-14 h-8 text-center border rounded-lg font-semibold"
                        />
                        <button
                          onClick={() => updateCartQuantity(item.id, item.cartQuantity + 1)}
                          className="w-8 h-8 bg-card border rounded-lg flex items-center justify-center hover:bg-muted/30 active:scale-95"
                        >
                          +
                        </button>
                      </div>
                      <div className="text-right">
                        <p className="text-xs text-muted-foreground">
                          @ {formatCurrency(item.sellingPrice)}
                        </p>
                        <p className="font-bold text-green-700 dark:text-[#22C55E]">
                          {formatCurrency(item.subtotal)}
                        </p>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Mobile Cart Footer */}
            {cart.length > 0 && (
              <div className="border-t p-4 bg-card space-y-3">
                <div className="flex justify-between items-center text-lg font-bold">
                  <span>Total:</span>
                  <span className="text-green-700 dark:text-[#22C55E]">
                    {formatCurrency(cart.reduce((sum, item) => sum + item.subtotal, 0))}
                  </span>
                </div>
                <button
                  onClick={() => {
                    setShowMobileCart(false)
                    // Scroll to checkout section
                    const checkoutSection = document.querySelector('[data-checkout-section]')
                    checkoutSection?.scrollIntoView({ behavior: 'smooth' })
                  }}
                  className="w-full bg-gradient-to-r from-[#F97316] to-[#E8B84B] text-white py-3 rounded-xl font-semibold hover:shadow-lg active:scale-95 transition-all"
                >
                  Proceed to Checkout
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

interface SaveOrderDialogProps {
  cart: CartItem[]
  onClose: () => void
  onSuccess: () => void
}

function SaveOrderDialog({ cart, onClose, onSuccess }: SaveOrderDialogProps) {
  const [customers, setCustomers] = useState<any[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState("")
  const [notes, setNotes] = useState("")
  const [deliveryAddress, setDeliveryAddress] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  useEffect(() => {
    fetchCustomers()
  }, [])

  const fetchCustomers = async () => {
    try {
      const response = await fetch("/api/admin/customers")
      const data = await response.json()
      if (Array.isArray(data)) {
        setCustomers(data)
      } else {
        setCustomers([])
      }
    } catch (error) {
      console.error("Failed to fetch customers:", error)
      setCustomers([])
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!selectedCustomer) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please select a customer",
      })
      return
    }

    setIsLoading(true)

    try {
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: selectedCustomer,
          items: cart.map((item) => ({
            productId: item.id,
            quantity: item.cartQuantity,
          })),
          notes,
          deliveryAddress,
        }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Order saved successfully",
        })
        onSuccess()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to save order",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred",
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Save as Order</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customer">Customer *</Label>
              <select
                id="customer"
                value={selectedCustomer}
                onChange={(e) => setSelectedCustomer(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                required
                title="Select Customer"
              >
                <option value="">Select Customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name} - {customer.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="deliveryAddress">Delivery Address</Label>
              <Input
                id="deliveryAddress"
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>

            <div className="border-t pt-4">
              <div className="text-sm space-y-1 mb-3">
                <div className="flex justify-between">
                  <span>Items:</span>
                  <span>{cart.length}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Total:</span>
                  <span>{formatCurrency(cart.reduce((sum, item) => sum + item.subtotal, 0))}</span>
                </div>
              </div>
            </div>

            <div className="flex justify-end space-x-2">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Saving..." : "Save Order"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

interface ReceiptPreviewDialogProps {
  cart: CartItem[]
  settings: Settings | null
  total: number
  taxRate: number
  taxAmount: number
  grandTotal: number
  amountPaid: string
  change: number
  balanceDue?: number
  paymentMethod: string
  staffName: string
  onClose: () => void
}

function ReceiptPreviewDialog({
  cart,
  settings,
  total,
  taxRate,
  taxAmount,
  grandTotal,
  amountPaid,
  change,
  balanceDue = 0,
  paymentMethod,
  staffName,
  onClose,
}: ReceiptPreviewDialogProps) {
  const currency    = settings?.currency    || "UGX"
  const pharmName   = settings?.pharmacyName || "SYNAPSE Pharm"
  const location    = settings?.location    || ""
  const contact     = settings?.contact     || ""
  const email       = settings?.email       || ""
  const footer      = settings?.footerText  || "Thank you for your purchase!"
  const paperWidth  = (settings?.receiptPaperWidth || "80").toLowerCase()
  const fontScale   = settings?.receiptFontScale && settings.receiptFontScale > 0 ? settings.receiptFontScale : 1
  const now         = new Date()
  const dateStr     = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  const timeStr     = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  const fmt         = (n: number) => formatCurrency(n, currency)
  const amtPaidNum  = amountPaid ? parseFloat(amountPaid) : 0

  const handlePrint = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setTimeout(() => window.print(), 50)
      })
    })
  }

  return (
    <div className="fixed inset-0 bg-black/80 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="w-full max-w-sm my-8">
        {/* Screen chrome — hidden on print (must be sibling of print-area, not parent) */}
        <div className="no-print flex items-center justify-between mb-3 px-1">
          <span className="text-white font-semibold flex items-center gap-2">
            <Printer className="h-4 w-4" /> Receipt Preview
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            <Button size="sm" onClick={handlePrint}>
              <Printer className="h-4 w-4 mr-2" />
              Print Receipt
            </Button>
          </div>
        </div>

        {/* Thermal receipt preview — matches exact print output */}
        <div className="print-area rounded shadow-lg overflow-hidden">
          <div
            className={`thermal-receipt paper-${paperWidth === "58" || paperWidth === "a4" ? paperWidth : "80"}`}
            style={{ ["--receipt-font-scale" as string]: String(fontScale) }}
          >
            {/* Header */}
            {settings?.logo && (
              <div className="tr-center" style={{ padding: "2px 0" }}>
                <img 
                  src={settings.logo} 
                  alt={`${pharmName} logo`} 
                  style={{ 
                    maxWidth: paperWidth === "58" ? "90px" : paperWidth === "a4" ? "160px" : "110px",
                    maxHeight: "32px",
                    objectFit: "contain",
                    margin: "0 auto",
                    display: "block"
                  }} 
                />
              </div>
            )}
            <p className="tr-center tr-bold tr-lg">{pharmName}</p>
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

            {/* Meta */}
            <div className="tr-row"><span>Receipt #</span><span>TXN-PREVIEW</span></div>
            <div className="tr-row"><span>Date / time</span><span>{dateStr} {timeStr}</span></div>

            {/* Items */}
            <div className="tr-dash" />
            <div className="tr-row tr-bold tr-sm"><span>ITEM</span><span>AMOUNT</span></div>
            <div className="tr-dash" />

            {cart.map((item, idx) => {
              const qty = item.baseUnitsTotal || item.cartQuantity
              const qtyLabel = item.selectedPackage
                ? `${item.cartQuantity} ${item.selectedPackage.name} (${qty} ${item.dosageForm || "units"})`
                : `${item.cartQuantity} ${item.dosageForm || item.unitOfMeasure || "unit"}${item.cartQuantity !== 1 ? "s" : ""}`
              return (
                <div key={`${item.id}-${idx}`} className="tr-item print-no-break">
                  <p className="tr-bold">{item.name}{item.strength ? ` ${item.strength}` : ""}</p>
                  <div className="tr-row">
                    <span className="tr-sm tr-muted">{qtyLabel} @ {fmt(item.sellingPrice)}</span>
                    <span className="tr-bold">{fmt(item.subtotal)}</span>
                  </div>
                  {item.batchNumber && (
                    <p className="tr-sm tr-muted">
                      Batch: {item.batchNumber}
                      {item.expiryDate ? `  Exp: ${new Date(item.expiryDate).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}` : ""}
                    </p>
                  )}
                </div>
              )
            })}

            {/* Totals */}
            <div className="tr-heavy" />
            {taxAmount > 0 && (
              <>
                <div className="tr-row"><span>Subtotal</span><span>{fmt(total)}</span></div>
                <div className="tr-row"><span>Tax ({taxRate}%)</span><span>{fmt(taxAmount)}</span></div>
                <div className="tr-dash" />
              </>
            )}
            <div className="tr-row tr-bold tr-lg"><span>TOTAL</span><span>{fmt(grandTotal)}</span></div>
            <div className="tr-heavy" />

            {/* Payment */}
            <div className="tr-row">
              <span>Payment</span>
              <span>{formatPaymentLabel(paymentMethod)}</span>
            </div>
            {paymentMethod === "CREDIT" && (
              <div className="tr-row tr-sm">
                <span>Status</span>
                <span>On Account — balance due</span>
              </div>
            )}
            {(paymentMethod === "CASH" || paymentMethod === "MOBILE_MONEY" || paymentMethod === "CARD") && amtPaidNum >= 0 && (
              <>
                <div className="tr-row"><span>Received</span><span>{fmt(amtPaidNum)}</span></div>
                {balanceDue > 0 ? (
                  <div className="tr-row tr-bold"><span>BALANCE DUE</span><span>{fmt(balanceDue)}</span></div>
                ) : (
                  <div className="tr-row tr-bold"><span>Change</span><span>{fmt(Math.max(0, change))}</span></div>
                )}
              </>
            )}

            {/* Footer */}
            <div className="tr-dash" />
            <p className="tr-center tr-sm">By: <strong>{staffName}</strong></p>
            {footer && <p className="tr-center tr-sm">{footer}</p>}
            <div className="tr-dash" />
          </div>
        </div>
      </div>
    </div>
  )
}

function TransactionReceipt({
  transaction,
  staffName,
  settings,
  meta,
}: {
  transaction: any
  staffName: string
  settings: Settings | null
  meta: { paymentMethod: string; amountPaid: string; change: number; balanceDue?: number } | null
}) {
  const currency   = settings?.currency    || "UGX"
  const pharmName  = settings?.pharmacyName || "SYNAPSE Pharm"
  const location   = settings?.location    || ""
  const contact    = settings?.contact     || ""
  const email      = settings?.email       || ""
  const footer     = settings?.footerText  || "Thank you for your purchase!"
  const paperWidth = (settings?.receiptPaperWidth || "80").toLowerCase()
  const fontScale  = settings?.receiptFontScale && settings.receiptFontScale > 0 ? settings.receiptFontScale : 1

  const receiptDate = transaction?.createdAt ? new Date(transaction.createdAt) : new Date()
  const items       = Array.isArray(transaction?.items) ? transaction.items : []

  const subtotal   = typeof transaction?.totalAmount === "number" ? transaction.totalAmount : 0
  const taxAmount  = typeof transaction?.tax         === "number" ? transaction.tax         : 0
  const grandTotal = typeof transaction?.netAmount   === "number" ? transaction.netAmount   : subtotal + taxAmount
  const payment    = meta?.paymentMethod || transaction?.paymentMethod || ""
  const amtPaid    = meta?.amountPaid ? parseFloat(meta.amountPaid) : 0
  const change     = meta?.change ?? 0
  const balanceDue = meta?.balanceDue ?? Math.max(0, grandTotal - amtPaid)

  const fmt = (n: number) => formatCurrency(n, currency)
  const dateStr = receiptDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
  const timeStr = receiptDate.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

  const receiptText = (value: unknown) => {
    const text = value == null ? "" : String(value).trim()
    return ["", "-", "—", "n/a", "null"].includes(text.toLowerCase()) ? "" : text
  }
  const clientName = receiptText(transaction?.clientName)
  const clientPhone = receiptText(transaction?.clientPhone)
  const clientAddress = receiptText(transaction?.clientAddress)
  const hasClient = Boolean(clientName || clientPhone || clientAddress)

  return (
    <div
      className={`thermal-receipt paper-${paperWidth === "58" || paperWidth === "a4" ? paperWidth : "80"}`}
      style={{ ["--receipt-font-scale" as string]: String(fontScale) }}
    >

      {/* ── Header ── */}
      {settings?.logo && (
        <div className="tr-center" style={{ padding: "2px 0" }}>
          <img 
            src={settings.logo} 
            alt={`${pharmName} logo`} 
            style={{ 
              maxWidth: paperWidth === "58" ? "90px" : paperWidth === "a4" ? "160px" : "110px",
              maxHeight: "32px",
              objectFit: "contain",
              margin: "0 auto",
              display: "block"
            }} 
          />
        </div>
      )}
      <p className="tr-center tr-bold tr-lg tr-brand">{pharmName}</p>
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

      {/* ── Transaction meta ── */}
      <div className="tr-row"><span>Receipt #</span><span>{transaction?.transactionNo || "—"}</span></div>
      <div className="tr-row"><span>Date / time</span><span>{dateStr} {timeStr}</span></div>

      {/* ── Client info ── */}
      {hasClient && (
        <>
          <div className="tr-dash" />
          {clientName && <div className="tr-row"><span>Client</span><span>{clientName}</span></div>}
          {clientPhone && <div className="tr-row"><span>Phone</span><span>{clientPhone}</span></div>}
          {clientAddress && <div className="tr-row"><span>Address</span><span>{clientAddress}</span></div>}
        </>
      )}

      {/* ── Items ── */}
      <div className="tr-dash" />
      <div className="tr-row tr-bold tr-sm">
        <span>ITEM</span><span>AMOUNT</span>
      </div>
      <div className="tr-dash" />

      {items.map((item: any, idx: number) => {
        const name       = item.product?.name     || "—"
        const strength   = item.product?.strength || ""
        const form       = item.product?.dosageForm || ""
        const qty        = item.quantity ?? 0
        const unitPrice  = item.unitPrice  ?? 0
        const totalPrice = item.totalPrice ?? 0

        // Label: "2 Strips (20 tabs)" or "11 Tablets"
        const qtyLabel = item.packageName
          ? `${item.packageQuantity ?? ""} ${item.packageName} (${qty} ${form || "units"})`
          : `${qty} ${form || "unit"}${qty !== 1 ? "s" : ""}`

        return (
          <div key={item.id ?? idx} className="tr-item print-no-break">
            <p className="tr-bold">{name}{strength ? ` ${strength}` : ""}</p>
            <div className="tr-row">
              <span className="tr-sm tr-muted">{qtyLabel} @ {fmt(unitPrice)}</span>
              <span className="tr-bold">{fmt(totalPrice)}</span>
            </div>
            {(item.batch?.batchNumber || item.batch?.expiryDate) && (
              <p className="tr-sm tr-muted">
                {item.batch?.batchNumber ? `Batch: ${item.batch.batchNumber}` : ""}
                {item.batch?.expiryDate
                  ? `  Exp: ${new Date(item.batch.expiryDate).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })}`
                  : ""}
              </p>
            )}
          </div>
        )
      })}

      {/* ── Totals ── */}
      <div className="tr-heavy" />
      {taxAmount > 0 && (
        <>
          <div className="tr-row"><span>Subtotal</span><span>{fmt(subtotal)}</span></div>
          <div className="tr-row"><span>Tax</span><span>{fmt(taxAmount)}</span></div>
          <div className="tr-dash" />
        </>
      )}
      <div className="tr-row tr-bold tr-lg">
        <span>TOTAL</span><span>{fmt(grandTotal)}</span>
      </div>
      <div className="tr-heavy" />

      {/* ── Payment ── */}
      <div className="tr-row">
        <span>Payment</span>
        <span>{formatPaymentLabel(payment)}</span>
      </div>
      {payment === "CREDIT" && (
        <div className="tr-row tr-sm">
          <span>Status</span>
          <span>On Account — balance due</span>
        </div>
      )}
      {(payment === "CASH" || payment === "MOBILE_MONEY" || payment === "CARD" || payment.includes("CASH")) && (
        <>
          <div className="tr-row"><span>Received</span><span>{fmt(amtPaid)}</span></div>
          {balanceDue > 0 ? (
            <div className="tr-row tr-bold"><span>BALANCE DUE</span><span>{fmt(balanceDue)}</span></div>
          ) : (
            <div className="tr-row tr-bold"><span>Change</span><span>{fmt(Math.max(0, change))}</span></div>
          )}
        </>
      )}
      {payment === "CREDIT" && (
        <div className="tr-row tr-bold"><span>BALANCE DUE</span><span>{fmt(grandTotal)}</span></div>
      )}

      {/* ── Footer ── */}
      <div className="tr-dash" />
      <p className="tr-center tr-sm">By: <strong>{staffName}</strong></p>
      {footer && <p className="tr-center tr-sm">{footer}</p>}
      <div className="tr-dash" />
    </div>
  )
}
