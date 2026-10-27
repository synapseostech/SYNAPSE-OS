"use client"

import { useEffect, useRef } from "react"
import { usePathname, useRouter } from "next/navigation"
import {
  isEditableTarget,
  isPosRoute,
  resolvePortalShortcut,
  type PortalShortcut,
} from "@/lib/shortcuts/registry"

type PortalShortcutOptions = {
  enabled?: boolean
  canUse: (shortcut: PortalShortcut) => boolean
  onOpenHelp: () => void
  onOpenPalette: () => void
}

export function usePortalShortcuts({
  enabled = true,
  canUse,
  onOpenHelp,
  onOpenPalette,
}: PortalShortcutOptions) {
  const router = useRouter()
  const pathname = usePathname()
  const latest = useRef({ canUse, onOpenHelp, onOpenPalette, pathname })

  useEffect(() => {
    latest.current = { canUse, onOpenHelp, onOpenPalette, pathname }
  })

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return
      if (isPosRoute(latest.current.pathname)) return
      const shortcut = resolvePortalShortcut(event)
      if (!shortcut) return
      if (!shortcut.allowInEditable && isEditableTarget(event.target)) return
      if (!latest.current.canUse(shortcut)) return

      event.preventDefault()
      if (shortcut.overlay === "help") latest.current.onOpenHelp()
      else if (shortcut.overlay === "palette") latest.current.onOpenPalette()
      else if (shortcut.href) router.push(shortcut.href)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [enabled, router])
}
