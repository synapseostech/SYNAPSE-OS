"use client"

import { useEffect, useState } from "react"
import { useToast } from "@/hooks/use-toast"
import { Loader2, RefreshCw, Save, Wifi } from "lucide-react"

export const dynamic = "force-dynamic"

// ─── Types ────────────────────────────────────────────────────────────────────

interface NetworkSettings {
  isNetworkMember: boolean
  acceptsRefillRequests: boolean
  networkListingName: string
}

interface NetworkInventoryRow {
  id: string
  pharmacy_tenant_id: string
  drug_name: string
  generic_name: string | null
  brand_name: string | null
  dosage_form: string | null
  strength: string | null
  quantity_in_stock: number | null
  unit_price_ugx: number | null
  is_available: boolean
  last_synced_at: string | null
}

// ─── Toggle component ─────────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-card",
        checked ? "bg-emerald-500" : "bg-muted-foreground/30",
        disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1",
        ].join(" ")}
      />
    </button>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NetworkPage() {
  const { toast } = useToast()

  const [settings, setSettings] = useState<NetworkSettings>({
    isNetworkMember: false,
    acceptsRefillRequests: false,
    networkListingName: "",
  })
  const [inventory, setInventory] = useState<NetworkInventoryRow[]>([])
  const [isFetching, setIsFetching] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)

  // ── Fetch on mount ────────────────────────────────────────────────────────────

  useEffect(() => {
    fetchData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function fetchData() {
    setIsFetching(true)
    try {
      const res = await fetch("/api/admin/network")
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json()
      setSettings(json.settings)
      setInventory(json.inventory ?? [])
    } catch (err) {
      console.error("Failed to fetch network data:", err)
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to load network data.",
      })
    } finally {
      setIsFetching(false)
    }
  }

  // ── Derived: last synced ──────────────────────────────────────────────────────

  const lastSynced = (() => {
    if (inventory.length === 0) return "Never"
    const timestamps = inventory
      .map((r) => r.last_synced_at)
      .filter((t): t is string => !!t)
    if (timestamps.length === 0) return "Never"
    const latest = new Date(
      Math.max(...timestamps.map((t) => new Date(t).getTime()))
    )
    return latest.toLocaleString()
  })()

  // ── Save handler ─────────────────────────────────────────────────────────────

  async function handleSave() {
    setIsSaving(true)
    try {
      const res = await fetch("/api/admin/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          isNetworkMember: settings.isNetworkMember,
          acceptsRefillRequests: settings.acceptsRefillRequests,
          networkListingName: settings.networkListingName || null,
        }),
      })
      if (!res.ok) throw new Error(await res.text())
      toast({ title: "Saved", description: "Network settings updated." })
    } catch (err) {
      console.error("Save failed:", err)
      toast({
        variant: "destructive",
        title: "Error",
        description: "Failed to save network settings.",
      })
    } finally {
      setIsSaving(false)
    }
  }

  // ── Sync Now handler ─────────────────────────────────────────────────────────

  async function handleSyncNow() {
    if (!settings.isNetworkMember) {
      toast({
        variant: "destructive",
        title: "Not listed",
        description: "Enable 'Listed in Synapse App' before syncing.",
      })
      return
    }
    setIsSyncing(true)
    try {
      const res = await fetch("/api/admin/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync" }),
      })
      if (!res.ok) throw new Error(await res.text())
      const { synced } = await res.json()
      if (synced === 0) {
        toast({ title: "Nothing to sync", description: "No active products found." })
      } else {
        toast({ title: "Synced", description: `${synced} product(s) synced to the network.` })
        await fetchData()
      }
    } catch (err) {
      console.error("Sync failed:", err)
      toast({
        variant: "destructive",
        title: "Sync failed",
        description: "An error occurred while syncing inventory.",
      })
    } finally {
      setIsSyncing(false)
    }
  }

  // ── Loading state ─────────────────────────────────────────────────────────────

  if (isFetching) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Synapse Network</h1>
        <p className="text-muted-foreground mt-1 text-sm sm:text-base">
          Manage your pharmacy&apos;s presence in the Synapse patient app
        </p>
      </div>

      {/* ── Section 1: Network Status ───────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-6">
        <div className="flex items-center gap-2">
          <Wifi className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold text-foreground">Network Status</h2>
        </div>

        {/* Toggle: Listed */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Listed in Synapse App</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Patients can find your pharmacy in the app
            </p>
          </div>
          <Toggle
            checked={settings.isNetworkMember}
            onChange={(v) => setSettings((s) => ({ ...s, isNetworkMember: v }))}
          />
        </div>

        {/* Network listing name (visible when listed) */}
        {settings.isNetworkMember && (
          <div className="space-y-1.5">
            <label htmlFor="listing-name" className="text-sm font-medium text-foreground">
              Network listing name
            </label>
            <p className="text-xs text-muted-foreground">
              The name shown to patients in the Synapse app
            </p>
            <input
              id="listing-name"
              type="text"
              value={settings.networkListingName}
              onChange={(e) =>
                setSettings((s) => ({ ...s, networkListingName: e.target.value }))
              }
              placeholder="Your pharmacy name as seen by patients"
              className="w-full max-w-md rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        )}

        {/* Toggle: Refill requests */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-foreground">Accept refill requests</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Patients can request prescription refills via the app
            </p>
          </div>
          <Toggle
            checked={settings.acceptsRefillRequests}
            onChange={(v) => setSettings((s) => ({ ...s, acceptsRefillRequests: v }))}
          />
        </div>

        {/* Footer: last synced + actions */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-border">
          <p className="text-xs text-muted-foreground">
            Last synced: <span className="text-foreground">{lastSynced}</span>
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSyncNow}
              disabled={isSyncing || !settings.isNetworkMember}
              className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-background text-sm text-foreground hover:border-primary/40 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSyncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Sync Now
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              Save Changes
            </button>
          </div>
        </div>
      </div>

      {/* ── Section 2: Network Inventory ────────────────────────────────────────── */}
      <div className="bg-card border border-border rounded-xl p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">What patients see in the app</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Inventory currently published to the Synapse network
          </p>
        </div>

        {inventory.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground border border-dashed border-border rounded-lg">
            No inventory synced yet — click &quot;Sync Now&quot; to publish your products.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {["Drug Name", "Dosage Form", "Strength", "In Stock", "Qty", "Last Synced"].map(
                    (col) => (
                      <th
                        key={col}
                        className="text-left py-2 pr-4 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                      >
                        {col}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <tbody>
                {inventory.map((row) => (
                  <tr key={row.id} className="border-b border-border hover:bg-muted/40">
                    <td className="py-3 pr-4 font-medium text-foreground">
                      {row.drug_name}
                      {row.generic_name && (
                        <span className="block text-xs text-muted-foreground">
                          {row.generic_name}
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.dosage_form ?? "—"}
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.strength ?? "—"}
                    </td>
                    <td className="py-3 pr-4">
                      <span
                        className={[
                          "inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium",
                          row.is_available
                            ? "bg-green-500/10 text-green-400"
                            : "bg-red-500/10 text-red-400",
                        ].join(" ")}
                      >
                        {row.is_available ? "Yes" : "No"}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      {row.quantity_in_stock ?? "—"}
                    </td>
                    <td className="py-3 text-muted-foreground text-xs">
                      {row.last_synced_at
                        ? new Date(row.last_synced_at).toLocaleString()
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Section 3: Incoming Refill Requests (conditional) ───────────────────── */}
      {settings.acceptsRefillRequests && (
        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Incoming Refill Requests</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Refill requests submitted by patients via the Synapse app
            </p>
          </div>
          <div className="flex items-center justify-center py-10 text-sm text-muted-foreground border border-dashed border-border rounded-lg">
            Refill request management coming soon
          </div>
        </div>
      )}
    </div>
  )
}
