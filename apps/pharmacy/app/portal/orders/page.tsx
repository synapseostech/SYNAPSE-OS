"use client"

import { useEffect, useState } from "react"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"

// Force dynamic rendering
export const dynamic = 'force-dynamic'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { formatCurrency } from "@/lib/utils"
import { escapeHtml } from "@/lib/html"
import { Plus, Search, Eye, CheckCircle, XCircle, Clock, DollarSign, Truck, ShoppingBag, Printer, CreditCard, Trash2, MessageSquare, HandMetal, User, Globe } from "lucide-react"

interface Order {
  id: string
  orderNo: string
  orderType: string
  totalAmount: number
  status: string
  paymentStatus: string
  notes?: string
  deliveryAddress?: string
  createdAt: string
  isOnlineOrder?: boolean
  claimedBy?: string
  claimedAt?: string
  customer?: {
    name: string
    email: string
    phone?: string
  }
  items: Array<{
    id: string
    productName: string
    quantity: number
    unitPrice: number
    totalPrice: number
    product?: {
      name: string
      sku: string
      unitOfMeasure: string
    }
  }>
  processedByUser?: {
    name: string
  }
  claimedByUser?: {
    name: string
  }
}

interface OrderStats {
  pending: number
  completed: number
  cancelled: number
  totalRevenue: number
  supplierOrders: number
  customerOrders: number
  onlineOrders: number
  unclaimedOrders: number
}

export default function OrdersPage() {
  const { user } = usePharmacySession()
  const [orders, setOrders] = useState<Order[]>([])
  const [filteredOrders, setFilteredOrders] = useState<Order[]>([])
  const [stats, setStats] = useState<OrderStats>({ pending: 0, completed: 0, cancelled: 0, totalRevenue: 0, supplierOrders: 0, customerOrders: 0, onlineOrders: 0, unclaimedOrders: 0 })
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [typeFilter, setTypeFilter] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [showCustomerOrderDialog, setShowCustomerOrderDialog] = useState(false)
  const [showSupplierOrderDialog, setShowSupplierOrderDialog] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [showInquiryDialog, setShowInquiryDialog] = useState<{ type: string; entityId: string; entityName: string } | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    fetchOrders()
  }, [])

  useEffect(() => {
    let filtered = [...orders]

    if (searchQuery) {
      filtered = filtered.filter(
        (order) =>
          order.orderNo.toLowerCase().includes(searchQuery.toLowerCase()) ||
          (order.customer?.name && order.customer.name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
    }

    if (statusFilter) {
      filtered = filtered.filter((order) => order.status === statusFilter)
    }

    if (typeFilter) {
      filtered = filtered.filter((order) => order.orderType === typeFilter)
    }

    setFilteredOrders(filtered)
  }, [searchQuery, statusFilter, typeFilter, orders])

  const fetchOrders = async () => {
    try {
      const response = await fetch("/api/admin/orders")
      const data = await response.json()
      if (data.orders && Array.isArray(data.orders)) {
        setOrders(data.orders)
        setFilteredOrders(data.orders)
        setStats(data.stats)
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch orders",
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleStatusChange = async (orderId: string, newStatus: string) => {
    try {
      const response = await fetch("/api/admin/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: orderId, status: newStatus }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Order ${newStatus.toLowerCase()} successfully`,
        })
        fetchOrders()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to update order",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred",
      })
    }
  }

  const handleDeleteOrder = async (orderId: string, orderNo: string) => {
    if (!confirm(`Are you sure you want to delete order ${orderNo}? This action cannot be undone.`)) {
      return
    }

    try {
      const response = await fetch(`/api/admin/orders?id=${orderId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Order ${orderNo} deleted successfully`,
        })
        fetchOrders()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to delete order",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred",
      })
    }
  }

  const handleClaimOrder = async (orderId: string, orderNo: string) => {
    try {
      const response = await fetch("/api/admin/orders/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId }),
      })

      if (response.ok) {
        const data = await response.json()
        toast({
          title: "Order Claimed!",
          description: `You are now handling order ${orderNo}`,
        })
        fetchOrders()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Cannot Claim Order",
          description: data.error || "Failed to claim order",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred while claiming the order",
      })
    }
  }

  const handleUnclaimOrder = async (orderId: string, orderNo: string) => {
    if (!confirm(`Are you sure you want to release order ${orderNo}? It will become available for others to claim.`)) {
      return
    }

    try {
      const response = await fetch(`/api/admin/orders/claim?orderId=${orderId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        toast({
          title: "Order Released",
          description: `Order ${orderNo} is now available for claiming`,
        })
        fetchOrders()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to release order",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred",
      })
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "PENDING":
        return <Clock className="h-4 w-4" />
      case "COMPLETED":
        return <CheckCircle className="h-4 w-4" />
      case "CANCELLED":
        return <XCircle className="h-4 w-4" />
      default:
        return <Clock className="h-4 w-4" />
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "PENDING":
        return "bg-yellow-500/15 text-yellow-400"
      case "COMPLETED":
        return "bg-green-500/15 text-[#22C55E]"
      case "CANCELLED":
        return "bg-red-500/15 text-destructive"
      default:
        return "bg-muted/30 text-foreground"
    }
  }

  const getPaymentColor = (status: string) => {
    switch (status) {
      case "PAID":
        return "bg-green-500/15 text-[#22C55E]"
      case "PARTIAL":
        return "bg-yellow-500/15 text-yellow-400"
      case "UNPAID":
        return "bg-red-500/15 text-destructive"
      default:
        return "bg-muted/30 text-foreground"
    }
  }

  return (
    <div className="px-0">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Orders Management</h1>
          <p className="text-muted-foreground mt-1 sm:mt-2 text-sm sm:text-base">Manage customer orders and supplier requisitions</p>
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button variant="outline" onClick={() => setShowSupplierOrderDialog(true)} className="flex-1 sm:flex-none text-xs sm:text-sm px-2 sm:px-4">
            <Truck className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Supplier Requisition</span>
            <span className="sm:hidden">Requisition</span>
          </Button>
          <Button onClick={() => setShowCustomerOrderDialog(true)} className="flex-1 sm:flex-none text-xs sm:text-sm px-2 sm:px-4">
            <ShoppingBag className="h-4 w-4 sm:mr-2" />
            <span className="hidden sm:inline">Customer Order</span>
            <span className="sm:hidden">Order</span>
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 sm:gap-4 mb-6">
        <Card className="border-l-4 border-l-yellow-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Pending</CardTitle>
            <Clock className="h-4 w-4 text-yellow-400" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.pending}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-orange-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Unclaimed</CardTitle>
            <HandMetal className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.unclaimedOrders}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-green-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Completed</CardTitle>
            <CheckCircle className="h-4 w-4 text-[#22C55E]" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.completed}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-red-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Cancelled</CardTitle>
            <XCircle className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.cancelled}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-cyan-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Online</CardTitle>
            <Globe className="h-4 w-4 text-cyan-600" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.onlineOrders}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-blue-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Customer</CardTitle>
            <ShoppingBag className="h-4 w-4 text-blue-400" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.customerOrders}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-purple-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Supplier</CardTitle>
            <Truck className="h-4 w-4 text-purple-400" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-xl sm:text-2xl font-bold">{stats.supplierOrders}</div>
          </CardContent>
        </Card>
        <Card className="border-l-4 border-l-emerald-500">
          <CardHeader className="flex flex-row items-center justify-between pb-1 sm:pb-2 p-3 sm:p-6">
            <CardTitle className="text-xs sm:text-sm font-medium">Revenue</CardTitle>
            <DollarSign className="h-4 w-4 text-emerald-600" />
          </CardHeader>
          <CardContent className="p-3 sm:p-6 pt-0">
            <div className="text-sm sm:text-lg font-bold truncate">{formatCurrency(stats.totalRevenue)}</div>
          </CardContent>
        </Card>
      </div>

      {showCustomerOrderDialog && (
        <CustomerOrderDialog
          onClose={() => setShowCustomerOrderDialog(false)}
          onSuccess={() => {
            setShowCustomerOrderDialog(false)
            fetchOrders()
          }}
        />
      )}

      {showSupplierOrderDialog && (
        <SupplierOrderDialog
          onClose={() => setShowSupplierOrderDialog(false)}
          onSuccess={() => {
            setShowSupplierOrderDialog(false)
            fetchOrders()
          }}
        />
      )}

      {selectedOrder && (
        <OrderDetailsDialog
          order={selectedOrder}
          onClose={() => setSelectedOrder(null)}
          onStatusChange={handleStatusChange}
          onRefresh={fetchOrders}
        />
      )}

      {showInquiryDialog && user && (
        <InquiryDialog
          userId={user.id}
          userEmail={user.email ?? ""}
          userName={user.fullName ?? ""}
          inquiryType={showInquiryDialog.type}
          entityId={showInquiryDialog.entityId}
          entityName={showInquiryDialog.entityName}
          onClose={() => setShowInquiryDialog(null)}
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
            <CardTitle>Orders ({filteredOrders.length})</CardTitle>
            <div className="flex flex-wrap gap-2">
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                title="Filter by Type"
                aria-label="Filter by Type"
              >
                <option value="">All Types</option>
                <option value="CUSTOMER">Customer Orders</option>
                <option value="SUPPLIER">Supplier Requisitions</option>
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm"
                title="Filter by Status"
                aria-label="Filter by Status"
              >
                <option value="">All Status</option>
                <option value="PENDING">Pending</option>
                <option value="COMPLETED">Completed</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
              <div className="relative w-48">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search orders..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Order #</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Customer/Supplier</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Claimed By</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredOrders.map((order) => (
                <TableRow key={order.id} className={order.isOnlineOrder && !order.claimedBy && order.status === "PENDING" ? "bg-orange-50" : ""}>
                  <TableCell className="font-medium">
                    <div className="flex items-center gap-2">
                      {order.orderNo}
                      {order.isOnlineOrder && (
                        <span className="px-1.5 py-0.5 text-[10px] rounded bg-cyan-100 text-cyan-700 font-medium">
                          ONLINE
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className={`px-2 py-1 text-xs rounded-full ${order.orderType === 'CUSTOMER' ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'}`}>
                      {order.orderType === 'CUSTOMER' ? <ShoppingBag className="h-3 w-3 inline mr-1" /> : <Truck className="h-3 w-3 inline mr-1" />}
                      {order.orderType}
                    </span>
                  </TableCell>
                  <TableCell>
                    {order.orderType === 'CUSTOMER' && order.customer ? (
                      <div>
                        <div className="font-medium">{order.customer.name}</div>
                        <div className="text-xs text-muted-foreground">{order.customer.phone || order.customer.email}</div>
                      </div>
                    ) : (
                      <span className="text-muted-foreground">Supplier Order</span>
                    )}
                  </TableCell>
                  <TableCell>{(order.items ?? []).length} items</TableCell>
                  <TableCell className="font-semibold">{formatCurrency(order.totalAmount)}</TableCell>
                  <TableCell>
                    {order.claimedByUser ? (
                      <div className="flex items-center gap-1">
                        <User className="h-3 w-3 text-[#22C55E]" />
                        <span className="text-sm text-[#22C55E] font-medium">{order.claimedByUser.name}</span>
                      </div>
                    ) : order.isOnlineOrder && order.status === "PENDING" ? (
                      <span className="text-xs text-primary font-medium">Unclaimed</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={`px-2 py-1 text-xs rounded-full ${getPaymentColor(order.paymentStatus)}`}>
                      {order.paymentStatus}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className={`px-2 py-1 text-xs rounded-full flex items-center gap-1 w-fit ${getStatusColor(order.status)}`}>
                      {getStatusIcon(order.status)}
                      {order.status}
                    </span>
                  </TableCell>
                  <TableCell>{new Date(order.createdAt).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {/* Claim button for unclaimed online orders */}
                      {order.isOnlineOrder && !order.claimedBy && order.status === "PENDING" && (
                        <Button
                          variant="default"
                          size="sm"
                          onClick={() => handleClaimOrder(order.id, order.orderNo)}
                          className="bg-green-600 hover:bg-green-700"
                        >
                          <HandMetal className="h-4 w-4 mr-1" />
                          Claim
                        </Button>
                      )}
                      {/* Unclaim button for claimed orders (only for claimer or admin) */}
                      {order.claimedBy && (order.claimedBy === user?.id || user?.pharmacyRole === "pharmacy_admin" || user?.pharmacyRole === "pharmacy_ceo") && order.status !== "COMPLETED" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleUnclaimOrder(order.id, order.orderNo)}
                          className="text-primary hover:text-orange-700"
                        >
                          Release
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setSelectedOrder(order)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      {user?.pharmacyRole === "pharmacy_admin" && order.status !== "COMPLETED" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeleteOrder(order.id, order.orderNo)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                      {user?.pharmacyRole === "pharmacy_staff" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowInquiryDialog({ type: "DELETE_REQUEST", entityId: order.id, entityName: order.orderNo })}
                          title="Request deletion"
                          className="text-primary hover:text-orange-700"
                        >
                          <MessageSquare className="h-4 w-4" />
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
    </div>
  )
}

interface CustomerOrderDialogProps {
  onClose: () => void
  onSuccess: () => void
}

function CustomerOrderDialog({ onClose, onSuccess }: CustomerOrderDialogProps) {
  const [customers, setCustomers] = useState<any[]>([])
  const [products, setProducts] = useState<any[]>([])
  const [selectedCustomer, setSelectedCustomer] = useState("")
  const [customerName, setCustomerName] = useState("")
  const [customerPhone, setCustomerPhone] = useState("")
  const [orderItems, setOrderItems] = useState<Array<{ productId: string; productName: string; quantity: number; unitPrice: number }>>([])
  const [notes, setNotes] = useState("")
  const [deliveryAddress, setDeliveryAddress] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [productSearch, setProductSearch] = useState("")
  const [showProductDropdown, setShowProductDropdown] = useState<number | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    fetchCustomers()
    fetchProducts()
  }, [])

  const fetchCustomers = async () => {
    try {
      const response = await fetch("/api/admin/customers")
      const data = await response.json()
      if (Array.isArray(data)) setCustomers(data)
    } catch (error) {
      console.error("Failed to fetch customers:", error)
    }
  }

  const fetchProducts = async () => {
    try {
      const response = await fetch("/api/admin/inventory")
      const data = await response.json()
      if (Array.isArray(data)) setProducts(data.filter((p: any) => p.quantity > 0))
    } catch (error) {
      console.error("Failed to fetch products:", error)
    }
  }

  const addItem = () => {
    setOrderItems([...orderItems, { productId: "", productName: "", quantity: 1, unitPrice: 0 }])
  }

  const removeItem = (index: number) => {
    setOrderItems(orderItems.filter((_, i) => i !== index))
  }

  const updateItem = (index: number, field: string, value: any) => {
    const updated = [...orderItems]
    updated[index] = { ...updated[index], [field]: value }
    
    if (field === "productId") {
      const product = products.find(p => p.id === value)
      if (product) {
        updated[index].productName = product.name
        updated[index].unitPrice = product.price
      }
    }
    
    setOrderItems(updated)
  }

  const filteredProducts = products.filter(p => 
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    p.sku.toLowerCase().includes(productSearch.toLowerCase())
  )

  const totalAmount = orderItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if ((!selectedCustomer && !customerName) || orderItems.length === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please provide customer info and add at least one item",
      })
      return
    }

    setIsLoading(true)

    try {
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customerId: selectedCustomer || null,
          customerName: customerName,
          customerPhone: customerPhone,
          orderType: "CUSTOMER",
          items: orderItems.map(item => ({
            productId: item.productId,
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
          notes,
          deliveryAddress,
        }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Customer order created successfully",
        })
        onSuccess()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to create order",
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
      <Card className="w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle className="flex items-center">
            <ShoppingBag className="h-5 w-5 mr-2" />
            Create Customer Order (Call-in)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Customer Selection */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="customer">Select Existing Customer</Label>
                <select
                  id="customer"
                  value={selectedCustomer}
                  onChange={(e) => setSelectedCustomer(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  title="Select Customer"
                >
                  <option value="">-- Or enter new customer below --</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name} - {customer.phone || customer.email}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>OR New Customer Name</Label>
                <Input
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                  placeholder="Customer name"
                  disabled={!!selectedCustomer}
                />
              </div>
              <div className="space-y-2">
                <Label>Customer Phone</Label>
                <Input
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                  placeholder="Phone number"
                  disabled={!!selectedCustomer}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="deliveryAddress">Delivery Address</Label>
                <Input
                  id="deliveryAddress"
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  placeholder="Optional"
                />
              </div>
            </div>

            {/* Order Items with Search */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Order Items *</Label>
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Item
                </Button>
              </div>
              
              {orderItems.map((item, index) => (
                <div key={index} className="flex gap-2 items-end border p-3 rounded-lg">
                  <div className="flex-1 relative">
                    <Label className="text-xs">Product (search by name or SKU)</Label>
                    <Input
                      placeholder="Search products..."
                      value={showProductDropdown === index ? productSearch : item.productName}
                      onChange={(e) => {
                        setProductSearch(e.target.value)
                        setShowProductDropdown(index)
                      }}
                      onFocus={() => {
                        setShowProductDropdown(index)
                        setProductSearch(item.productName)
                      }}
                    />
                    {showProductDropdown === index && (
                      <div className="absolute z-10 w-full mt-1 bg-card border rounded-lg shadow-lg max-h-48 overflow-y-auto">
                        {filteredProducts.length === 0 ? (
                          <div className="p-2 text-muted-foreground text-sm">No products found</div>
                        ) : (
                          filteredProducts.slice(0, 10).map((product) => (
                            <button
                              key={product.id}
                              type="button"
                              className="w-full text-left p-2 hover:bg-muted/30 text-sm"
                              onClick={() => {
                                updateItem(index, "productId", product.id)
                                setShowProductDropdown(null)
                                setProductSearch("")
                              }}
                            >
                              <div className="font-medium">{product.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {formatCurrency(product.price)} | Stock: {product.quantity}
                              </div>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <div className="w-20">
                    <Label className="text-xs">Qty</Label>
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(index, "quantity", parseInt(e.target.value) || 1)}
                    />
                  </div>
                  <div className="w-28">
                    <Label className="text-xs">Price</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={item.unitPrice}
                      onChange={(e) => updateItem(index, "unitPrice", parseFloat(e.target.value) || 0)}
                    />
                  </div>
                  <div className="w-28">
                    <Label className="text-xs">Total</Label>
                    <div className="h-10 flex items-center font-semibold">
                      {formatCurrency(item.quantity * item.unitPrice)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeItem(index)}
                  >
                    <XCircle className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>

            {/* Order Total */}
            <div className="bg-muted/20 p-4 rounded-lg">
              <div className="flex justify-between items-center text-lg font-bold">
                <span>Order Total:</span>
                <span>{formatCurrency(totalAmount)}</span>
              </div>
              <p className="text-sm text-muted-foreground mt-1">Payment will be collected when order is completed</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Special instructions, delivery time, etc."
              />
            </div>

            <div className="flex justify-end space-x-2 pt-4">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Creating..." : "Create Order (Hold)"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

interface SupplierOrderDialogProps {
  onClose: () => void
  onSuccess: () => void
}

interface PharmacySettings {
  pharmacyName: string
  location: string
  contact: string
  email: string
  logo?: string
  footerText?: string
}

function SupplierOrderDialog({ onClose, onSuccess }: SupplierOrderDialogProps) {
  const [orderItems, setOrderItems] = useState<Array<{ productName: string; quantity: number; unitPrice: number }>>([
    { productName: "", quantity: 1, unitPrice: 0 }
  ])
  const [notes, setNotes] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [settings, setSettings] = useState<PharmacySettings | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    fetchSettings()
  }, [])

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

  const addItem = () => {
    setOrderItems([...orderItems, { productName: "", quantity: 1, unitPrice: 0 }])
  }

  const removeItem = (index: number) => {
    if (orderItems.length > 1) {
      setOrderItems(orderItems.filter((_, i) => i !== index))
    }
  }

  const updateItem = (index: number, field: string, value: any) => {
    const updated = [...orderItems]
    updated[index] = { ...updated[index], [field]: value }
    setOrderItems(updated)
  }

  const totalAmount = orderItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    const validItems = orderItems.filter(item => item.productName.trim())
    
    if (validItems.length === 0) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please add at least one item",
      })
      return
    }

    setIsLoading(true)

    try {
      const response = await fetch("/api/admin/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orderType: "SUPPLIER",
          items: validItems.map(item => ({
            productName: item.productName,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
          notes,
        }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Supplier requisition created successfully",
        })
        onSuccess()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to create requisition",
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

  const printRequisition = () => {
    const printWindow = window.open("", "", "width=600,height=800")
    if (!printWindow) return

    const validItems = orderItems.filter(item => item.productName.trim())
    const pharmacyName = settings?.pharmacyName || "SYNAPSE Pharm"
    const location = settings?.location || ""
    const contact = settings?.contact || ""
    const email = settings?.email || ""

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Supplier Requisition</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; }
          .header { text-align: center; margin-bottom: 30px; border-bottom: 2px solid #333; padding-bottom: 20px; }
          .logo { max-width: 80px; height: auto; margin-bottom: 10px; }
          .pharmacy-name { font-size: 24px; font-weight: bold; margin: 5px 0; }
          .pharmacy-info { font-size: 12px; color: #666; }
          h1 { text-align: center; margin: 20px 0; font-size: 20px; }
          table { width: 100%; border-collapse: collapse; margin: 20px 0; }
          th, td { border: 1px solid #ddd; padding: 10px; text-align: left; }
          th { background-color: #f4f4f4; }
          .total { font-weight: bold; font-size: 1.2em; margin-top: 20px; }
          .footer { margin-top: 40px; }
          .signature-line { border-bottom: 1px solid #000; width: 200px; display: inline-block; margin-left: 10px; }
          .footer p { margin: 15px 0; }
          @media print {
            body { padding: 0; }
            .no-print { display: none; }
          }
        </style>
      </head>
      <body onload="window.print(); window.close();">
        <div class="header">
          <img src="/logo.png" alt="Logo" class="logo" onerror="this.style.display='none'" />
          <div class="pharmacy-name">${escapeHtml(pharmacyName)}</div>
          <div class="pharmacy-info">
            ${location ? `<div>${escapeHtml(location)}</div>` : ""}
            ${contact ? `<div>Tel: ${escapeHtml(contact)}</div>` : ""}
            ${email ? `<div>Email: ${escapeHtml(email)}</div>` : ""}
          </div>
        </div>
        
        <h1>SUPPLIER REQUISITION</h1>
        <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
        <p><strong>Requisition No:</strong> REQ-${Date.now()}</p>
        
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Item Description</th>
              <th>Quantity</th>
              <th>Est. Unit Price</th>
              <th>Est. Total</th>
            </tr>
          </thead>
          <tbody>
            ${validItems.map((item, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escapeHtml(item.productName)}</td>
                <td>${escapeHtml(item.quantity)}</td>
                <td>${formatCurrency(item.unitPrice)}</td>
                <td>${formatCurrency(item.quantity * item.unitPrice)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
        
        <p class="total">Estimated Total: ${formatCurrency(totalAmount)}</p>
        
        ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
        
        <div class="footer">
          <p>Requested by: ___________________</p>
          <p>Approved by: ___________________</p>
          <p>Date: ___________________</p>
        </div>
      </body>
      </html>
    `

    printWindow.document.write(html)
    printWindow.document.close()
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle className="flex items-center">
            <Truck className="h-5 w-5 mr-2" />
            Create Supplier Requisition
          </CardTitle>
          <p className="text-sm text-muted-foreground">Request items needed for the pharmacy from suppliers</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Items Required</Label>
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Item
                </Button>
              </div>
              
              {orderItems.map((item, index) => (
                <div key={index} className="flex gap-2 items-end border p-3 rounded-lg">
                  <div className="flex-1">
                    <Label className="text-xs">Drug/Item Name *</Label>
                    <Input
                      value={item.productName}
                      onChange={(e) => updateItem(index, "productName", e.target.value)}
                      placeholder="e.g., Paracetamol 500mg, Bandages, etc."
                      required
                    />
                  </div>
                  <div className="w-24">
                    <Label className="text-xs">Quantity *</Label>
                    <Input
                      type="number"
                      min="1"
                      value={item.quantity}
                      onChange={(e) => updateItem(index, "quantity", parseInt(e.target.value) || 1)}
                      required
                    />
                  </div>
                  <div className="w-32">
                    <Label className="text-xs">Est. Unit Price</Label>
                    <Input
                      type="number"
                      step="0.01"
                      value={item.unitPrice}
                      onChange={(e) => updateItem(index, "unitPrice", parseFloat(e.target.value) || 0)}
                      placeholder="Optional"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeItem(index)}
                    disabled={orderItems.length === 1}
                  >
                    <XCircle className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>

            {totalAmount > 0 && (
              <div className="bg-purple-50 p-4 rounded-lg">
                <div className="flex justify-between items-center text-lg font-bold text-purple-800">
                  <span>Estimated Total:</span>
                  <span>{formatCurrency(totalAmount)}</span>
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="notes">Notes / Special Instructions</Label>
              <Input
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Preferred supplier, urgency level, specific brands, etc."
              />
            </div>

            <div className="flex justify-between pt-4">
              <Button type="button" variant="outline" onClick={printRequisition}>
                <Printer className="h-4 w-4 mr-2" />
                Print Requisition
              </Button>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isLoading}>
                  {isLoading ? "Creating..." : "Save Requisition"}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

interface OrderDetailsDialogProps {
  order: Order
  onClose: () => void
  onStatusChange: (orderId: string, status: string) => void
  onRefresh: () => void
}

function OrderDetailsDialog({ order, onClose, onStatusChange, onRefresh }: OrderDetailsDialogProps) {
  const [isProcessingPayment, setIsProcessingPayment] = useState(false)
  const [settings, setSettings] = useState<PharmacySettings | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    fetchSettings()
  }, [])

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

  const printOrder = () => {
    const printWindow = window.open("", "", "width=400,height=600")
    if (!printWindow) return

    const pharmacyName = settings?.pharmacyName || "SYNAPSE Pharm"
    const location = settings?.location || ""
    const contact = settings?.contact || ""
    const footerText = settings?.footerText || "Thank you for your business!"

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Order ${escapeHtml(order.orderNo)}</title>
        <style>
          body { font-family: 'Courier New', monospace; padding: 15px; width: 350px; font-size: 12px; }
          .center { text-align: center; }
          .bold { font-weight: bold; }
          .header { text-align: center; margin-bottom: 15px; border-bottom: 1px dashed #000; padding-bottom: 15px; }
          .logo { max-width: 60px; height: auto; margin-bottom: 5px; }
          .pharmacy-name { font-size: 16px; font-weight: bold; }
          .pharmacy-info { font-size: 10px; color: #666; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 3px 0; }
          .right { text-align: right; }
          .line { border-bottom: 1px dashed #000; margin: 10px 0; }
          .footer-text { text-align: center; margin-top: 15px; font-size: 10px; color: #666; }
          @media print {
            body { padding: 5px; }
          }
        </style>
      </head>
      <body onload="window.print(); window.close();">
        <div class="header">
          <img src="/logo.png" alt="Logo" class="logo" onerror="this.style.display='none'" />
          <div class="pharmacy-name">${escapeHtml(pharmacyName)}</div>
          <div class="pharmacy-info">
            ${location ? `<div>${escapeHtml(location)}</div>` : ""}
            ${contact ? `<div>Tel: ${escapeHtml(contact)}</div>` : ""}
          </div>
        </div>
        <div class="center">
          <h2 style="margin: 5px 0;">ORDER</h2>
          <p>${escapeHtml(order.orderNo)}</p>
          <p>${new Date(order.createdAt).toLocaleString()}</p>
        </div>
        <div class="line"></div>
        ${order.customer ? `
          <p><strong>Customer:</strong> ${escapeHtml(order.customer.name)}</p>
          ${order.customer.phone ? `<p><strong>Phone:</strong> ${escapeHtml(order.customer.phone)}</p>` : ""}
        ` : ""}
        ${order.deliveryAddress ? `<p><strong>Address:</strong> ${escapeHtml(order.deliveryAddress)}</p>` : ""}
        <div class="line"></div>
        <table>
          ${(order.items ?? []).map(item => `
            <tr>
              <td>${escapeHtml(item.productName || item.product?.name)}</td>
              <td class="center">x${escapeHtml(item.quantity)}</td>
              <td class="right">${formatCurrency(item.totalPrice)}</td>
            </tr>
          `).join("")}
        </table>
        <div class="line"></div>
        <table>
          <tr class="bold">
            <td>TOTAL</td>
            <td class="right">${formatCurrency(order.totalAmount)}</td>
          </tr>
          <tr>
            <td>Payment Status</td>
            <td class="right">${escapeHtml(order.paymentStatus)}</td>
          </tr>
        </table>
        ${order.notes ? `<p><strong>Notes:</strong> ${escapeHtml(order.notes)}</p>` : ""}
        <div class="footer-text">${escapeHtml(footerText)}</div>
      </body>
      </html>
    `

    printWindow.document.write(html)
    printWindow.document.close()
  }

  const processPayment = async () => {
    setIsProcessingPayment(true)
    try {
      const response = await fetch("/api/admin/orders/payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Payment processed and transaction created",
        })
        onRefresh()
        onClose()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to process payment",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred",
      })
    } finally {
      setIsProcessingPayment(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <Card className="w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              {order.orderType === "CUSTOMER" ? <ShoppingBag className="h-5 w-5" /> : <Truck className="h-5 w-5" />}
              {order.orderNo}
              <span className={`px-2 py-1 text-xs rounded-full ${order.orderType === 'CUSTOMER' ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'}`}>
                {order.orderType}
              </span>
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={onClose}>X</Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {order.customer && (
              <div>
                <Label className="text-muted-foreground">Customer</Label>
                <p className="font-semibold">{order.customer.name}</p>
                {order.customer.phone && <p className="text-sm text-muted-foreground">{order.customer.phone}</p>}
                <p className="text-sm text-muted-foreground">{order.customer.email}</p>
              </div>
            )}
            <div>
              <Label className="text-muted-foreground">Order Date</Label>
              <p className="font-semibold">{new Date(order.createdAt).toLocaleString()}</p>
            </div>
            <div>
              <Label className="text-muted-foreground">Status</Label>
              <p className={`font-semibold ${order.status === 'COMPLETED' ? 'text-[#22C55E]' : order.status === 'CANCELLED' ? 'text-destructive' : 'text-yellow-400'}`}>
                {order.status}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Payment Status</Label>
              <p className={`font-semibold ${order.paymentStatus === 'PAID' ? 'text-[#22C55E]' : 'text-destructive'}`}>
                {order.paymentStatus}
              </p>
            </div>
            <div>
              <Label className="text-muted-foreground">Total Amount</Label>
              <p className="font-semibold text-lg">{formatCurrency(order.totalAmount)}</p>
            </div>
          </div>

          {order.deliveryAddress && (
            <div>
              <Label className="text-muted-foreground">Delivery Address</Label>
              <p>{order.deliveryAddress}</p>
            </div>
          )}

          {order.notes && (
            <div>
              <Label className="text-muted-foreground">Notes</Label>
              <p>{order.notes}</p>
            </div>
          )}

          <div>
            <Label className="text-muted-foreground mb-2 block">Order Items</Label>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Product</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Unit Price</TableHead>
                  <TableHead className="text-right">Total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(order.items ?? []).map((item) => (
                  <TableRow key={item.id}>
                    <TableCell>{item.productName || item.product?.name}</TableCell>
                    <TableCell className="text-right">{item.quantity}</TableCell>
                    <TableCell className="text-right">{formatCurrency(item.unitPrice)}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(item.totalPrice)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {order.processedByUser && (
            <div>
              <Label className="text-muted-foreground">Processed By</Label>
              <p>{order.processedByUser.name}</p>
            </div>
          )}

          <div className="flex justify-between gap-2 pt-4 border-t">
            <Button variant="outline" onClick={printOrder}>
              <Printer className="h-4 w-4 mr-2" />
              Print Order
            </Button>
            
            <div className="flex gap-2">
              {order.status === "PENDING" && order.orderType === "CUSTOMER" && order.paymentStatus === "UNPAID" && (
                <Button onClick={processPayment} disabled={isProcessingPayment} className="bg-green-600 hover:bg-green-700">
                  <CreditCard className="h-4 w-4 mr-2" />
                  {isProcessingPayment ? "Processing..." : "Confirm Payment"}
                </Button>
              )}
              
              {order.status === "PENDING" && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => {
                      onStatusChange(order.id, "CANCELLED")
                      onClose()
                    }}
                  >
                    <XCircle className="h-4 w-4 mr-2" />
                    Cancel
                  </Button>
                  <Button
                    onClick={() => {
                      onStatusChange(order.id, "COMPLETED")
                      onClose()
                    }}
                  >
                    <CheckCircle className="h-4 w-4 mr-2" />
                    Complete
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// Inquiry Dialog Component
interface InquiryDialogProps {
  userId: string
  userEmail: string
  userName: string
  inquiryType: string
  entityId: string
  entityName: string
  onClose: () => void
}

function InquiryDialog({ userId, userEmail, userName, inquiryType, entityId, entityName, onClose }: InquiryDialogProps) {
  const [subject, setSubject] = useState(
    inquiryType === "DELETE_REQUEST" 
      ? `Request to delete order ${entityName}` 
      : `Request regarding ${entityName}`
  )
  const [message, setMessage] = useState(
    inquiryType === "DELETE_REQUEST"
      ? `I would like to request deletion of order ${entityName}.\n\nReason: `
      : ""
  )
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!subject || !message) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Please fill in all fields",
      })
      return
    }

    setIsLoading(true)
    try {
      const response = await fetch("/api/admin/inquiries", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId,
          userEmail,
          userName,
          type: inquiryType,
          subject,
          message: `${message}\n\n---\nRelated Entity ID: ${entityId}`,
        }),
      })

      if (response.ok) {
        toast({
          title: "Request Sent",
          description: "Your request has been sent to the administrator. You will be notified via email once it's reviewed.",
        })
        onClose()
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: "Failed to send request",
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
          <CardTitle>Send Request to Admin</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm text-yellow-800">
              <strong>Note:</strong> This request will be sent to the administrator for approval. You will receive an email notification once reviewed.
            </div>

            <div className="space-y-2">
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="message">Message</Label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[120px]"
                placeholder="Please explain your request..."
                required
              />
            </div>

            <div className="flex justify-end space-x-2 pt-4">
              <Button type="button" variant="outline" onClick={onClose} disabled={isLoading}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Sending..." : "Send Request"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

