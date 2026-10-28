"use client"

import Link from "next/link"
import { useState } from "react"
import { Mail } from "lucide-react"

type LoginStep = "credentials" | "choose" | "otp"

type WorkspaceOption = { tenantId: string; name: string; slug: string }

export default function LoginPage() {
  const [step, setStep] = useState<LoginStep>("credentials")
  const [identifier, setIdentifier] = useState("")
  const [resolvedEmail, setResolvedEmail] = useState("")
  const [password, setPassword] = useState("")
  const [otp, setOtp] = useState("")
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[]>([])
  const [tenantId, setTenantId] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [resendMsg, setResendMsg] = useState<string | null>(null)

  // One identity can work at several pharmacies, so the facility is chosen before
  // a session is issued. Re-submitting the credentials with the chosen tenantId
  // is what tells the server which one.
  const submitCredentials = async (chosenTenantId?: string) => {
    setIsLoading(true)
    setError(null)

    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier,
        password,
        ...(chosenTenantId ? { tenantId: chosenTenantId } : {}),
      }),
    })
    const data = await res.json().catch(() => ({}))

    if (data.chooseWorkspace && Array.isArray(data.workspaces)) {
      setWorkspaces(data.workspaces as WorkspaceOption[])
      setStep("choose")
      setIsLoading(false)
      return
    }

    if (!res.ok) {
      setError(data.error ?? 'Invalid email/username or password.')
      setIsLoading(false)
      return
    }

    // Staff (non-admin): password-only session already issued
    if (data.sessionIssued) {
      window.location.assign(
        data.redirect ??
          (data.mustChangePassword ? "/change-password" : "/portal/dashboard"),
      )
      return
    }

    setTenantId(typeof data.tenantId === 'string' ? data.tenantId : chosenTenantId ?? '')
    setResolvedEmail(typeof data.email === 'string' ? data.email : identifier.trim().toLowerCase())
    setStep("otp")
    setIsLoading(false)
  }

  const handleCredentials = (e: React.FormEvent) => {
    e.preventDefault()
    void submitCredentials()
  }

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    const emailForOtp = resolvedEmail || identifier.trim().toLowerCase()
    const res = await fetch('/api/auth/otp-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailForOtp, otp, ...(tenantId ? { tenantId } : {}) }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error ?? 'Verification failed. Try again.')
      setIsLoading(false)
      return
    }

    window.location.assign(
      data.redirect ??
        (data.mustChangePassword ? "/change-password" : "/portal/dashboard"),
    )
  }

  const handleResend = async () => {
    setResendMsg(null)
    setError(null)
    const emailForOtp = resolvedEmail || identifier.trim().toLowerCase()
    const res = await fetch('/api/auth/otp-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailForOtp }),
    })
    if (res.ok) {
      setResendMsg("A new code was sent to your email.")
    } else {
      const data = await res.json().catch(() => ({})) as { error?: string }
      setError(data.error ?? "Could not resend code.")
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-[#07070A]">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <img src="/logo.png" alt="SynapseOS" className="w-16 h-16 rounded-2xl object-contain mb-4 shadow-lg" />
          <h1 className="font-display text-xl font-bold text-white">
            Synapse <span className="text-[#1FA6A6]">Pharm</span>
          </h1>
          <p className="font-mono text-xs mt-1 uppercase tracking-wider text-zinc-400">
            {step === "credentials"
              ? "Staff & Admin Portal"
              : step === "choose"
                ? "Choose your pharmacy"
                : `Code sent to ${resolvedEmail || identifier}`}
          </p>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-zinc-800 bg-[#111117] p-6 shadow-xl">
          {step === "credentials" && (
            <form onSubmit={handleCredentials} className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="identifier"
                  className="text-xs font-medium uppercase tracking-wider text-zinc-400"
                >
                  Email or username
                </label>
                <input
                  id="identifier"
                  type="text"
                  autoComplete="username"
                  placeholder="you@pharmacy.com or cashier1"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                  disabled={isLoading}
                  className="synapse-input"
                />
              </div>

              <div className="space-y-1.5">
                <label
                  htmlFor="password"
                  className="text-xs font-medium uppercase tracking-wider text-zinc-400"
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={isLoading}
                  className="synapse-input"
                />
              </div>

              {error && (
                <p className="text-sm rounded-lg px-3 py-2 text-red-400 bg-red-500/10">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={isLoading}
                className="btn-primary w-full h-11 mt-2"
              >
                {isLoading ? "Checking…" : "Sign in"}
              </button>

              <div className="text-center pt-1">
                <Link href="/forgot-password" className="text-xs text-zinc-600 hover:text-zinc-300">
                  Forgot password?
                </Link>
              </div>
            </form>
          )}

          {step === "choose" && (
            <div className="space-y-4">
              <p className="text-sm text-zinc-400">
                This account works at more than one pharmacy. Pick the one you are signing into.
              </p>

              {error && (
                <p className="text-sm rounded-lg px-3 py-2 text-red-400 bg-red-500/10">
                  {error}
                </p>
              )}

              <div className="space-y-2">
                {workspaces.map((workspace) => (
                  <button
                    key={workspace.tenantId}
                    type="button"
                    onClick={() => void submitCredentials(workspace.tenantId)}
                    disabled={isLoading}
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-900/50 px-4 py-3 text-left hover:border-[#1FA6A6] disabled:opacity-60"
                  >
                    <span className="block text-sm font-medium text-white">{workspace.name}</span>
                    {workspace.slug ? (
                      <span className="block text-xs text-zinc-500">{workspace.slug}</span>
                    ) : null}
                  </button>
                ))}
              </div>

              <button
                type="button"
                onClick={() => {
                  setStep("credentials")
                  setError(null)
                }}
                className="text-xs text-zinc-600 hover:text-zinc-300"
              >
                ← Back
              </button>
            </div>
          )}

          {step === "otp" && (
            <form onSubmit={handleVerifyOtp} className="space-y-4">
              <div className="flex items-start gap-3 rounded-xl border border-zinc-700 bg-zinc-900/50 p-3">
                <Mail className="mt-0.5 h-4 w-4 shrink-0 text-[#E8B84B]" />
                <p className="text-sm text-zinc-300">
                  A 6-digit code was sent to{" "}
                  <span className="text-white font-medium">{resolvedEmail || identifier}</span>. Expires in 10 minutes.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wider text-zinc-400">
                  Verification code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  autoFocus
                  placeholder="000000"
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  required
                  disabled={isLoading}
                  className="synapse-input text-center font-mono text-xl tracking-[0.3em]"
                />
              </div>

              {error && (
                <p className="text-sm rounded-lg px-3 py-2 text-red-400 bg-red-500/10">
                  {error}
                </p>
              )}
              {resendMsg && (
                <p className="text-sm text-green-400">{resendMsg}</p>
              )}

              <button
                type="submit"
                disabled={isLoading || otp.length !== 6}
                className="btn-primary w-full h-11 mt-2"
              >
                {isLoading ? "Verifying…" : "Verify & Sign in"}
              </button>

              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setStep("credentials")
                    setOtp("")
                    setError(null)
                    setResendMsg(null)
                  }}
                  className="text-xs text-zinc-600 hover:text-zinc-300"
                >
                  ← Back
                </button>
                <button
                  type="button"
                  onClick={handleResend}
                  className="text-xs text-[#1FA6A6] hover:underline"
                >
                  Resend code
                </button>
              </div>
            </form>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-600">
          Synapse Health Technologies © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  )
}
