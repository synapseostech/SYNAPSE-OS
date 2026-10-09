import { lookupStem } from "@synapse/interop"
import { PATHWAY_CATALOG } from "@synapse/db/pathways"

/**
 * Strict validation of untrusted model output. Anything that does not match the
 * expected shape is dropped; the caller falls back to a deterministic advisory.
 */

const MAX_ITEMS = 12
const MAX_ITEM_CHARS = 300
const MAX_TEXT_CHARS = 1_000
/** ICD-11 MMS stem code shape, e.g. 1G40, 1F40.0, CA40.Z. */
const ICD11_STEM_PATTERN = /^[0-9A-HJ-NP-Z][A-HJ-NP-Z0-9]{3}(\.[A-HJ-NP-Z0-9]{1,4})?$/

export type ParsedModelAdvice = {
  recommendation: string
  reasoningSummary: string | null
  supportingEvidence: string[]
  contradictingEvidence: string[]
  missingInformation: string[]
  confidence: number | null
  cannotMiss: boolean | null
  proposedTerms: string[]
  suggestedPathwayId: string | null
  icd11StemHints: string[]
}

export type VerifiedIcd11Candidate = {
  stemCode: string
  title: string
  verified: true
  source: "icd11-trusted-cache"
}

function boundedText(value: unknown, max = MAX_TEXT_CHARS): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function boundedList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_ITEM_CHARS))
    .filter(Boolean)
    .slice(0, MAX_ITEMS)
}

export function parseConfidence(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, n))
}

const KNOWN_PATHWAY_IDS = new Set(PATHWAY_CATALOG.map((p) => p.id))

export function isKnownPathwayId(id: unknown): id is string {
  return typeof id === "string" && KNOWN_PATHWAY_IDS.has(id)
}

/** Returns null when the model output is not a usable advice object. */
export function parseModelAdvice(raw: Record<string, unknown>): ParsedModelAdvice | null {
  const recommendation = boundedText(raw.recommendation) ?? boundedText(raw.conditionName)
  if (!recommendation) return null
  return {
    recommendation,
    reasoningSummary: boundedText(raw.reasoningSummary),
    supportingEvidence: boundedList(raw.supportingEvidence),
    contradictingEvidence: boundedList(raw.contradictingEvidence),
    missingInformation: boundedList(raw.missingInformation),
    confidence: parseConfidence(raw.confidence),
    cannotMiss: typeof raw.cannotMiss === "boolean" ? raw.cannotMiss : null,
    proposedTerms: boundedList(raw.proposedTerms),
    // Only pathways that exist in the governed catalog; a model cannot invent one.
    suggestedPathwayId: isKnownPathwayId(raw.suggestedPathwayId) ? raw.suggestedPathwayId : null,
    icd11StemHints: boundedList(raw.icd11StemHints),
  }
}

/**
 * Exact-match verification against the trusted ICD-11 cache. Prefixes,
 * truncated stems and well-formed-but-unknown codes are all rejected.
 */
export function verifyIcd11Hints(hints: string[]): {
  verified: VerifiedIcd11Candidate[]
  rejected: number
} {
  const verified: VerifiedIcd11Candidate[] = []
  const seen = new Set<string>()
  let rejected = 0
  for (const hint of hints) {
    const code = hint.trim().toUpperCase()
    if (!ICD11_STEM_PATTERN.test(code)) {
      rejected += 1
      continue
    }
    const entity = lookupStem(code)
    if (!entity || entity.stemCode !== code) {
      rejected += 1
      continue
    }
    if (seen.has(code)) continue
    seen.add(code)
    verified.push({ stemCode: entity.stemCode, title: entity.title, verified: true, source: "icd11-trusted-cache" })
  }
  return { verified, rejected }
}
