import type { ReactNode } from "react"
import type { Metadata } from "next"
import "./demo-surface.css"
import { DEMO_THEME_FOUC } from "../../lib/demo/stations"

export const metadata: Metadata = {
  title: "Interactive Product Demo",
  description:
    "Explore how Synapse OS connects hospital teams across reception, triage, clinical care, laboratory, pharmacy and billing.",
}

export default function DemoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="demo-surface">
      <script dangerouslySetInnerHTML={{ __html: DEMO_THEME_FOUC }} />
      {children}
    </div>
  )
}
