"use client"

import { SHORTCUT_GROUPS, type PortalShortcut } from "@/lib/shortcuts/registry"
import { ShortcutDialog } from "./shortcut-dialog"

export function HelpOverlay({
  open,
  onOpenChange,
  shortcuts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  shortcuts: PortalShortcut[]
}) {
  return (
    <ShortcutDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keyboard shortcuts"
      description="Tally-style accelerators, available everywhere except the POS."
      className="max-w-3xl"
    >
      <div className="max-h-[60vh] space-y-5 overflow-y-auto px-5 py-4">
        {SHORTCUT_GROUPS.map((group) => {
          const rows = shortcuts.filter((shortcut) => shortcut.group === group)
          if (rows.length === 0) return null
          return (
            <section key={group}>
              <h3 className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                {group}
              </h3>
              <ul className="mt-2 divide-y divide-border">
                {rows.map((shortcut) => (
                  <li key={shortcut.id} className="flex items-center justify-between gap-4 py-2">
                    <div>
                      <p className="text-sm font-medium text-foreground">{shortcut.label}</p>
                      <p className="text-xs text-muted-foreground">{shortcut.hint}</p>
                    </div>
                    <span className="flex shrink-0 items-center gap-1">
                      {shortcut.keys.map((key) => (
                        <kbd
                          key={key}
                          className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] font-semibold text-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
        <p className="text-xs text-muted-foreground">
          The POS screen keeps its own keys (F3 items, F5 amount paid, F8 complete sale, Ctrl+A accept,
          Alt+C customer) so a sale is never interrupted. F11 and F12 stay with the browser.
        </p>
      </div>
    </ShortcutDialog>
  )
}
