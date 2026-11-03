"use client"

import { useCallback, useState } from "react"
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Copy,
  Loader2,
  MinusCircle,
  RefreshCw,
  ShieldCheck,
  Terminal,
  XCircle,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { TallyBridgeError } from "@/lib/tally/bridge-client"
import { buildCompanyPinCommand, buildConnectorInstallCommand } from "@/lib/tally/bridge-command"
import {
  blockingChecks,
  installableChecks,
  manualChecks,
  requestBridgePreflight,
  type PrerequisiteCheck,
  type PrerequisiteReport,
  type PrerequisiteStatus,
} from "@/lib/tally/bridge-preflight"

export type SetupConnection = {
  token: string
  host: string
  port: string
  executable: string
  company: string
}

type Step = "welcome" | "check" | "install" | "verify" | "connect" | "ready"

const STEP_ORDER: Array<{ key: Step; label: string }> = [
  { key: "welcome", label: "Welcome" },
  { key: "check", label: "System check" },
  { key: "install", label: "Install" },
  { key: "verify", label: "Verify" },
  { key: "connect", label: "Connect Tally" },
  { key: "ready", label: "Ready" },
]

const STATUS_STYLE: Record<PrerequisiteStatus, { icon: typeof CheckCircle2; className: string }> = {
  passed: { icon: CheckCircle2, className: "text-[#22C55E]" },
  warning: { icon: AlertTriangle, className: "text-[#E8B84B]" },
  missing: { icon: XCircle, className: "text-destructive" },
  failed: { icon: XCircle, className: "text-destructive" },
  blocked: { icon: XCircle, className: "text-destructive" },
  not_applicable: { icon: MinusCircle, className: "text-muted-foreground" },
}

function CheckRow({ check }: { check: PrerequisiteCheck }) {
  const style = STATUS_STYLE[check.status]
  const Icon = style.icon
  return (
    <li className="flex gap-3 py-2">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${style.className}`} />
      <div className="min-w-0 space-y-0.5">
        <p className="text-sm font-medium">
          {check.name}
          {check.status === "not_applicable" ? (
            <span className="ml-2 text-xs font-normal text-muted-foreground">not needed here</span>
          ) : null}
        </p>
        <p className="text-sm text-muted-foreground">{check.message}</p>
        {check.remediation && check.status !== "passed" ? (
          <p className="text-xs text-foreground/80">{check.remediation}</p>
        ) : null}
        {check.detectedVersion ? (
          <p className="text-xs text-muted-foreground">
            Detected {check.detectedVersion}
            {check.requiredVersion ? ` · needs ${check.requiredVersion}` : ""}
          </p>
        ) : null}
      </div>
    </li>
  )
}

function Command({ value, onCopy }: { value: string; onCopy: (value: string) => void }) {
  return (
    <div className="space-y-2">
      <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{value}</pre>
      <Button variant="outline" size="sm" onClick={() => onCopy(value)}>
        <Copy className="h-4 w-4" /> Copy command
      </Button>
    </div>
  )
}

export function TallySetupAssistant({
  origin,
  connection,
  onChange,
  onDone,
  onClose,
  notify,
}: {
  origin: string
  connection: SetupConnection
  onChange: (next: SetupConnection) => void
  onDone: () => void
  onClose: () => void
  notify: (message: string, options?: { variant?: "destructive"; description?: string }) => void
}) {
  const [step, setStep] = useState<Step>("welcome")
  const [report, setReport] = useState<PrerequisiteReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [companies, setCompanies] = useState<string[]>([])
  const [loadingCompanies, setLoadingCompanies] = useState(false)

  const update = useCallback(
    (patch: Partial<SetupConnection>) => onChange({ ...connection, ...patch }),
    [connection, onChange],
  )

  const copy = useCallback(
    async (value: string) => {
      try {
        await navigator.clipboard.writeText(value)
        notify("Copied")
      } catch {
        notify("Could not copy — select the text manually", { variant: "destructive" })
      }
    },
    [notify],
  )

  const check = useCallback(
    async (target: Step = "check") => {
      if (!connection.token.trim()) {
        setCheckError("Paste the token the connector printed. Without it this page cannot ask the connector anything.")
        setStep(target)
        return
      }
      setChecking(true)
      setCheckError(null)
      try {
        setReport(await requestBridgePreflight({ token: connection.token }))
        setStep(target)
      } catch (error) {
        setReport(null)
        setCheckError(
          error instanceof TallyBridgeError
            ? error.message
            : "Nothing answered at 127.0.0.1:17890. The connector is not running on this computer yet.",
        )
        setStep(target)
      } finally {
        setChecking(false)
      }
    },
    [connection.token],
  )

  const discoverCompanies = useCallback(async () => {
    if (!connection.token.trim()) return
    setLoadingCompanies(true)
    try {
      const response = await fetch("http://127.0.0.1:17890/api/tally/companies", {
        headers: { "x-synapse-tally-bridge-token": connection.token.trim() },
        cache: "no-store",
      })
      if (!response.ok) {
        notify("Tally did not return a company list", {
          variant: "destructive",
          description: "Check that Tally is open, signed in, and has the company loaded.",
        })
        return
      }
      const data = (await response.json()) as { companies?: string[] }
      const found = Array.isArray(data.companies) ? data.companies : []
      setCompanies(found)
      if (found.length === 1) update({ company: found[0] })
      if (found.length === 0) notify("Tally answered, but no company is open")
    } catch {
      notify("Nothing answered at the connector", {
        variant: "destructive",
        description: "Start the connector, then find companies again.",
      })
    } finally {
      setLoadingCompanies(false)
    }
  }, [connection.token, notify, update])

  const blocking = report ? blockingChecks(report) : []
  const fixable = report ? installableChecks(report) : []
  const manual = report ? manualChecks(report) : []
  const warnings = report?.checks.filter((entry) => entry.status === "warning") ?? []
  const passed = report?.checks.filter((entry) => entry.status === "passed") ?? []
  const skipped = report?.checks.filter((entry) => entry.status === "not_applicable") ?? []

  // Both commands are pasted into PowerShell, and the company name comes from
  // Tally rather than from this page, so it is quoted by the shared builder
  // instead of being interpolated here.
  const installerCommand = buildConnectorInstallCommand({ origin, company: connection.company })
  const pinCommand = buildCompanyPinCommand(connection.company)

  const stepIndex = STEP_ORDER.findIndex((entry) => entry.key === step)

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-background/80 p-3 backdrop-blur-sm sm:p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="tally-setup-title"
        className="mx-auto w-full max-w-3xl"
      >
        <Card>
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div>
              <CardTitle id="tally-setup-title" className="flex items-center gap-2 text-xl">
                <ShieldCheck className="h-5 w-5 text-primary" />
                Set up the Tally connection
              </CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                Step {stepIndex + 1} of {STEP_ORDER.length} — {STEP_ORDER[stepIndex]?.label}
              </p>
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          </CardHeader>
          <CardContent className="space-y-5">
            {step === "welcome" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Let&apos;s prepare this computer to connect your Tally accounting system securely to SYNAPSE
                  Pharmacy. Nothing is read from Tally and nothing is written to it during setup.
                </p>
                <div className="space-y-2">
                  <Label htmlFor="setup-token">Connector token</Label>
                  <Input
                    id="setup-token"
                    type="password"
                    autoComplete="off"
                    value={connection.token}
                    onChange={(event) => {
                      update({ token: event.target.value })
                      setCheckError(null)
                    }}
                    placeholder="Paste the 64-character token the connector printed"
                  />
                  <p className="text-xs text-muted-foreground">
                    The token is generated on this computer by the connector and is never sent anywhere else.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => void check()} disabled={checking}>
                    {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                    Check My Computer
                  </Button>
                  <Button variant="outline" onClick={() => setStep("install")}>
                    I need to install the connector first
                  </Button>
                </div>
              </div>
            ) : null}

            {step === "check" ? (
              <div className="space-y-4">
                {checking ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Checking this computer…
                  </p>
                ) : null}
                {checkError ? (
                  <div role="alert" className="space-y-3 rounded-md border border-destructive/40 bg-destructive/10 p-3">
                    <p className="text-sm">{checkError}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => void check()}>
                        <RefreshCw className="h-4 w-4" /> Try again
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setStep("install")}>
                        Install the connector
                      </Button>
                    </div>
                  </div>
                ) : null}

                {report ? (
                  <>
                    <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
                      <span className="font-medium">
                        {report.summary.ready
                          ? "Every required check passed."
                          : `${blocking.length} required ${blocking.length === 1 ? "check needs" : "checks need"} attention.`}
                      </span>
                      <span className="text-muted-foreground">
                        {report.summary.passed} passed · {report.summary.warning} warnings ·{" "}
                        {report.summary.not_applicable} not needed
                      </span>
                    </div>

                    {blocking.length > 0 ? (
                      <div>
                        <p className="text-sm font-medium">Needs attention</p>
                        <ul className="divide-y">
                          {blocking.map((entry) => (
                            <CheckRow key={entry.id} check={entry} />
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {warnings.length > 0 ? (
                      <div>
                        <p className="text-sm font-medium">Warnings</p>
                        <ul className="divide-y">
                          {warnings.map((entry) => (
                            <CheckRow key={entry.id} check={entry} />
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {passed.length > 0 ? (
                      <div>
                        <p className="text-sm font-medium">Passed</p>
                        <ul className="divide-y">
                          {passed.map((entry) => (
                            <CheckRow key={entry.id} check={entry} />
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    {skipped.length > 0 ? (
                      <div>
                        <p className="text-sm font-medium">Not needed on this computer</p>
                        <ul className="divide-y">
                          {skipped.map((entry) => (
                            <CheckRow key={entry.id} check={entry} />
                          ))}
                        </ul>
                      </div>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" onClick={() => void check()} disabled={checking}>
                        <RefreshCw className="h-4 w-4" /> Check again
                      </Button>
                      {report.summary.ready ? (
                        <Button onClick={() => setStep("verify")}>
                          Continue to verification <ArrowRight className="h-4 w-4" />
                        </Button>
                      ) : (
                        <Button onClick={() => setStep("install")}>
                          Fix what is missing <ArrowRight className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </>
                ) : null}
              </div>
            ) : null}

            {step === "install" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  The connector installer puts everything the bridge needs on this computer. It needs no Git,
                  Python, Docker, Supabase CLI or development tools.
                </p>

                {fixable.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium">The installer can fix these</p>
                    <ul className="mt-1 list-disc pl-5 text-sm text-muted-foreground">
                      {fixable.map((entry) => (
                        <li key={entry.id}>{entry.name}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {manual.length > 0 ? (
                  <div>
                    <p className="text-sm font-medium">These need you</p>
                    <ul className="mt-1 space-y-1 text-sm text-muted-foreground">
                      {manual.map((entry) => (
                        <li key={entry.id}>
                          <span className="text-foreground">{entry.name}:</span>{" "}
                          {entry.remediation ?? entry.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div className="space-y-2 rounded-lg border p-3">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <Terminal className="h-4 w-4 text-primary" /> Run this in PowerShell on the pharmacy computer
                  </p>
                  <Command value={installerCommand} onCopy={(value) => void copy(value)} />
                  <p className="text-xs text-muted-foreground">
                    The installer downloads Node.js only from nodejs.org, checks its published checksum and its
                    signature before running it, and never changes Windows Defender or the firewall. It listens
                    on 127.0.0.1 only. When it finishes it prints a token for this page.
                  </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Button variant="outline" onClick={() => setStep("welcome")}>
                    Back to token
                  </Button>
                  <Button onClick={() => void check()}>
                    <RefreshCw className="h-4 w-4" /> I have installed it — check again
                  </Button>
                </div>
              </div>
            ) : null}

            {step === "verify" ? (
              <div className="space-y-4">
                {checking ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Verifying…
                  </p>
                ) : null}
                <p className="text-sm text-muted-foreground">
                  This runs the same checks again. Nothing is exported, applied or written while verifying.
                </p>
                {report ? (
                  <div
                    className={`rounded-md border p-3 text-sm ${
                      report.summary.ready
                        ? "border-[#22C55E]/40 bg-[#22C55E]/10"
                        : "border-destructive/40 bg-destructive/10"
                    }`}
                  >
                    {report.summary.ready
                      ? "Everything this page needs is in place. Continue to connect Tally."
                      : `${blocking.length} required ${blocking.length === 1 ? "check is" : "checks are"} still not satisfied.`}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No check has run yet. Run the verification now.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => void check("verify")} disabled={checking}>
                    <RefreshCw className="h-4 w-4" /> Verify again
                  </Button>
                  {report?.summary.ready ? (
                    <Button onClick={() => setStep("connect")}>
                      Continue to Tally <ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={() => setStep("check")}>
                      See what is missing
                    </Button>
                  )}
                </div>
              </div>
            ) : null}

            {step === "connect" ? (
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Open Tally, sign in, and load the company being cut over. Discovery reads the company names
                  Tally has open; it reads no balances or vouchers.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-host">Tally host</Label>
                    <Input
                      id="setup-host"
                      value={connection.host}
                      onChange={(event) => update({ host: event.target.value })}
                      placeholder="127.0.0.1"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="setup-port">Tally HTTP port</Label>
                    <Input
                      id="setup-port"
                      value={connection.port}
                      onChange={(event) => update({ port: event.target.value })}
                      placeholder="9000"
                      inputMode="numeric"
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="setup-company">Tally company</Label>
                    <div className="flex flex-wrap gap-2">
                      {companies.length > 0 ? (
                        <select
                          id="setup-company"
                          value={connection.company}
                          onChange={(event) => update({ company: event.target.value })}
                          className="h-10 min-w-64 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                        >
                          {connection.company && !companies.includes(connection.company) ? (
                            <option value={connection.company}>{connection.company}</option>
                          ) : null}
                          {companies.map((company) => (
                            <option key={company} value={company}>
                              {company}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id="setup-company"
                          value={connection.company}
                          onChange={(event) => update({ company: event.target.value })}
                          placeholder="Company name, exactly as Tally shows it"
                          autoComplete="off"
                          className="min-w-64 flex-1"
                        />
                      )}
                      <Button
                        variant="outline"
                        onClick={() => void discoverCompanies()}
                        disabled={loadingCompanies || !connection.token.trim()}
                      >
                        {loadingCompanies ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <RefreshCw className="h-4 w-4" />
                        )}
                        Find companies
                      </Button>
                    </div>
                  </div>
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="setup-executable">Tally program path (optional)</Label>
                    <Input
                      id="setup-executable"
                      value={connection.executable}
                      onChange={(event) => update({ executable: event.target.value })}
                      placeholder="C:\Program Files\TallyPrime\tally.exe"
                      autoComplete="off"
                    />
                  </div>
                </div>

                {pinCommand ? (
                  <div className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm font-medium">Pin this company in the connector</p>
                    <p className="text-xs text-muted-foreground">
                      Run this once so every export names the same company, then start the connector from the
                      Start Menu.
                    </p>
                    <Command value={pinCommand} onCopy={(value) => void copy(value)} />
                  </div>
                ) : null}

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => void check("connect")} disabled={checking}>
                    <RefreshCw className="h-4 w-4" /> Check the connection
                  </Button>
                  {report?.summary.ready ? (
                    <Button onClick={() => setStep("ready")}>
                      Finish setup <ArrowRight className="h-4 w-4" />
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {step === "ready" ? (
              <div className="space-y-4">
                <div className="flex items-start gap-3 rounded-md border border-[#22C55E]/40 bg-[#22C55E]/10 p-3">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#22C55E]" />
                  <div>
                    <p className="text-sm font-medium">Ready to bridge Tally</p>
                    <p className="text-sm text-muted-foreground">
                      The connector is verified. Reading Tally is the next step, and it still stages everything
                      for review before anything is applied.
                    </p>
                  </div>
                </div>
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Connector</dt>
                    <dd>
                      {report?.connector.version ?? "—"} (contract {report?.connector.contractVersion ?? "—"})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Tally target</dt>
                    <dd>{report?.target ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Company</dt>
                    <dd>{connection.company || report?.company || "not pinned"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Checked</dt>
                    <dd>{report?.checkedAt ? new Date(report.checkedAt).toLocaleString() : "—"}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={onDone}>
                    Continue to Tally Data Extraction <ArrowRight className="h-4 w-4" />
                  </Button>
                  <Button variant="outline" onClick={() => void check("verify")} disabled={checking}>
                    <RefreshCw className="h-4 w-4" /> Check again
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  The extraction reads All Masters and the Day Book over Tally&apos;s local XML/HTTP interface.
                  It does not post, alter or delete anything in Tally.
                </p>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
