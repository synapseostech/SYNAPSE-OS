/**
 * Master Patient Index scoring. Never auto-merges uncertain identities.
 * Callers persist candidates into identity_match_candidates for human review.
 */

import {
  type ExternalIdentifier,
  identifiersAreSameNamespace,
  normalizePersonName,
  normalizePhone,
} from "./identity"

export type MpiPerson = {
  id: string
  fullName: string
  dateOfBirth?: string | null
  sex?: string | null
  phone?: string | null
  nationalId?: string | null
  identifiers: ExternalIdentifier[]
  verifiedSameAs?: string[]
}

export type MatchSignal = {
  name: string
  score: number
  detail: string
}

export type IdentityMatch = {
  leftId: string
  rightId: string
  confidence: number
  signals: MatchSignal[]
  recommendation: "auto_link_identifier" | "review" | "distinct" | "ignore"
}

export const MPI_AUTO_LINK_THRESHOLD = 100
export const MPI_REVIEW_THRESHOLD = 50

function namesClose(a: string, b: string): { exact: boolean; similar: boolean } {
  const na = normalizePersonName(a)
  const nb = normalizePersonName(b)
  if (!na || !nb) return { exact: false, similar: false }
  if (na === nb) return { exact: true, similar: true }
  const aParts = new Set(na.split(" "))
  const bParts = new Set(nb.split(" "))
  let overlap = 0
  for (const p of aParts) if (bParts.has(p)) overlap++
  const similar = overlap >= 2 || (overlap === 1 && Math.min(aParts.size, bParts.size) === 1)
  return { exact: false, similar }
}

export function scoreIdentityMatch(left: MpiPerson, right: MpiPerson): IdentityMatch {
  if (left.id === right.id) {
    return {
      leftId: left.id,
      rightId: right.id,
      confidence: 100,
      signals: [{ name: "same_person_id", score: 100, detail: "Identical person UUID" }],
      recommendation: "ignore",
    }
  }

  const signals: MatchSignal[] = []

  if (left.verifiedSameAs?.includes(right.id) || right.verifiedSameAs?.includes(left.id)) {
    signals.push({
      name: "verified_relationship",
      score: 100,
      detail: "Existing verified same-person relationship",
    })
  }

  for (const a of left.identifiers) {
    for (const b of right.identifiers) {
      const sameValue =
        a.value.trim().toLowerCase() === b.value.trim().toLowerCase() && a.type === b.type
      if (!sameValue) continue
      if (identifiersAreSameNamespace(a, b)) {
        signals.push({
          name: "exact_identifier",
          score: 100,
          detail: `${a.type} exact match in the same issuer namespace`,
        })
      } else {
        signals.push({
          name: "cross_issuer_identifier_string",
          score: 40,
          detail: `${a.type} string matches but issuers differ — not the same namespace`,
        })
      }
    }
  }

  if (left.nationalId && right.nationalId && left.nationalId === right.nationalId) {
    signals.push({ name: "national_id", score: 80, detail: "National identifier match" })
  }

  if (left.phone && right.phone) {
    const lp = normalizePhone(left.phone)
    const rp = normalizePhone(right.phone)
    if (lp && lp === rp) {
      signals.push({ name: "phone", score: 35, detail: "Phone number match" })
    }
  }

  const name = namesClose(left.fullName, right.fullName)
  const dobMatch = Boolean(left.dateOfBirth && right.dateOfBirth && left.dateOfBirth === right.dateOfBirth)
  const sexMatch = Boolean(left.sex && right.sex && left.sex === right.sex)

  if (name.exact) signals.push({ name: "name_exact", score: 25, detail: "Normalized name exact match" })
  else if (name.similar) signals.push({ name: "name_similar", score: 15, detail: "Normalized name similar" })
  if (dobMatch) signals.push({ name: "date_of_birth", score: 25, detail: "Date of birth match" })
  if (sexMatch) signals.push({ name: "sex", score: 10, detail: "Sex match" })

  if (name.exact && dobMatch && sexMatch) {
    signals.push({
      name: "demographic_triplet",
      score: 70,
      detail: "Name + date of birth + sex",
    })
  } else if (name.exact && dobMatch) {
    signals.push({ name: "name_dob", score: 55, detail: "Name + date of birth" })
  }

  const confidence = Math.min(
    100,
    signals.reduce((max, s) => Math.max(max, s.score), 0),
  )

  let recommendation: IdentityMatch["recommendation"] = "ignore"
  const exactSameNamespace = signals.some((s) => s.name === "exact_identifier" && s.score === 100)
  if (exactSameNamespace || signals.some((s) => s.name === "verified_relationship")) {
    recommendation = "auto_link_identifier"
  } else if (confidence >= MPI_REVIEW_THRESHOLD) {
    recommendation = "review"
  } else if (confidence > 0 && confidence < MPI_REVIEW_THRESHOLD) {
    recommendation = "distinct"
  }

  return {
    leftId: left.id,
    rightId: right.id,
    confidence,
    signals,
    recommendation,
  }
}

export function shouldAutoMerge(_match: IdentityMatch): boolean {
  return false
}

export function requiresHumanReview(match: IdentityMatch): boolean {
  return match.recommendation === "review" || match.recommendation === "auto_link_identifier"
}
