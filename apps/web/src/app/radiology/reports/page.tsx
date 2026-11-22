'use client'

import { RadiologyWorklist } from '@/components/radiology/RadiologyWorklist'

export default function RadiologyReportsPage() {
  return (
    <main className="clinical-page mx-auto max-w-5xl px-4 py-6">
      <RadiologyWorklist initialView="verified" title="Radiology reports" />
    </main>
  )
}
