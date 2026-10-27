"use client"

import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
  CANONICAL_HOSPITAL_MODULES,
  FACILITY_LEVELS,
  FACILITY_OWNERSHIP,
  defaultModulesForLevel,
  slugify,
  type FacilityLevel,
  type FacilityOwnership,
} from "@synapse/db/hospital-provision-catalog"
import type { ReactNode } from "react"

const STEPS = [
  "Facility Profile",
  "Departments & Locations",
  "Modules",
  "Administrator",
  "Subscription",
  "Integrations",
  "Review & Provision",
] as const

const TIER_LABELS: Record<string, string> = {
  trial: "7 days free",
  starter: "Starter",
  professional: "Professional",
  enterprise: "Enterprise",
}

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

type StepStatus = Record<string, "PENDING" | "RUNNING" | "COMPLETE" | "FAILED" | "SKIPPED">

export default function PlatformHospitalOnboardingPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-3xl py-16 text-center text-sm text-slate-400">Loading wizard…</div>}>
      <HospitalOnboardingWizard />
    </Suspense>
  )
}

function HospitalOnboardingWizard() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [step, setStep] = useState(0)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState("")
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [slugStatus, setSlugStatus] = useState<"idle" | "checking" | "available" | "unavailable" | "error">("idle")
  const [provisionProgress, setProvisionProgress] = useState<string | null>(null)
  const [result, setResult] = useState<{
    ok?: boolean
    id?: string
    runId?: string
    status?: string
    steps?: Array<{ step: string; status: string; safeErrorMessage?: string; errorCode?: string }>
    warnings?: string[]
    inviteStatus?: string
    invitePath?: string
    error?: string
    correlationId?: string
    failureStep?: string | null
    failureCode?: string | null
    failureReason?: string | null
  } | null>(null)

  const [facilityName, setFacilityName] = useState("")
  const [ownership, setOwnership] = useState<FacilityOwnership>("PRIVATE")
  const [facilityLevel, setFacilityLevel] = useState<FacilityLevel>("GENERAL_HOSPITAL")
  const [city, setCity] = useState("")
  const [district, setDistrict] = useState("")
  const [bedsCount, setBedsCount] = useState("50")
  const [subdomain, setSubdomain] = useState("")
  const [contactName, setContactName] = useState("")
  const [contactEmail, setContactEmail] = useState("")
  const [contactPhone, setContactPhone] = useState("")
  const [tier, setTier] = useState("trial")
  const [modules, setModules] = useState<string[]>(defaultModulesForLevel("GENERAL_HOSPITAL"))
  const [adminName, setAdminName] = useState("")
  const [adminEmail, setAdminEmail] = useState("")
  const [adminPhone, setAdminPhone] = useState("")
  const [mode, setMode] = useState<"REAL" | "SYNTHETIC_ACCEPTANCE">("REAL")

  useEffect(() => {
    const name = searchParams.get("name")
    const email = searchParams.get("email")
    const location = searchParams.get("location")
    const synthetic = searchParams.get("synthetic")
    if (name) setFacilityName(name)
    if (email) {
      setContactEmail(email)
      setAdminEmail(email)
    }
    if (location) {
      const parts = location.split(",").map((p) => p.trim())
      setCity(parts[0] ?? location)
      setDistrict(parts[1] ?? "")
    }
    if (synthetic === "1") {
      setMode("SYNTHETIC_ACCEPTANCE")
      setFacilityName("SYNAPSE INTEGRATED REGIONAL HOSPITAL")
      setSubdomain("synapse-integrated-demo")
      setFacilityLevel("REGIONAL_REFERRAL_HOSPITAL")
      setOwnership("PRIVATE_NOT_FOR_PROFIT")
      setModules(defaultModulesForLevel("REGIONAL_REFERRAL_HOSPITAL"))
      setAdminName("Hospital Administrator")
      setAdminEmail("admin@synapse-integrated.local")
    }
  }, [searchParams])

  useEffect(() => {
    setModules(defaultModulesForLevel(facilityLevel))
  }, [facilityLevel])

  const computedSubdomain = useMemo(() => {
    if (mode === "SYNTHETIC_ACCEPTANCE") return "synapse-integrated-demo"
    if (subdomain.trim()) return slugify(subdomain)
    return slugify(facilityName)
  }, [subdomain, facilityName, mode])

  const checkSlug = useCallback(async (slug: string) => {
    if (!slug || slug.length < 2) {
      setSlugStatus("idle")
      return false
    }
    setSlugStatus("checking")
    try {
      const res = await fetch(`/api/platform/hospitals?slug=${encodeURIComponent(slug)}`)
      const data = await res.json()
      if (!res.ok) {
        setSlugStatus("error")
        return false
      }
      setSlugStatus(data.available ? "available" : "unavailable")
      return Boolean(data.available)
    } catch {
      setSlugStatus("error")
      return false
    }
  }, [])

  useEffect(() => {
    if (step !== 0) return
    const t = window.setTimeout(() => {
      void checkSlug(computedSubdomain)
    }, 350)
    return () => window.clearTimeout(t)
  }, [computedSubdomain, step, checkSlug])

  function validateStep(index: number): Record<string, string> {
    const errs: Record<string, string> = {}
    if (index === 0) {
      if (!facilityName.trim()) errs.facilityName = "Hospital name is required"
      if (!computedSubdomain || computedSubdomain.length < 2) errs.subdomain = "Valid subdomain required"
      if (slugStatus === "unavailable") errs.subdomain = "Subdomain is unavailable"
      if (!contactEmail.trim() || !isEmail(contactEmail)) errs.contactEmail = "Valid contact email required"
    }
    if (index === 3) {
      if (!adminName.trim()) errs.adminName = "Administrator name is required"
      if (!adminEmail.trim() || !isEmail(adminEmail)) errs.adminEmail = "Valid admin email required"
    }
    return errs
  }

  async function goNext() {
    setError("")
    const errs = validateStep(step)
    setFieldErrors(errs)
    if (Object.keys(errs).length) return
    if (step === 0) {
      const ok = await checkSlug(computedSubdomain)
      if (!ok && mode !== "SYNTHETIC_ACCEPTANCE") {
        setError(`Subdomain "${computedSubdomain}" is unavailable`)
        return
      }
    }
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }

  function toggleModule(key: string) {
    if (key === "core") return
    setModules((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  async function submit() {
    setError("")
    const errs = { ...validateStep(0), ...validateStep(3) }
    setFieldErrors(errs)
    if (Object.keys(errs).length) {
      setError("Fix validation errors before provisioning")
      setStep(0)
      return
    }
    setSubmitting(true)
    setProvisionProgress("Creating hospital…")
    setResult(null)
    try {
      setProvisionProgress("Validating & creating tenant…")
      const res = await fetch("/api/platform/hospitals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hospitalName: facilityName,
          ownership,
          facilityLevel,
          city,
          district,
          bedsCount: Number(bedsCount) || 0,
          subdomain: computedSubdomain,
          contactName,
          contactEmail,
          contactPhone,
          adminName,
          adminEmail,
          adminPhone,
          tier,
          modules,
          mode,
          sendInvite: true,
        }),
      })
      setProvisionProgress("Finalizing provisioning…")
      const payload = await res.json()
      setResult(payload)
      if (!res.ok || !payload.ok) {
        setError(payload.error || "Provisioning failed")
        setSubmitting(false)
        setProvisionProgress(null)
        return
      }
      setProvisionProgress(null)
      setSubmitting(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Provisioning failed")
      setSubmitting(false)
      setProvisionProgress(null)
    }
  }

  if (result?.ok && result.id) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#E8B84B]">Provisioning</p>
          <h1 className="mt-2 text-2xl font-bold">
            {result.status === "READY_WITH_WARNINGS" ? "READY WITH WARNINGS" : "HOSPITAL PROVISIONING COMPLETE"}
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {facilityName} · {computedSubdomain}.synapseos.tech
            {mode === "SYNTHETIC_ACCEPTANCE" ? " · SYNTHETIC / TEST ONLY" : ""}
          </p>
        </div>
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
          {(result.steps ?? []).map((s) => (
            <div key={s.step} className="flex items-center justify-between text-sm">
              <span className="font-mono text-slate-300">{s.step}</span>
              <span
                className={
                  s.status === "COMPLETE"
                    ? "text-green-400"
                    : s.status === "FAILED"
                      ? "text-red-400"
                      : s.status === "SKIPPED"
                        ? "text-slate-500"
                        : "text-amber-300"
                }
              >
                {s.status}
                {s.safeErrorMessage ? ` — ${s.safeErrorMessage}` : ""}
              </span>
            </div>
          ))}
        </div>
        {result.warnings?.length ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
            {result.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        ) : null}
        <p className="text-sm text-slate-400">
          Invitation: <span className="text-slate-200">{result.inviteStatus ?? "—"}</span>
          {result.invitePath ? (
            <>
              {" "}
              · <code className="text-xs text-[#E8B84B]">{result.invitePath}</code>
            </>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            onClick={() => router.push(`/platform/hospitals/${result.id}?runId=${result.runId ?? ""}`)}
            className="rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A]"
          >
            Open facility detail
          </button>
          <button
            type="button"
            onClick={() => router.push("/platform/test-center")}
            className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-200"
          >
            Open Test Center
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Hospital Onboarding</h1>
          <p className="text-sm text-slate-400">
            Step {step + 1} of {STEPS.length}: {STEPS[step]}
          </p>
        </div>
        <label className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          <input
            type="checkbox"
            checked={mode === "SYNTHETIC_ACCEPTANCE"}
            onChange={(e) => setMode(e.target.checked ? "SYNTHETIC_ACCEPTANCE" : "REAL")}
          />
          CREATE SYNTHETIC ACCEPTANCE HOSPITAL
        </label>
      </div>

      <div className="flex gap-1 overflow-x-auto pb-1">
        {STEPS.map((label, i) => (
          <div
            key={label}
            className={`h-1.5 min-w-[2.5rem] flex-1 rounded-full ${i <= step ? "bg-[#F97316]" : "bg-slate-800"}`}
            title={label}
          />
        ))}
      </div>

      {error ? (
        <div className="space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-3 text-sm text-red-100">
          <p className="font-semibold text-red-200">Provisioning failed</p>
          {result?.failureStep ? (
            <p>
              Step: <span className="font-mono">{result.failureStep}</span>
            </p>
          ) : null}
          {result?.failureCode ? (
            <p>
              Code: <span className="font-mono">{result.failureCode}</span>
            </p>
          ) : null}
          <p>Reason: {result?.failureReason || error}</p>
          {result?.correlationId ? (
            <p className="text-xs text-red-300/80">Correlation ID: {result.correlationId}</p>
          ) : null}
          <div className="flex flex-wrap gap-2 pt-1">
            {result?.runId ? (
              <button
                type="button"
                className="rounded-md border border-red-400/40 px-3 py-1 text-xs font-semibold text-red-100 hover:bg-red-500/20"
                onClick={async () => {
                  setSubmitting(true)
                  setError("")
                  try {
                    const res = await fetch("/api/platform/hospitals", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ action: "resume", runId: result.runId, sendInvite: true }),
                    })
                    const payload = await res.json()
                    setResult(payload)
                    if (!res.ok || !payload.ok) {
                      setError(payload.failureReason || payload.error || "Resume failed")
                    }
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Resume failed")
                  } finally {
                    setSubmitting(false)
                  }
                }}
              >
                Retry
              </button>
            ) : null}
            {result?.runId ? (
              <a
                href={`/platform/hospitals/${result.id ?? ""}?runId=${result.runId}`}
                className="rounded-md border border-red-400/40 px-3 py-1 text-xs font-semibold text-red-100 hover:bg-red-500/20"
              >
                Open provisioning details
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
      {provisionProgress ? (
        <p className="rounded-lg border border-[#E8B84B]/30 bg-[#E8B84B]/10 px-3 py-2 text-sm text-[#E8B84B]">
          {provisionProgress}
        </p>
      ) : null}

      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-5">
        {step === 0 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Hospital Name" error={fieldErrors.facilityName}>
              <input value={facilityName} onChange={(e) => setFacilityName(e.target.value)} className={inputCls} disabled={mode === "SYNTHETIC_ACCEPTANCE"} />
            </Field>
            <Field label="Ownership">
              <select value={ownership} onChange={(e) => setOwnership(e.target.value as FacilityOwnership)} className={inputCls}>
                {FACILITY_OWNERSHIP.map((o) => (
                  <option key={o} value={o}>{o.replace(/_/g, " ")}</option>
                ))}
              </select>
            </Field>
            <Field label="Facility type / level">
              <select value={facilityLevel} onChange={(e) => setFacilityLevel(e.target.value as FacilityLevel)} className={inputCls}>
                {FACILITY_LEVELS.map((o) => (
                  <option key={o} value={o}>{o.replace(/_/g, " ")}</option>
                ))}
              </select>
            </Field>
            <Field label="Subdomain" error={fieldErrors.subdomain}>
              <input
                value={subdomain}
                onChange={(e) => setSubdomain(e.target.value)}
                placeholder={slugify(facilityName)}
                className={inputCls}
                disabled={mode === "SYNTHETIC_ACCEPTANCE"}
              />
              <p className="mt-1 text-xs text-slate-500">
                {computedSubdomain}.synapseos.tech ·{" "}
                {slugStatus === "checking" && "CHECKING"}
                {slugStatus === "available" && <span className="text-green-400">AVAILABLE</span>}
                {slugStatus === "unavailable" && <span className="text-red-400">UNAVAILABLE</span>}
                {slugStatus === "error" && <span className="text-amber-300">ERROR</span>}
              </p>
            </Field>
            <Field label="City"><input value={city} onChange={(e) => setCity(e.target.value)} className={inputCls} /></Field>
            <Field label="District"><input value={district} onChange={(e) => setDistrict(e.target.value)} className={inputCls} /></Field>
            <Field label="Bed capacity"><input value={bedsCount} onChange={(e) => setBedsCount(e.target.value)} className={inputCls} /></Field>
            <Field label="Contact name"><input value={contactName} onChange={(e) => setContactName(e.target.value)} className={inputCls} /></Field>
            <Field label="Contact email" error={fieldErrors.contactEmail}>
              <input value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Contact phone"><input value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} className={inputCls} /></Field>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="space-y-3 text-sm text-slate-300">
            <p>
              Defaults are applied from facility level.{" "}
              {mode === "SYNTHETIC_ACCEPTANCE"
                ? "Synthetic acceptance seeds the full regional referral department + location set."
                : "Core departments (Admin, Reception, Triage, OPD, Lab, Pharmacy, Billing) are created now. Expand later from facility detail."}
            </p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {(mode === "SYNTHETIC_ACCEPTANCE"
                ? ["Administration", "Reception", "Triage", "OPD", "Emergency", "Medicine", "Surgery", "Paediatrics", "Maternity", "Lab", "Radiology", "Pharmacy", "Theatre", "Billing", "Insurance", "Public Health"]
                : ["Administration", "Reception / Medical Records", "Triage", "OPD", "Laboratory", "Pharmacy", "Billing"]
              ).map((d) => (
                <li key={d} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-2">{d}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {CANONICAL_HOSPITAL_MODULES.map((mod) => (
              <label key={mod.key} className="flex items-start gap-2 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={modules.includes(mod.key)}
                  disabled={mod.key === "core" || mod.status === "NOT_IMPLEMENTED"}
                  onChange={() => toggleModule(mod.key)}
                />
                <span>
                  <span className="font-medium">{mod.label}</span>
                  <span className="mt-0.5 block text-[10px] uppercase tracking-wide text-slate-500">
                    {mod.key} · {mod.status}
                  </span>
                </span>
              </label>
            ))}
          </div>
        ) : null}

        {step === 3 ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Admin full name" error={fieldErrors.adminName}>
              <input value={adminName} onChange={(e) => setAdminName(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Admin email" error={fieldErrors.adminEmail}>
              <input value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} className={inputCls} />
            </Field>
            <Field label="Admin phone">
              <input value={adminPhone} onChange={(e) => setAdminPhone(e.target.value)} className={inputCls} />
            </Field>
            <p className="md:col-span-2 rounded-xl border border-slate-700 bg-slate-950/50 p-3 text-sm text-slate-300">
              A single-use invite link is emailed. The administrator chooses their own password — no permanent password is emailed.
            </p>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {(["trial", "starter", "professional", "enterprise"] as const).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setTier(entry)}
                className={`rounded-xl border p-4 text-left ${tier === entry ? "border-[#E8B84B] bg-[#E8B84B]/10" : "border-slate-700 bg-slate-950/50"}`}
              >
                <p className="font-semibold capitalize">{entry}</p>
                <p className="mt-1 text-xs text-slate-400">{TIER_LABELS[entry]}</p>
              </button>
            ))}
          </div>
        ) : null}

        {step === 5 ? (
          <div className="grid gap-2 sm:grid-cols-2 text-sm">
            {[
              ["FHIR", "NOT_CONFIGURED"],
              ["Exchange", "NOT_CONFIGURED"],
              ["Lab", "NOT_CONFIGURED"],
              ["Pharmacy", "NOT_CONFIGURED"],
              ["Insurance", "NOT_CONFIGURED"],
              ["DHIS2", mode === "SYNTHETIC_ACCEPTANCE" ? "BLOCKED (synthetic)" : "NOT_CONFIGURED"],
            ].map(([name, status]) => (
              <div key={name} className="rounded-lg border border-slate-800 bg-slate-950/50 px-3 py-3">
                <p className="font-medium">{name}</p>
                <p className="mt-1 text-xs text-slate-500">{status}</p>
              </div>
            ))}
          </div>
        ) : null}

        {step === 6 ? (
          <div className="space-y-2 text-sm text-slate-200">
            <p><strong>Hospital:</strong> {facilityName}</p>
            <p><strong>Ownership / Level:</strong> {ownership} · {facilityLevel}</p>
            <p><strong>Subdomain:</strong> {computedSubdomain}</p>
            <p><strong>Modules:</strong> {modules.join(", ")}</p>
            <p><strong>Admin:</strong> {adminName} &lt;{adminEmail}&gt;</p>
            <p><strong>Mode:</strong> {mode}</p>
            <p className="rounded-lg border border-[#E8B84B]/30 bg-[#E8B84B]/10 p-3 text-xs text-[#E8B84B]">
              Provisioning records every step with explicit PASS/FAIL. Duplicate submit is blocked. Retry is idempotent.
            </p>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          disabled={step === 0 || submitting}
          onClick={() => {
            setError("")
            setStep((s) => Math.max(0, s - 1))
          }}
          className="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300 disabled:opacity-40"
        >
          Back
        </button>
        {step < STEPS.length - 1 ? (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void goNext()}
            className="rounded-lg bg-[#F97316] px-4 py-2 text-sm font-semibold text-[#07070A] disabled:opacity-50"
          >
            Continue
          </button>
        ) : (
          <button
            type="button"
            disabled={submitting}
            onClick={() => void submit()}
            className="rounded-lg bg-[#E8B84B] px-4 py-2 text-sm font-semibold text-[#07070A] disabled:opacity-50"
          >
            {submitting ? "Provisioning…" : "Provision Hospital"}
          </button>
        )}
      </div>
    </div>
  )
}

const inputCls = "w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm"

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-slate-400">{label}</span>
      {children}
      {error ? <span className="block text-xs text-red-400">{error}</span> : null}
    </label>
  )
}
