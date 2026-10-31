"use client"

import { useEffect, useState } from "react"
import Link from "next/link"

// Force dynamic rendering
export const dynamic = 'force-dynamic'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { sessionHasCapability } from "@/lib/capabilities"
import { Plus, Search, Edit, Trash2, Loader2, User, CalendarClock } from "lucide-react"
import { resilientFetch } from "@/lib/api"

interface Customer {
  id: string
  name: string
  email: string
  phone?: string
  address?: string
  isActive: boolean
  createdAt: string
  _count: {
    orders: number
    transactions: number
  }
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([])
  const [filteredCustomers, setFilteredCustomers] = useState<Customer[]>([])
  const [searchQuery, setSearchQuery] = useState("")
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null)
  // Next undispensed refill per customer, so the schedule is visible from here.
  const [nextRefill, setNextRefill] = useState<Record<string, string>>({})
  const { toast } = useToast()
  const { user } = usePharmacySession()
  // Deleting a customer also drops their credit history, so the route requires
  // customers.credit. A cashier with only MANAGE_POS must not be offered a
  // button that always 403s.
  const canDeleteCustomer = user
    ? sessionHasCapability(
        {
          isAdmin: user.isAdmin,
          pharmacyRole: user.pharmacyRole,
          permissions: user.permissions,
        },
        "customers.credit",
      )
    : false

  const fetchRefillSchedule = async () => {
    try {
      const response = await resilientFetch("/api/admin/refills?status=all")
      const data = await response.json()
      const schedule: Record<string, string> = {}
      for (const reminder of Array.isArray(data) ? data : []) {
        const customerId = reminder?.customer?.id
        if (!customerId || reminder.dispensed) continue
        const due = String(reminder.refill_due_date ?? "")
        if (!due) continue
        if (!schedule[customerId] || due < schedule[customerId]) schedule[customerId] = due
      }
      setNextRefill(schedule)
    } catch {
      setNextRefill({})
    }
  }

  useEffect(() => {
    fetchCustomers()
    fetchRefillSchedule()
  }, [])

  useEffect(() => {
    const filtered = customers.filter(
      (customer) =>
        customer.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        customer.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (customer.phone && customer.phone.includes(searchQuery))
    )
    setFilteredCustomers(filtered)
  }, [searchQuery, customers])

  const fetchCustomers = async () => {
    try {
      const response = await resilientFetch("/api/admin/customers")
      const data = await response.json()
      setCustomers(data)
      setFilteredCustomers(data)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch customers",
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleEdit = (customer: Customer) => {
    setSelectedCustomer(customer)
    setShowEditDialog(true)
  }

  const handleDelete = async (customerId: string) => {
    if (!confirm("Are you sure you want to delete this customer?")) {
      return
    }

    try {
      const response = await resilientFetch(`/api/admin/customers?id=${customerId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Customer deleted successfully",
        })
        fetchCustomers()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to delete customer",
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

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4 mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Customer Management</h1>
          <p className="text-muted-foreground mt-1 sm:mt-2 text-sm sm:text-base">Manage your customer database</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          Add Customer
        </Button>
      </div>

      {showCreateDialog && (
        <CreateCustomerDialog
          onClose={() => setShowCreateDialog(false)}
          onSuccess={() => {
            setShowCreateDialog(false)
            fetchCustomers()
          }}
        />
      )}

      {showEditDialog && selectedCustomer && (
        <EditCustomerDialog
          customer={selectedCustomer}
          onClose={() => {
            setShowEditDialog(false)
            setSelectedCustomer(null)
          }}
          onSuccess={() => {
            setShowEditDialog(false)
            setSelectedCustomer(null)
            fetchCustomers()
          }}
        />
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Customers ({filteredCustomers.length})</CardTitle>
            <div className="relative w-64">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search customers..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Next refill</TableHead>
                  <TableHead>Orders</TableHead>
                  <TableHead>Transactions</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCustomers.map((customer) => (
                  <TableRow key={customer.id}>
                    <TableCell className="font-medium">{customer.name}</TableCell>
                    <TableCell>{customer.email}</TableCell>
                    <TableCell>{customer.phone || "-"}</TableCell>
                    <TableCell>
                      {nextRefill[customer.id] ? (
                        new Date(`${nextRefill[customer.id]}T00:00:00`).toLocaleDateString("en-GB")
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>{customer._count.orders}</TableCell>
                    <TableCell>{customer._count.transactions}</TableCell>
                    <TableCell>
                      <span className={`px-2 py-1 text-xs rounded-full ${
                        customer.isActive ? 'bg-green-500/15 text-[#22C55E]' : 'bg-red-500/15 text-destructive'
                      }`}>
                        {customer.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm" title="Schedule a refill for this customer">
                        <Link href={`/portal/refills?customerId=${customer.id}`}>
                          <CalendarClock className="h-4 w-4" />
                        </Link>
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(customer)}>
                        <Edit className="h-4 w-4" />
                      </Button>
                      {canDeleteCustomer && (
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(customer.id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      )}
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

interface CreateCustomerDialogProps {
  onClose: () => void
  onSuccess: () => void
}

function CreateCustomerDialog({ onClose, onSuccess }: CreateCustomerDialogProps) {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
  })
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const response = await resilientFetch("/api/admin/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formData),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Customer created successfully",
        })
        onSuccess()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to create customer",
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
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle>Add New Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email *</Label>
              <Input
                id="email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="address">Address</Label>
              <Input
                id="address"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              />
            </div>

            <div className="flex justify-end space-x-2 pt-4">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Creating..." : "Create Customer"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

interface EditCustomerDialogProps {
  customer: Customer
  onClose: () => void
  onSuccess: () => void
}

function EditCustomerDialog({ customer, onClose, onSuccess }: EditCustomerDialogProps) {
  const [formData, setFormData] = useState({
    name: customer.name,
    email: customer.email,
    phone: customer.phone || "",
    address: customer.address || "",
    isActive: customer.isActive,
  })
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const response = await resilientFetch("/api/admin/customers", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: customer.id, ...formData }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Customer updated successfully",
        })
        onSuccess()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to update customer",
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
      <Card className="w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <CardHeader>
          <CardTitle>Edit Customer</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Full Name *</Label>
              <Input
                id="edit-name"
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-email">Email *</Label>
              <Input
                id="edit-email"
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone</Label>
              <Input
                id="edit-phone"
                value={formData.phone}
                onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-address">Address</Label>
              <Input
                id="edit-address"
                value={formData.address}
                onChange={(e) => setFormData({ ...formData, address: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label className="flex items-center">
                <input
                  type="checkbox"
                  checked={formData.isActive}
                  onChange={(e) => setFormData({ ...formData, isActive: e.target.checked })}
                  className="mr-2"
                  title="Active Account Status"
                />
                Active Account
              </Label>
            </div>

            <div className="flex justify-end space-x-2 pt-4">
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? "Updating..." : "Update Customer"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
