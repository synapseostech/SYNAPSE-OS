"use client"

import { useState, useEffect } from "react"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { Loader2 } from "lucide-react"

function validateNewPassword(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters"
  if (!/[A-Z]/.test(password)) return "Include at least one uppercase letter"
  if (!/[0-9]/.test(password)) return "Include at least one number"
  if (!/[^A-Za-z0-9]/.test(password)) return "Include at least one special character (e.g. @ # !)"
  return null
}

export default function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const { user } = usePharmacySession()
  const { toast } = useToast()

  useEffect(() => {
    if (user && !user.mustChangePassword) {
      window.location.assign("/onboarding")
    }
  }, [user])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (newPassword !== confirmPassword) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "New password and confirmation do not match",
      })
      return
    }

    const strengthError = validateNewPassword(newPassword)
    if (strengthError) {
      toast({
        variant: "destructive",
        title: "Password too weak",
        description: strengthError,
      })
      return
    }

    setIsLoading(true)

    try {
      const response = await fetch("/api/user/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          currentPassword,
          newPassword,
        }),
      })

      let data: { error?: string; success?: boolean } = {}
      try {
        data = await response.json()
      } catch {
        data = {}
      }

      if (response.ok) {
        toast({
          title: "Success",
          description: "Password changed successfully",
        })
        window.location.assign("/onboarding")
      } else {
        toast({
          variant: "destructive",
          title: "Error",
          description: data.error || `Failed to change password (${response.status})`,
        })
      }
    } catch {
      toast({
        variant: "destructive",
        title: "Network error",
        description:
          "Could not reach the server. Disable VPN/proxy browser extensions and try again, or use a private window.",
      })
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#07070A] p-4">
      <Card className="w-full max-w-md border-[#2A2A36] bg-[#111117] text-white">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl font-bold">Change Password</CardTitle>
          <CardDescription className="text-zinc-400">
            Enter your current password, then choose a new one. New staff set their first password through the secure link in their invitation email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="currentPassword">Current Password</Label>
              <Input
                id="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                disabled={isLoading}
                className="border-[#2A2A36] bg-[#1A1A24] text-white"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="newPassword">New Password</Label>
              <Input
                id="newPassword"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                disabled={isLoading}
                className="border-[#2A2A36] bg-[#1A1A24] text-white"
              />
              <p className="text-xs text-zinc-500">
                At least 8 characters, one uppercase letter, one number, and one special character.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirmPassword">Confirm New Password</Label>
              <Input
                id="confirmPassword"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={isLoading}
                className="border-[#2A2A36] bg-[#1A1A24] text-white"
              />
            </div>
            <Button type="submit" className="w-full bg-[#F97316] hover:bg-orange-600 text-[#07070A]" disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Changing Password...
                </>
              ) : (
                "Change Password"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
