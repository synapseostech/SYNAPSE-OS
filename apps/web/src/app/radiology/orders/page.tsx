'use client'

import { RadiologyWorklist } from '@/components/radiology/RadiologyWorklist'

export default function RadiologyOrdersPage() {
  return (
    <main className="clinical-page mx-auto max-w-5xl px-4 py-6">
      <RadiologyWorklist />
    </main>
  )
}
