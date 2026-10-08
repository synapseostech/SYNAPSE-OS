import { notFound } from "next/navigation"
import { isClinicalIntelligenceWave1Enabled } from "@/lib/clinical-intelligence"
import { EncounterAiPanel } from "@/components/clinical/EncounterAiPanel"

export const dynamic = "force-dynamic"

/**
 * Clinical Intelligence Wave 1 — encounter-scoped suggestion panel.
 * Does not exist (404) while CLINICAL_INTELLIGENCE_WAVE1 is OFF.
 */
export default async function EncounterAiPage({ params }: { params: Promise<{ id: string }> }) {
  if (!isClinicalIntelligenceWave1Enabled()) notFound()
  const { id } = await params
  return (
    <main className="clinical-page mx-auto max-w-3xl px-4 py-8">
      <EncounterAiPanel encounterId={id} backHref={`/encounter/${id}`} />
    </main>
  )
}
