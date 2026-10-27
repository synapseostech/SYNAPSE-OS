"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { ShortcutDialog } from "./shortcut-dialog"

export type PaletteItem = {
  name: string
  href: string
  group: string
  hint?: string
}

export function CommandPalette({
  open,
  onOpenChange,
  items,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: PaletteItem[]
}) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return items
    return items.filter((item) =>
      `${item.name} ${item.group} ${item.hint ?? ""}`.toLowerCase().includes(needle),
    )
  }, [items, query])

  useEffect(() => {
    if (!open) {
      setQuery("")
      setActive(0)
    }
  }, [open])

  useEffect(() => {
    setActive(0)
  }, [query])

  const choose = (item: PaletteItem | undefined) => {
    if (!item) return
    onOpenChange(false)
    router.push(item.href)
  }

  return (
    <ShortcutDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Jump to a page or start a voucher."
      className="max-w-xl"
    >
      <div className="border-b border-border px-5 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-input px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault()
                setActive((index) => (results.length === 0 ? 0 : (index + 1) % results.length))
              } else if (event.key === "ArrowUp") {
                event.preventDefault()
                setActive((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length))
              } else if (event.key === "Enter") {
                event.preventDefault()
                choose(results[active])
              }
            }}
            placeholder="Search pages…"
            aria-label="Search pages"
            className="h-10 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>

      <ul className="max-h-[50vh] overflow-y-auto py-2" role="listbox" aria-label="Pages">
        {results.map((item, index) => (
          <li key={`${item.group}-${item.href}-${item.name}`} role="presentation">
            <button
              type="button"
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
              className={cn(
                "flex w-full items-center justify-between gap-3 px-5 py-2 text-left text-sm transition-colors",
                index === active ? "bg-primary/10 text-primary" : "text-foreground hover:bg-muted/50",
              )}
            >
              <span>
                {item.name}
                {item.hint ? (
                  <span className="block text-xs text-muted-foreground">{item.hint}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground">
                {item.group}
              </span>
            </button>
          </li>
        ))}
        {results.length === 0 ? (
          <li className="px-5 py-6 text-center text-sm text-muted-foreground">
            Nothing matches “{query}”.
          </li>
        ) : null}
      </ul>
    </ShortcutDialog>
  )
}
