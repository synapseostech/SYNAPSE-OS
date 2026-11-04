"use client"

import { useMemo, useState } from "react"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { useToast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DATASETS, findDataset, type ExportDataset } from "@/lib/export/datasets"
import { Download, Loader2 } from "lucide-react"

export const dynamic = "force-dynamic"

const GROUPS = (() => {
  const groups = new Map<string, ExportDataset[]>()
  for (const dataset of DATASETS) {
    const items = groups.get(dataset.group) ?? []
    items.push(dataset)
    groups.set(dataset.group, items)
  }
  return [...groups.entries()].map(([label, items]) => ({ label, items }))
})()

function isAdmin(user: { isAdmin: boolean; pharmacyRole: string } | null): boolean {
  if (!user) return false
  return user.isAdmin || user.pharmacyRole === "pharmacy_admin" || user.pharmacyRole === "pharmacy_ceo"
}

function filenameFrom(disposition: string | null, fallback: string): string {
  const match = disposition?.match(/filename="([^"]+)"/)
  return match ? match[1]! : fallback
}

/** Today as the pharmacy reads it, not as UTC does. */
function kampalaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date())
}

export default function ExportPage() {
  const { user, isLoading } = usePharmacySession()
  const { toast } = useToast()

  const today = useMemo(kampalaToday, [])
  const [datasetId, setDatasetId] = useState(DATASETS[0]!.id)
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`)
  const [to, setTo] = useState(today)
  const [format, setFormat] = useState<"csv" | "xlsx">("xlsx")
  const [downloading, setDownloading] = useState(false)

  const dataset = findDataset(datasetId) ?? DATASETS[0]!

  const download = async () => {
    if (dataset.dateScoped && (!from || !to)) {
      toast({ variant: "destructive", title: "Choose a date range" })
      return
    }
    if (dataset.dateScoped && to < from) {
      toast({ variant: "destructive", title: "The end date is before the start date" })
      return
    }

    const params = new URLSearchParams({ dataset: dataset.id, format })
    if (dataset.dateScoped) {
      params.set("from", from)
      params.set("to", to)
    }

    setDownloading(true)
    try {
      const response = await fetch(`/api/admin/export?${params.toString()}`)
      if (!response.ok) {
        const body = await response.json().catch(() => ({}))
        toast({
          variant: "destructive",
          title: "Export failed",
          description: body.error ?? `The server answered ${response.status}.`,
        })
        return
      }

      const blob = await response.blob()
      const url = window.URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = filenameFrom(
        response.headers.get("Content-Disposition"),
        `synapse-${dataset.id}.${format}`,
      )
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.URL.revokeObjectURL(url)
    } catch {
      toast({
        variant: "destructive",
        title: "Export failed",
        description: "The download did not start. Check the connection and try again.",
      })
    } finally {
      setDownloading(false)
    }
  }

  if (isLoading) {
    return (
      <div role="status" className="text-sm text-muted-foreground">
        Checking access…
      </div>
    )
  }

  if (!isAdmin(user)) {
    return (
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Export data</h1>
        <div role="alert" className="mt-4 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm">
          Only the pharmacy administrator can export the pharmacy&apos;s data.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Export data</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Download the pharmacy&apos;s own records as a spreadsheet. Nothing is changed by an export, and
          every export is recorded in the activity log.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">What to export</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="export-dataset">Category</Label>
            <select
              id="export-dataset"
              value={datasetId}
              onChange={(event) => setDatasetId(event.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:text-sm"
            >
              {GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.items.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="text-sm text-muted-foreground">{dataset.description}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="export-from">From</Label>
              <Input
                id="export-from"
                type="date"
                value={from}
                max={to}
                disabled={!dataset.dateScoped}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="export-to">To</Label>
              <Input
                id="export-to"
                type="date"
                value={to}
                min={from}
                disabled={!dataset.dateScoped}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {dataset.dateScoped
              ? "Both days are included. Dates follow the pharmacy's business day in Kampala."
              : "This is a current snapshot, so it covers the whole list regardless of date."}
          </p>

          <div className="space-y-2">
            <Label>Format</Label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant={format === "xlsx" ? "default" : "outline"}
                aria-pressed={format === "xlsx"}
                onClick={() => setFormat("xlsx")}
              >
                Excel
              </Button>
              <Button
                type="button"
                variant={format === "csv" ? "default" : "outline"}
                aria-pressed={format === "csv"}
                onClick={() => setFormat("csv")}
              >
                CSV
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              A single file holds up to 100,000 records. Narrow the dates if a range is larger.
            </p>
            <Button type="button" onClick={download} disabled={downloading}>
              {downloading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {downloading ? "Preparing…" : "Download"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
