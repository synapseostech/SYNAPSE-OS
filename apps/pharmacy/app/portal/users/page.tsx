"use client"

import { useEffect, useState } from "react"

// Force dynamic rendering
export const dynamic = 'force-dynamic'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { Plus, Mail, Loader2, Edit, Trash2, KeyRound, RotateCcw, ShieldCheck } from "lucide-react"
import {
  ACCESS_PROFILES,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  accessRoleFromStored,
  accessRoleLabel,
  describeAccess,
  profileKey,
  type AccessRole,
  type Permission,
} from "@/lib/access-profiles"

interface User {
  id: string
  name: string
  username: string | null
  email: string
  role: AccessRole
  permissions: Permission[]
  isActive: boolean
  createdAt: string
}

/** The API stores pharmacy_role values; the form and the table speak AccessRole. */
function normalizeUser(raw: Record<string, unknown>): User {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? ""),
    username: (raw.username as string | null) ?? null,
    email: String(raw.email ?? ""),
    role: accessRoleFromStored(String(raw.role ?? "")),
    permissions: (Array.isArray(raw.permissions) ? raw.permissions : []) as Permission[],
    isActive: Boolean(raw.isActive),
    createdAt: String(raw.createdAt ?? ""),
  }
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showEditDialog, setShowEditDialog] = useState(false)
  const [selectedUser, setSelectedUser] = useState<User | null>(null)
  const { toast } = useToast()
  const { user: sessionUser } = usePharmacySession()

  useEffect(() => {
    fetchUsers()
  }, [])

  const fetchUsers = async () => {
    try {
      const response = await fetch("/api/admin/users")
      const data = await response.json()
      setUsers(Array.isArray(data) ? data.map(normalizeUser) : [])
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to fetch users",
      })
    } finally {
      setIsLoading(false)
    }
  }

  const handleEdit = (user: User) => {
    setSelectedUser(user)
    setShowEditDialog(true)
  }

  const handleDelete = async (userId: string) => {
    if (!confirm("Are you sure you want to delete this user?")) {
      return
    }

    try {
      const response = await fetch(`/api/admin/users?id=${userId}`, {
        method: "DELETE",
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "User deleted successfully",
        })
        fetchUsers()
      } else {
        const data = await response.json()
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to delete user",
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

  const handleResetPassword = async (userId: string, userName: string) => {
    if (!confirm(`Send password reset email to ${userName}?`)) {
      return
    }

    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: userId, resetPassword: true }),
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: "Success",
          description: data.message || "Password reset email sent successfully",
        })
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to reset password",
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
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">User Management</h1>
          <p className="text-muted-foreground mt-1 sm:mt-2 text-sm sm:text-base">Manage staff accounts and permissions</p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)} className="w-full sm:w-auto">
          <Plus className="h-4 w-4 mr-2" />
          Create User
        </Button>
      </div>

      {showCreateDialog && (
        <CreateUserDialog
          onClose={() => setShowCreateDialog(false)}
          onSuccess={() => {
            setShowCreateDialog(false)
            fetchUsers()
          }}
        />
      )}

      {showEditDialog && selectedUser && (
        <EditUserDialog
          user={selectedUser}
          onClose={() => {
            setShowEditDialog(false)
            setSelectedUser(null)
          }}
          onSuccess={() => {
            setShowEditDialog(false)
            setSelectedUser(null)
            fetchUsers()
          }}
          isSelf={selectedUser.id === sessionUser?.id}
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Staff Users</CardTitle>
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
                  <TableHead>Username</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Access</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.name}</TableCell>
                    <TableCell className="text-muted-foreground">{user.username || "—"}</TableCell>
                    <TableCell>{user.email}</TableCell>
                    <TableCell>
                      <span className="px-2 py-1 text-xs rounded-full bg-primary/10 text-primary">
                        {accessRoleLabel(user.role)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <AccessCell role={user.role} permissions={user.permissions} />
                    </TableCell>
                    <TableCell>
                      <span className={`px-2 py-1 text-xs rounded-full ${
                        user.isActive ? 'bg-green-500/15 text-[#22C55E]' : 'bg-red-500/15 text-destructive'
                      }`}>
                        {user.isActive ? 'Active' : 'Inactive'}
                      </span>
                    </TableCell>
                    <TableCell>{new Date(user.createdAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => handleEdit(user)} title="Edit User">
                        <Edit className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => handleResetPassword(user.id, user.name)} title="Reset Password">
                        <RotateCcw className="h-4 w-4 text-blue-500" />
                      </Button>
                      {user.id === sessionUser?.id ? null : (
                        <Button variant="ghost" size="sm" onClick={() => handleDelete(user.id)} title="Delete User">
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

/** What this account actually opens, resolved through the sidebar's own gate. */
function AccessCell({ role, permissions }: { role: string; permissions: readonly string[] }) {
  const access = describeAccess(role, permissions)
  const preview = access.areas.slice(0, 3).join(", ")
  const remainder = access.areas.length - 3
  return (
    <div
      className="min-w-[170px]"
      title={access.groups.map((group) => `${group.label}: ${group.items.join(", ")}`).join("\n")}
    >
      <div className="text-sm font-medium">{access.profileLabel}</div>
      <div className="text-xs text-muted-foreground">
        {access.areas.length === 0
          ? "No areas"
          : `${access.areas.length} areas · ${preview}${remainder > 0 ? ` +${remainder}` : ""}`}
      </div>
    </div>
  )
}

type AccessDraft = {
  role: AccessRole
  permissions: Permission[]
  profileId: string
}

interface AccessEditorProps {
  value: AccessDraft
  onChange: (next: AccessDraft) => void
  disabled?: boolean
  /** Editing your own account: the API refuses a role change, so lock the control. */
  lockRole?: boolean
  idPrefix: string
}

function AccessEditor({ value, onChange, disabled = false, lockRole = false, idPrefix }: AccessEditorProps) {
  const activeProfile = ACCESS_PROFILES.find((profile) => profile.id === value.profileId)
  const access = describeAccess(value.role, value.permissions)

  const applyProfile = (nextId: string) => {
    const profile = ACCESS_PROFILES.find((candidate) => candidate.id === nextId)
    if (!profile) {
      onChange({ ...value, profileId: nextId })
      return
    }
    onChange({ role: profile.role, permissions: profile.permissions, profileId: profile.id })
  }

  const togglePermission = (permission: Permission) => {
    const permissions = value.permissions.includes(permission)
      ? value.permissions.filter((p) => p !== permission)
      : [...value.permissions, permission]
    onChange({ ...value, permissions, profileId: "CUSTOM" })
  }

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-access-profile`}>Access profile</Label>
        <select
          id={`${idPrefix}-access-profile`}
          value={value.profileId}
          onChange={(e) => applyProfile(e.target.value)}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          disabled={disabled || lockRole}
        >
          <option value="CUSTOM">Custom — choose permissions by hand</option>
          {ACCESS_PROFILES.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          {activeProfile?.description ??
            "Pick the areas this account may open. Ticking permissions yourself switches back to Custom."}
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-role`}>Role</Label>
        <select
          id={`${idPrefix}-role`}
          value={value.role}
          onChange={(e) =>
            onChange({ ...value, role: e.target.value as AccessRole, profileId: "CUSTOM" })
          }
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
          disabled={disabled || lockRole}
          title="Select Role"
        >
          <option value="STAFF">Staff</option>
          <option value="ADMIN">Admin</option>
          <option value="CEO">CEO (View Only)</option>
        </select>
        {value.role === "CEO" && (
          <p className="text-xs text-muted-foreground mt-1">
            CEO role has view access to all areas including dashboard, reports, and activity logs.
          </p>
        )}
        {value.role === "STAFF" && (
          <p className="text-xs text-muted-foreground mt-1">
            2FA is optional for staff. Users can enable it in their account settings if needed.
          </p>
        )}
        {value.role !== "STAFF" && (
          <p className="text-xs text-muted-foreground mt-1">
            Administrators and the CEO can open every area; the permissions below do not apply.
          </p>
        )}
      </div>

      {value.role === "STAFF" && (
        <div className="space-y-3">
          <Label>Permissions</Label>
          {PERMISSION_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {group.label}
              </p>
              <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {group.permissions.map((permission) => (
                  <label key={permission} className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={value.permissions.includes(permission)}
                      onChange={() => togglePermission(permission)}
                      className="mt-0.5 rounded"
                      disabled={disabled}
                    />
                    <span className="text-sm">{PERMISSION_LABELS[permission]}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5" />
          Can open
        </p>
        <p className="mt-1 text-sm">
          {access.areas.length > 0 ? access.areas.join(" · ") : "Nothing yet"}
        </p>
        {access.groups.length > 0 && (
          <div className="mt-2 space-y-0.5">
            {access.groups.map((group) => (
              <p key={group.label} className="text-xs text-muted-foreground">
                <span className="font-medium">{group.label}:</span> {group.items.join(", ")}
              </p>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

interface CreateUserDialogProps {
  onClose: () => void
  onSuccess: () => void
}

function CreateUserDialog({ onClose, onSuccess }: CreateUserDialogProps) {
  const [name, setName] = useState("")
  const [username, setUsername] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [sendWelcomeEmail, setSendWelcomeEmail] = useState(true)
  const [access, setAccess] = useState<AccessDraft>({
    role: "STAFF",
    permissions: [],
    profileId: "CUSTOM",
  })
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password && password !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Passwords do not match",
        description: "Re-enter the password confirmation.",
      })
      return
    }
    if (password && password.length < 8) {
      toast({
        variant: "destructive",
        title: "Password too short",
        description: "Use at least 8 characters with upper case, a number, and a special character.",
      })
      return
    }
    setIsLoading(true)

    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          email,
          username: username.trim() || undefined,
          role: access.role,
          permissions: access.permissions,
          password: password.trim() || undefined,
          sendWelcomeEmail,
        }),
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: "Success",
          description: password
            ? sendWelcomeEmail
              ? "User created. Password emailed (and you set it manually)."
              : "User created with the password you set."
            : "User created and temporary credentials emailed.",
        })
        onSuccess()
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to create user",
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
          <CardTitle>Create New User</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Full Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="username">Username (Optional)</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="e.g., john_doe"
                disabled={isLoading}
              />
              <p className="text-xs text-muted-foreground">Users can login with either email or username</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="staff-password">Password (optional)</Label>
                <Input
                  id="staff-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Leave blank to auto-generate"
                  disabled={isLoading}
                />
                <p className="text-xs text-muted-foreground">
                  Min 8 chars, 1 uppercase, 1 number, 1 special character.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="staff-password-confirm">Confirm password</Label>
                <Input
                  id="staff-password-confirm"
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter if setting manually"
                  disabled={isLoading || !password}
                />
              </div>
            </div>

            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                className="mt-1 rounded"
                checked={sendWelcomeEmail}
                onChange={(e) => setSendWelcomeEmail(e.target.checked)}
                disabled={isLoading}
              />
              <span>
                <span className="font-medium">Email login details to staff</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Uncheck if you will share the password yourself (e.g. onboarding in person).
                </span>
              </span>
            </label>

            <AccessEditor
              value={access}
              onChange={setAccess}
              disabled={isLoading}
              idPrefix="create"
            />

            <div className="flex justify-end space-x-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : password ? (
                  <>
                    <KeyRound className="mr-2 h-4 w-4" />
                    Create with password
                  </>
                ) : (
                  <>
                    <Mail className="mr-2 h-4 w-4" />
                    Create &amp; Send Email
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

interface EditUserDialogProps {
  user: User
  onClose: () => void
  onSuccess: () => void
  /** Editing your own account: role and active status are locked (the API refuses them too). */
  isSelf?: boolean
}

function EditUserDialog({ user, onClose, onSuccess, isSelf = false }: EditUserDialogProps) {
  const [name, setName] = useState(user.name)
  const [username, setUsername] = useState(user.username || "")
  const [access, setAccess] = useState<AccessDraft>(() => ({
    role: user.role,
    permissions: user.permissions,
    profileId: profileKey(user.role, user.permissions),
  }))
  const [isActive, setIsActive] = useState(user.isActive)
  const [isLoading, setIsLoading] = useState(false)
  const { toast } = useToast()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)

    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: user.id,
          name,
          username: username.trim() || null,
          role: access.role,
          permissions: access.permissions,
          isActive
        }),
      })

      const data = await response.json()

      if (response.ok) {
        toast({
          title: "Success",
          description: "User updated successfully",
        })
        onSuccess()
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || "Failed to update user",
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
          <CardTitle>Edit User</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Full Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isLoading}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-username">Username (Optional)</Label>
              <Input
                id="edit-username"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
                placeholder="e.g., john_doe"
                disabled={isLoading}
              />
              <p className="text-xs text-muted-foreground">Users can login with either email or username</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input
                id="edit-email"
                type="email"
                value={user.email}
                disabled
                className="bg-muted/30"
              />
            </div>

            <AccessEditor
              value={access}
              onChange={setAccess}
              disabled={isLoading}
              lockRole={isSelf}
              idPrefix="edit"
            />

            <div className="space-y-2">
              <Label className="flex items-center">
                <input
                  type="checkbox"
                  checked={isActive}
                  onChange={(e) => setIsActive(e.target.checked)}
                  className="mr-2"
                  disabled={isLoading || isSelf}
                  title="Active Account Status"
                />
                Active Account
              </Label>
            </div>

            <div className="flex justify-end space-x-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update User"
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
