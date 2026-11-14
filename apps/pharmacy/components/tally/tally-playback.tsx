"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Loader2,
  Pause,
  Play,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type {
  TallyPlaybackEvent,
  TallyPlaybackIndex,
  TallyPlaybackStockLine,
} from "@/lib/tally/types"

const PLAY_INTERVAL_MS = 1500

function amount(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function stockLabel(line: TallyPlaybackStockLine): string {
  const verb = line.direction === "out" ? "out" : line.direction === "in" ? "in" : "counted"
  return `${line.item} × ${line.quantity} ${verb}`
}

type Props = {
  sessionId: string
  index: TallyPlaybackIndex
  currency: string
}

/**
 * The cut-over walked by date.
 *
 * Everything shown is from the plan the preview saved: opening, then every
 * voucher in the order Apply writes them. The movement figure is batch-level
 * and only a replay computes it; the rest of a cut-over carries the vouchers
 * and the stock lines their sales and purchases mirror.
 */
export function TallyPlayback({ sessionId, index, currency }: Props) {
  const [dayIndex, setDayIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Bumped when a chunk lands, so the day's events are recomputed from the
  // cache without copying it into state.
  const [version, setVersion] = useState(0)
  const cache = useRef(new Map<number, TallyPlaybackEvent[]>())

  const dayCount = index.days.length

  // A day's events are contiguous, so they span from its own first chunk to
  // the chunk the next day starts in.
  const chunksFor = useCallback(
    (position: number): number[] => {
      const entry = index.days[position]
      if (!entry) return []
      const next = index.days[position + 1]
      const last = next ? next.firstChunk : index.chunkCount - 1
      const chunks: number[] = []
      for (let chunk = entry.firstChunk; chunk <= last; chunk += 1) chunks.push(chunk)
      return chunks
    },
    [index],
  )

  useEffect(() => {
    let active = true
    const missing = chunksFor(dayIndex).filter((chunk) => !cache.current.has(chunk))
    if (missing.length === 0) {
      setLoading(false)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        for (const chunk of missing) {
          const response = await fetch(
            `/api/admin/tally/${sessionId}/playback?chunk=${chunk}`,
            { cache: "no-store" },
          )
          const data = await response.json()
          if (!response.ok) {
            throw new Error(
              typeof data.error === "string" ? data.error : "This day could not be read.",
            )
          }
          cache.current.set(chunk, Array.isArray(data.events) ? (data.events as TallyPlaybackEvent[]) : [])
        }
        if (active) setVersion((current) => current + 1)
      } catch (failure) {
        if (active) {
          setError(failure instanceof Error ? failure.message : "This day could not be read.")
        }
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => {
      active = false
    }
  }, [chunksFor, dayIndex, sessionId])

  useEffect(() => {
    if (!playing) return
    if (dayIndex >= dayCount - 1) {
      setPlaying(false)
      return
    }
    const timer = setTimeout(() => {
      setDayIndex((current) => Math.min(current + 1, dayCount - 1))
    }, PLAY_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [playing, dayIndex, dayCount])

  const day = index.days[dayIndex]
  const events = useMemo(() => {
    if (!day) return []
    const found: TallyPlaybackEvent[] = []
    for (const chunk of chunksFor(dayIndex)) {
      for (const event of cache.current.get(chunk) ?? []) {
        if (event.date === day.date) found.push(event)
      }
    }
    return found
    // `version` is the signal that the cache holds a chunk it did not before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, dayIndex, chunksFor, version])

  const totals = useMemo(
    () =>
      events.reduce(
        (sum, event) => ({
          debit: sum.debit + event.debit,
          credit: sum.credit + event.credit,
        }),
        { debit: 0, credit: 0 },
      ),
    [events],
  )

  if (!day) return null

  const go = (position: number) => {
    setPlaying(false)
    setDayIndex(Math.max(0, Math.min(position, dayCount - 1)))
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Play className="h-5 w-5 text-primary" />
          Playback — the cut-over by date
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {index.eventCount.toLocaleString()} dated {index.eventCount === 1 ? "entry" : "entries"} from{" "}
          {index.firstDate} to {index.lastDate}, in the order they are written. Step a day at a
          time, or press play.
        </p>
        {index.movementCount === 0 && (
          <p className="text-xs text-muted-foreground">
            Batch-level stock movements are only computed by a full-history rebuild. This cut-over
            carries the vouchers and the stock lines their sales and purchases mirror; each day
            shows what was bought and sold, not which batch it left.
          </p>
        )}

        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
          <div className="max-h-96 space-y-1 overflow-y-auto rounded-lg border p-2">
            {index.days.map((entry, position) => (
              <button
                key={entry.date}
                type="button"
                onClick={() => go(position)}
                className={`flex w-full items-baseline justify-between gap-2 rounded-md px-2 py-1 text-left text-xs ${
                  position === dayIndex ? "bg-primary text-primary-foreground" : "hover:bg-muted"
                }`}
              >
                <span>{entry.date}</span>
                <span className="opacity-70">
                  {entry.events}
                  {entry.movements > 0 ? ` · ${entry.movements} mv` : ""}
                </span>
              </button>
            ))}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <Button variant="outline" size="sm" onClick={() => go(0)} disabled={dayIndex === 0}>
                <ChevronsLeft className="h-4 w-4" />
                First
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => go(dayIndex - 1)}
                disabled={dayIndex === 0}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPlaying((current) => !current)}
                disabled={dayCount <= 1}
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {playing ? "Pause" : "Play"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => go(dayIndex + 1)}
                disabled={dayIndex >= dayCount - 1}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => go(dayCount - 1)}
                disabled={dayIndex >= dayCount - 1}
              >
                Last
                <ChevronsRight className="h-4 w-4" />
              </Button>
              <span className="ml-auto text-xs text-muted-foreground">
                Day {dayIndex + 1} of {dayCount} · {currency}
              </span>
            </div>

            <p className="text-sm font-medium">
              {day.date} — {day.events} {day.events === 1 ? "entry" : "entries"}
              {events.length > 0
                ? ` · ${amount(totals.debit)} debit, ${amount(totals.credit)} credit`
                : ""}
            </p>

            {error ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                <p className="font-medium">{error}</p>
              </div>
            ) : loading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Reading {day.date}…
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Type</TableHead>
                      <TableHead>Number</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead>Stock</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {events.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="text-xs">
                          {event.kind}
                          {event.type === "movement" && (
                            <span className="block opacity-60">stock journal</span>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{event.number ?? "—"}</TableCell>
                        <TableCell className="max-w-64 text-xs">
                          <span className="line-clamp-2">{event.description}</span>
                          {event.lineCount > 0 && (
                            <span className="block opacity-60">
                              {event.lineCount} ledger {event.lineCount === 1 ? "line" : "lines"}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {event.debit ? amount(event.debit) : "—"}
                        </TableCell>
                        <TableCell className="text-right text-xs">
                          {event.credit ? amount(event.credit) : "—"}
                        </TableCell>
                        <TableCell className="max-w-56 text-xs">
                          {event.stock.length === 0
                            ? "—"
                            : event.stock.map((line) => stockLabel(line)).join(", ")}
                          {event.movements > 0 && (
                            <span className="block opacity-60">
                              {event.movements} batch {event.movements === 1 ? "movement" : "movements"}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
