"use client"

import type { ReactNode } from "react"
import { SynapseLogo } from "../SynapseLogo"

export function DemoMast({
  badge = "PRODUCT DEMO",
  children,
}: {
  badge?: string
  children?: ReactNode
}) {
  return (
    <header className="demo-mast">
      <div className="demo-mast-inner">
        <div className="flex min-w-0 items-center gap-3">
          <SynapseLogo size="sm" />
          <span className="demo-stamp">{badge}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">{children}</div>
      </div>
    </header>
  )
}
