import { isClinicalIntelligenceWave1Enabled } from "@/lib/clinical-intelligence"

export default function DoctorAiPage() {
  const enabled = isClinicalIntelligenceWave1Enabled()
  return (
    <main className="min-h-screen bg-base text-primary-color p-8">
      <h1 className="font-display text-2xl">Clinical Intelligence</h1>
      <p className="text-muted-color mt-2 max-w-2xl">
        AI advises; the clinician decides. Wave 1 never signs diagnoses, activates pathways, or places
        orders.
      </p>
      <div className="mt-6 rounded-lg border border-border p-4 max-w-2xl">
        <p className="text-sm font-medium">
          Feature flag{" "}
          <code className="text-xs">CLINICAL_INTELLIGENCE_WAVE1</code>:{" "}
          {enabled ? (
            <span className="text-emerald-600">ON (advisory endpoints available)</span>
          ) : (
            <span className="text-amber-600">OFF (default — not enabled in production)</span>
          )}
        </p>
        {!enabled && (
          <p className="text-sm text-muted-color mt-2">
            Enable only after ops approval. Use the advise API under{" "}
            <code className="text-xs">/api/clinical/intelligence/advise</code> when the flag is on.
          </p>
        )}
        {enabled && (
          <p className="text-sm text-muted-color mt-2">
            Sepsis pathway suggestions are advisory only (
            <code className="text-xs">pathway.adult-sepsis</code>). Clinician confirmation is required
            before any clinical action.
          </p>
        )}
      </div>
    </main>
  )
}
