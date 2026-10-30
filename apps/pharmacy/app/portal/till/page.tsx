"use client"

import { useEffect, useState } from "react"
import { WalletCards } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import { formatCurrency } from "@/lib/utils"

export const dynamic = "force-dynamic"

type TillSession = {
  id: string
  status: string
  openingFloat: number
  cashPaymentTotal: number
  cashRefundTotal: number
  cashIn: number
  cashOut: number
  expectedCash: number
  countedCash: number | null
  variance: number | null
  varianceReason: string | null
  openedAt: string
  closedAt: string | null
}

export default function TillPage() {
  const { toast } = useToast()
  const [session, setSession] = useState<TillSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [openingFloat, setOpeningFloat] = useState("0")
  const [countedCash, setCountedCash] = useState("")
  const [varianceReason, setVarianceReason] = useState("")
  const [movementAmount, setMovementAmount] = useState("")
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    const response = await fetch("/api/admin/till")
    const data = await response.json()
    setSession(data.session ?? null)
    setLoading(false)
  }

  useEffect(() => {
    void load()
  }, [])

  async function post(url: string, body: Record<string, unknown>) {
    setBusy(true)
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const data = await response.json()
    setBusy(false)
    if (!response.ok) {
      toast({
        variant: "destructive",
        title: data.humanMessage ?? data.error ?? "Till action failed",
      })
      return
    }
    setSession(data.session ?? null)
    toast({ title: "Till updated" })
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Till / cashier session</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Optional cash-drawer reconciliation. Open with a float, record cash in/out, then count and
          close with a variance reason. Sales do not require an open till.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <WalletCards className="h-5 w-5" />
            {loading ? "Loading…" : session ? `Session ${session.status.toUpperCase()}` : "No open till"}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {session ? (
            <dl className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <dt className="text-muted-foreground">Opening float</dt>
                <dd className="font-medium">{formatCurrency(session.openingFloat)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cash sales</dt>
                <dd className="font-medium">{formatCurrency(session.cashPaymentTotal)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cash refunds</dt>
                <dd className="font-medium">{formatCurrency(session.cashRefundTotal)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Expected cash</dt>
                <dd className="font-medium">{formatCurrency(session.expectedCash)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cash in</dt>
                <dd>{formatCurrency(session.cashIn)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Cash out</dt>
                <dd>{formatCurrency(session.cashOut)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Opened</dt>
                <dd>{new Date(session.openedAt).toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Status</dt>
                <dd>{session.status}</dd>
              </div>
            </dl>
          ) : (
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault()
                void post("/api/admin/till/open", { openingFloat: Number(openingFloat) })
              }}
            >
              <div>
                <Label htmlFor="opening-float">Opening cash float</Label>
                <Input
                  id="opening-float"
                  type="number"
                  min="0"
                  step="0.01"
                  value={openingFloat}
                  onChange={(event) => setOpeningFloat(event.target.value)}
                  required
                />
              </div>
              <Button type="submit" disabled={busy}>
                Open till
              </Button>
            </form>
          )}

          {session && session.status !== "closed" ? (
            <>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  const amount = Number(movementAmount)
                  const kind = (event.nativeEvent as SubmitEvent).submitter instanceof HTMLButtonElement
                    ? ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value
                    : "in"
                  void post("/api/admin/till/movement", {
                    sessionId: session.id,
                    kind,
                    amount,
                  })
                }}
              >
                <div>
                  <Label htmlFor="movement-amount">Cash movement</Label>
                  <Input
                    id="movement-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={movementAmount}
                    onChange={(event) => setMovementAmount(event.target.value)}
                    required
                  />
                </div>
                <Button type="submit" value="in" variant="outline" disabled={busy}>
                  Cash in
                </Button>
                <Button type="submit" value="out" variant="outline" disabled={busy}>
                  Cash out
                </Button>
              </form>

              <form
                className="grid gap-3 md:grid-cols-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void post("/api/admin/till/close", {
                    sessionId: session.id,
                    countedCash: Number(countedCash),
                    varianceReason,
                  })
                }}
              >
                <div>
                  <Label htmlFor="counted-cash">Counted cash</Label>
                  <Input
                    id="counted-cash"
                    type="number"
                    min="0"
                    step="0.01"
                    value={countedCash}
                    onChange={(event) => setCountedCash(event.target.value)}
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="variance-reason">Variance reason (required if count differs)</Label>
                  <Input
                    id="variance-reason"
                    value={varianceReason}
                    onChange={(event) => setVarianceReason(event.target.value)}
                  />
                </div>
                <Button type="submit" disabled={busy} className="md:col-span-2">
                  Close till
                </Button>
              </form>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}
