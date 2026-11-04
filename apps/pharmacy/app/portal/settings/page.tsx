"use client"

import { useEffect, useState } from "react"

// Force dynamic rendering
export const dynamic = 'force-dynamic'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useToast } from "@/hooks/use-toast"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { AlertTriangle, Loader2, Upload, X, Printer } from "lucide-react"
import Image from "next/image"
import { escapeHtml, safeImageSrc } from "@/lib/html"

interface Settings {
  pharmacyName: string
  location: string
  contact: string
  email: string
  footerText: string
  currency: string
  taxRate: number
  vatEnabled: boolean
  vatRate: number
  logo?: string
  printerType: string
  receiptPaperWidth: "58" | "80" | "a4"
  receiptFontScale: number
  autoPrintReceipt: boolean
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Settings>({
    pharmacyName: "",
    location: "",
    contact: "",
    email: "",
    footerText: "",
    currency: "UGX",
    taxRate: 0,
    vatEnabled: false,
    vatRate: 18,
    logo: "",
    printerType: "default",
    receiptPaperWidth: "80",
    receiptFontScale: 1,
    autoPrintReceipt: false,
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [logoFile, setLogoFile] = useState<File | null>(null)
  const [logoPreview, setLogoPreview] = useState<string>("")
  const [resetName, setResetName] = useState("")
  const [resetPreview, setResetPreview] = useState<Record<string, number> | null>(null)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const { toast } = useToast()
  const { user } = usePharmacySession()

  useEffect(() => {
    fetchSettings()
  }, [])

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/admin/settings")
      if (response.ok) {
        const data = await response.json()
        if (data) {
          // Map snake_case DB columns → camelCase state fields
          const printerType = data.printer_type ?? data.printerType ?? "default"
          const paperRaw = String(data.receipt_paper_width ?? data.receiptPaperWidth ?? "").toLowerCase()
          const receiptPaperWidth: Settings["receiptPaperWidth"] =
            paperRaw === "58" || paperRaw === "a4"
              ? paperRaw
              : String(printerType).includes("58")
                ? "58"
                : String(printerType).includes("brother") || String(printerType).includes("a4")
                  ? "a4"
                  : "80"
          setSettings({
            pharmacyName: data.pharmacy_name ?? data.pharmacyName ?? "",
            location: data.location ?? "",
            contact: data.contact ?? "",
            email: data.email ?? "",
            footerText: data.footer_text ?? data.footerText ?? "",
            currency: data.currency ?? "UGX",
            taxRate: Number(data.tax_rate ?? data.taxRate ?? 0),
            vatEnabled: Boolean(data.vat_enabled ?? data.vatEnabled),
            vatRate: Number(data.vat_rate ?? data.vatRate ?? 18),
            logo: data.logo ?? "",
            printerType,
            receiptPaperWidth,
            receiptFontScale: Number(data.receipt_font_scale ?? data.receiptFontScale ?? 1) || 1,
            autoPrintReceipt: Boolean(data.auto_print_receipt ?? data.autoPrintReceipt),
          })
          if (data.logo) setLogoPreview(data.logo)
        }
      }
    } catch (error) {
      console.error("Failed to fetch settings:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0]
      setLogoFile(file)
      
      // Create preview
      const reader = new FileReader()
      reader.onloadend = () => {
        setLogoPreview(reader.result as string)
      }
      reader.readAsDataURL(file)
    }
  }

  const removeLogo = () => {
    setLogoFile(null)
    setLogoPreview("")
    setSettings({ ...settings, logo: "" })
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsSaving(true)

    try {
      let logoData = settings.logo
      
      // If new logo file is selected, use the preview (base64)
      if (logoFile && logoPreview) {
        logoData = logoPreview
      }

      const response = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...settings, logo: logoData }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: "Settings saved successfully",
        })
        setLogoFile(null)
      } else {
        const problem = await response.json().catch(() => null)
        toast({
          variant: "destructive",
          title: "Error",
          description:
            typeof problem?.error === "string" ? problem.error : "Failed to save settings",
        })
      }
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Error",
        description: "An error occurred",
      })
    } finally {
      setIsSaving(false)
    }
  }

  const pharmacyName = settings.pharmacyName.trim()
  const isResetConfirmed = pharmacyName !== "" && resetName.trim() === pharmacyName
  // The route is admin-only (requirePharmacyAdmin); staff who can manage settings
  // should not be shown a control that would answer 403.
  const canReset =
    Boolean(user?.isAdmin) ||
    user?.pharmacyRole === "pharmacy_admin" ||
    user?.pharmacyRole === "pharmacy_ceo"

  const requestReset = async (dryRun: boolean) => {
    const response = await fetch("/api/admin/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmName: dryRun ? "" : resetName.trim(), dryRun }),
    })
    const body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new Error(
        typeof body?.error === "string" ? body.error : "The reset request failed",
      )
    }
    return body as { totalRows?: number; counts?: Record<string, number> }
  }

  const handlePreviewReset = async () => {
    setIsPreviewing(true)
    try {
      const body = await requestReset(true)
      setResetPreview(body.counts ?? {})
      toast({
        title: "Nothing was deleted",
        description: `${Number(body.totalRows ?? 0).toLocaleString()} records would be erased.`,
      })
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Preview failed",
        description: error instanceof Error ? error.message : "An error occurred",
      })
    } finally {
      setIsPreviewing(false)
    }
  }

  const handleReset = async () => {
    if (!isResetConfirmed) return
    const confirmed = window.confirm(
      `Erase every product, sale, purchase, customer and imported record in ${pharmacyName}?\n\nThis cannot be undone. Staff logins and the pharmacy account are kept.`,
    )
    if (!confirmed) return

    setIsResetting(true)
    try {
      const body = await requestReset(false)
      setResetPreview(null)
      setResetName("")
      toast({
        title: "Pharmacy data erased",
        description: `${Number(body.totalRows ?? 0).toLocaleString()} records removed. Reloading the portal.`,
      })
      window.setTimeout(() => window.location.reload(), 1200)
    } catch (error) {
      toast({
        variant: "destructive",
        title: "Reset failed",
        description: error instanceof Error ? error.message : "An error occurred",
      })
    } finally {
      setIsResetting(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground mt-1 sm:mt-2 text-sm sm:text-base">Configure pharmacy information and system settings</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Pharmacy Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Pharmacy Logo</Label>
              <div className="flex items-center gap-4">
                {logoPreview && (
                  <div className="relative w-32 h-32 border rounded-lg overflow-hidden">
                    <Image
                      src={logoPreview}
                      alt="Logo preview"
                      fill
                      className="object-contain"
                    />
                    <button
                      type="button"
                      onClick={removeLogo}
                      className="absolute top-1 right-1 bg-red-500 text-white rounded-full p-1 hover:bg-red-600"
                      title="Remove Logo"
                      aria-label="Remove Logo"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                )}
                <div>
                  <Input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoChange}
                    className="mb-2"
                  />
                  <p className="text-xs text-muted-foreground">Upload your pharmacy logo (PNG, JPG, or GIF)</p>
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="pharmacyName">Pharmacy Name *</Label>
                <Input
                  id="pharmacyName"
                  value={settings.pharmacyName}
                  onChange={(e) => setSettings({ ...settings, pharmacyName: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="location">Location *</Label>
                <Input
                  id="location"
                  value={settings.location}
                  onChange={(e) => setSettings({ ...settings, location: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="contact">Contact *</Label>
                <Input
                  id="contact"
                  value={settings.contact}
                  onChange={(e) => setSettings({ ...settings, contact: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email *</Label>
                <Input
                  id="email"
                  type="email"
                  value={settings.email}
                  onChange={(e) => setSettings({ ...settings, email: e.target.value })}
                  required
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Receipt Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="footerText">Receipt Footer Text</Label>
              <Input
                id="footerText"
                value={settings.footerText}
                onChange={(e) => setSettings({ ...settings, footerText: e.target.value })}
                placeholder="Thank you for your purchase!"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="currency">Currency</Label>
                <Input
                  id="currency"
                  value={settings.currency}
                  onChange={(e) => setSettings({ ...settings, currency: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="taxRate">Legacy Tax Rate (%)</Label>
                <Input
                  id="taxRate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  value={settings.taxRate}
                  onChange={(e) => setSettings({ ...settings, taxRate: parseFloat(e.target.value) })}
                />
                <p className="text-xs text-muted-foreground">
                  A percentage: 18 means 18%, not 0.18. Applied to every line only while
                  VAT is off. Leave at 0 to charge no tax.
                </p>
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <label className="flex items-start gap-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={settings.vatEnabled}
                  onChange={(e) => setSettings({ ...settings, vatEnabled: e.target.checked })}
                />
                <span>
                  <span className="font-medium">Charge VAT</span>
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    Adds VAT to products marked standard-rated. Exempt and zero-rated
                    products are never taxed, and sales are refused while the rate is
                    invalid.</span>
                </span>
              </label>
              <div className="space-y-2">
                <Label htmlFor="vatRate">VAT Rate (%)</Label>
                <Input
                  id="vatRate"
                  type="number"
                  step="0.01"
                  min="0"
                  max="100"
                  disabled={!settings.vatEnabled}
                  value={settings.vatRate}
                  onChange={(e) => setSettings({ ...settings, vatRate: parseFloat(e.target.value) })}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Printer Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm space-y-2">
              <p className="font-medium text-foreground">Quick setup</p>
              <ol className="list-decimal list-inside text-muted-foreground space-y-1 text-xs sm:text-sm">
                <li>Upload your pharmacy logo above (it prints at the top of every receipt).</li>
                <li>Choose your printer model and paper width below.</li>
                <li>Click <strong>Test print</strong> — pick your receipt printer in the browser dialog.</li>
                <li>Optional: enable auto-print after each POS sale.</li>
              </ol>
            </div>
            <div className="space-y-2">
              <Label htmlFor="printerType">Printer Type</Label>
              <select
                id="printerType"
                title="Select printer type"
                aria-label="Printer Type"
                value={settings.printerType}
                onChange={(e) => {
                  const printerType = e.target.value
                  const nextPaper: Settings["receiptPaperWidth"] = printerType.includes("58")
                    ? "58"
                    : printerType.includes("brother") || printerType.includes("a4")
                      ? "a4"
                      : printerType.includes("80") || printerType.includes("epson") || printerType.includes("star")
                        ? "80"
                        : settings.receiptPaperWidth
                  setSettings({ ...settings, printerType, receiptPaperWidth: nextPaper })
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="default">Default System Printer</option>
                <option value="brother-dcp-t300">Brother DCP-T300</option>
                <option value="brother-dcp-t500w">Brother DCP-T500W</option>
                <option value="epson-tm-t20">Epson TM-T20 (Thermal)</option>
                <option value="epson-tm-t88">Epson TM-T88 (Thermal)</option>
                <option value="star-tsp100">Star TSP100 (Thermal)</option>
                <option value="generic-58mm">Generic 58mm Thermal</option>
                <option value="generic-80mm">Generic 80mm Thermal</option>
              </select>
              <p className="text-xs text-muted-foreground">Select your printer model for optimized receipt printing</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="receiptPaperWidth">Paper width</Label>
                <select
                  id="receiptPaperWidth"
                  title="Receipt paper width"
                  aria-label="Receipt paper width"
                  value={settings.receiptPaperWidth}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      receiptPaperWidth: e.target.value as Settings["receiptPaperWidth"],
                    })
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="58">58mm thermal</option>
                  <option value="80">80mm thermal</option>
                  <option value="a4">A4 / letter</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="receiptFontScale">Receipt font size</Label>
                <select
                  id="receiptFontScale"
                  title="Receipt font size"
                  aria-label="Receipt font size"
                  value={String(settings.receiptFontScale)}
                  onChange={(e) =>
                    setSettings({ ...settings, receiptFontScale: Number(e.target.value) || 1 })
                  }
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                >
                  <option value="0.9">Compact</option>
                  <option value="1">Standard</option>
                  <option value="1.15">Large</option>
                  <option value="1.3">Extra large</option>
                </select>
              </div>
            </div>
            <label className="flex items-start gap-3 text-sm text-foreground">
              <input
                type="checkbox"
                className="mt-1"
                checked={settings.autoPrintReceipt}
                onChange={(e) => setSettings({ ...settings, autoPrintReceipt: e.target.checked })}
              />
              <span>
                <span className="font-medium">Auto-print after sale</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Opens the print dialog immediately when a POS sale completes (no “Print receipt?” prompt).
                </span>
              </span>
            </label>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const win = window.open("", "_blank", "width=420,height=640")
                if (!win) {
                  toast({
                    variant: "destructive",
                    title: "Pop-up blocked",
                    description: "Allow pop-ups for this site, then try Test print again.",
                  })
                  return
                }
                const logoSrc = safeImageSrc(logoPreview)
                const logoHtml = logoSrc
                  ? `<img src="${logoSrc}" alt="" style="max-height:64px;max-width:70%;display:block;margin:0 auto 8px;" />`
                  : ""
                win.document.write(`<!doctype html><html><head><title>Receipt test</title>
                  <style>
                    body{font-family:ui-monospace,Menlo,monospace;padding:16px;color:#000}
                    .w{width:${settings.receiptPaperWidth === "58" ? "58mm" : settings.receiptPaperWidth === "a4" ? "180mm" : "80mm"};margin:0 auto;font-size:${Math.round(12 * (settings.receiptFontScale || 1))}px}
                    .c{text-align:center}.b{font-weight:700}.row{display:flex;justify-content:space-between;gap:8px}
                    hr{border:none;border-top:1px dashed #000;margin:8px 0}
                  </style></head><body><div class="w">
                  ${logoHtml}
                  <div class="c b">${escapeHtml(settings.pharmacyName || "Pharmacy")}</div>
                  <div class="c">${escapeHtml(settings.location || "")}</div>
                  <div class="c">${escapeHtml(settings.contact || "")}</div>
                  <hr/><div class="c b">*** TEST RECEIPT ***</div><hr/>
                  <div class="row"><span>Item</span><span>1,000</span></div>
                  <div class="row b"><span>TOTAL</span><span>1,000</span></div>
                  <hr/><div class="c">${escapeHtml(settings.footerText || "Thank you for your purchase!")}</div>
                  </div>
                  <script>window.onload=function(){window.print()}</script>
                  </body></html>`)
                win.document.close()
              }}
            >
              <Printer className="h-4 w-4 mr-2" />
              Test print
            </Button>
            {(settings.printerType === "brother-dcp-t300" || settings.receiptPaperWidth === "a4") && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                <p className="text-sm text-blue-800">
                  <strong>A4 / inkjet:</strong> Receipts render at letter width. Connect the printer and confirm
                  drivers are installed before pilot sales.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={isSaving}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Settings"
            )}
          </Button>
        </div>
      </form>

      {canReset && (
        <Card className="mt-6 border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Reset pharmacy data
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Erases every product, batch, stock record, sale, purchase, customer, supplier,
              accounting entry, setting and Tally import in this pharmacy, so an import can be
              run again from the start. Staff logins and the pharmacy account are kept.
              <strong className="block mt-1 text-destructive">This cannot be undone.</strong>
            </p>

            <div className="space-y-2">
              <Label htmlFor="resetName">
                Type the pharmacy name to confirm: <strong>{pharmacyName || "—"}</strong>
              </Label>
              <Input
                id="resetName"
                value={resetName}
                onChange={(e) => setResetName(e.target.value)}
                placeholder={pharmacyName}
                autoComplete="off"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={handlePreviewReset}
                disabled={isPreviewing || isResetting}
              >
                {isPreviewing ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Counting...
                  </>
                ) : (
                  "Preview what will be deleted"
                )}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleReset}
                disabled={!isResetConfirmed || isResetting || isPreviewing}
              >
                {isResetting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Erasing...
                  </>
                ) : (
                  "Erase all pharmacy data"
                )}
              </Button>
            </div>

            {resetPreview && (
              <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm">
                {Object.entries(resetPreview)
                  .filter(([, count]) => count > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([table, count]) => (
                    <div key={table} className="flex justify-between gap-4">
                      <span className="capitalize text-muted-foreground">
                        {table.replace(/^pharmacy_/, "").replace(/_/g, " ")}
                      </span>
                      <span className="tabular-nums text-foreground">
                        {count.toLocaleString()}
                      </span>
                    </div>
                  ))}
                {Object.values(resetPreview).every((count) => count === 0) && (
                  <p className="text-muted-foreground">There is nothing to delete.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
