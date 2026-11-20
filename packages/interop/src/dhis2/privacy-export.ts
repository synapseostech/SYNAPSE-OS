/**
 * Privacy-gated aggregation for DHIS2 DataValueSets.
 *
 * Never emits PatientContextPacket fields, names, IDs, free text, or
 * sub-period timestamps. ICD-11 codes must already be verified.
 */

import { isIcd11Code as isKnownIcd11Stem } from "../terminology/icd11-index"
import type { PatientContextPacket } from "../intelligence/kernel"
import {
  DEFAULT_PRIVACY_EXPORT_POLICY,
  type Dhis2DataElementMapping,
  type Dhis2DataValue,
  type Dhis2DataValueSet,
  type Dhis2OrgUnitMapping,
  type PrivacyExportPolicy,
} from "./types"

const IDENTIFIER_KEYS = new Set([
  "patientid",
  "personid",
  "encounterid",
  "clinicianid",
  "tenantid",
  "displayname",
  "name",
  "given",
  "family",
  "phone",
  "email",
  "nationalid",
  "nin",
  "address",
  "exactlocation",
  "gps",
  "lat",
  "lng",
  "latitude",
  "longitude",
])

export type AggregateCaseFact = {
  /** Local org key — mapped to DHIS2 org unit before push */
  localOrgKey: string
  /** Period at policy grain: YYYYMMDD | YYYYWww | YYYYMM */
  period: string
  /** Verified ICD-11 MMS stem only */
  icd11StemCode: string
  count: number
}

export type ClinicalAggregateSummary = {
  facts: AggregateCaseFact[]
  isSynthetic?: boolean
}

export type BuildAggregateResult =
  | {
      ok: true
      dataValueSet: Dhis2DataValueSet
      suppressedCells: number
      sourceFactCount: number
    }
  | {
      ok: false
      code:
        | "POLICY_FORBID"
        | "CAPABILITY_DENIED"
        | "NO_MAPPED_VALUES"
        | "SYNTHETIC_LIVE_BLOCKED"
        | "IDENTIFIER_LEAK"
      message: string
    }

export type BuildAggregateInput = {
  source: PatientContextPacket[] | ClinicalAggregateSummary | AggregateCaseFact[]
  period: string
  /** Fallback org unit when mapping resolves a single target */
  orgUnit: string
  dataSet?: string | null
  orgUnitMappings: Dhis2OrgUnitMapping[]
  dataElementMappings: Dhis2DataElementMapping[]
  policy?: PrivacyExportPolicy
  /** Caller must already have checked role; false rejects export */
  capabilityGranted: boolean
  mode: "live" | "simulation"
  isSyntheticTenant?: boolean
}

function asFacts(source: BuildAggregateInput["source"]): AggregateCaseFact[] {
  if (Array.isArray(source)) {
    if (source.length === 0) return []
    if ("localOrgKey" in source[0]!) return source as AggregateCaseFact[]
    return packetsToFacts(source as PatientContextPacket[])
  }
  return source.facts
}

function packetsToFacts(packets: PatientContextPacket[]): AggregateCaseFact[] {
  const counts = new Map<string, AggregateCaseFact>()
  for (const packet of packets) {
    const localOrgKey = packet.facilityId ?? packet.tenantId
    const period = packet.aggregatePeriod
    if (!period) continue
    const diagnoses = packet.confirmedDiagnoses ?? []
    for (const dx of diagnoses) {
      if (!dx.verified || !dx.stemCode) continue
      if (!isKnownIcd11Stem(dx.stemCode)) continue
      const key = `${localOrgKey}|${period}|${dx.stemCode}`
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(key, {
          localOrgKey,
          period,
          icd11StemCode: dx.stemCode,
          count: 1,
        })
      }
    }
  }
  return [...counts.values()]
}

/** Deep scan for forbidden identifier-like keys in a serialisable payload. */
export function assertNoIdentifiableLeak(payload: unknown, path = "$"): string[] {
  const leaks: string[] = []
  if (payload == null) return leaks
  if (typeof payload === "string") {
    // Heuristic: UUID-looking strings in free positions are suspicious only under known id keys
    return leaks
  }
  if (Array.isArray(payload)) {
    payload.forEach((item, i) => leaks.push(...assertNoIdentifiableLeak(item, `${path}[${i}]`)))
    return leaks
  }
  if (typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const norm = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
      if (IDENTIFIER_KEYS.has(norm)) {
        leaks.push(`${path}.${key}`)
        continue
      }
      if (typeof value === "object" && value !== null) {
        leaks.push(...assertNoIdentifiableLeak(value, `${path}.${key}`))
      }
    }
  }
  return leaks
}

/**
 * Strip any accidental identifiable fields from a candidate object before export.
 * Returns a new plain aggregate-safe structure.
 */
export function stripIdentifiableFields<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    const norm = key.replace(/[^a-z0-9]/gi, "").toLowerCase()
    if (IDENTIFIER_KEYS.has(norm)) continue
    if (typeof value === "string" && (norm.includes("complaint") || norm.includes("note") || norm.includes("history"))) {
      continue
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = stripIdentifiableFields(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) =>
        item && typeof item === "object" ? stripIdentifiableFields(item as Record<string, unknown>) : item,
      )
    } else {
      out[key] = value
    }
  }
  return out
}

function resolveOrgUnit(
  localOrgKey: string,
  mappings: Dhis2OrgUnitMapping[],
  fallback: string,
): string {
  const hit = mappings.find(
    (m) => m.localOrgKey === localOrgKey || m.facilityId === localOrgKey || m.tenantId === localOrgKey,
  )
  return hit?.dhis2OrgUnitId ?? fallback
}

function resolveDataElement(
  stem: string,
  mappings: Dhis2DataElementMapping[],
): string | null {
  const hit = mappings.find((m) => m.icd11StemCode === stem)
  return hit?.dhis2DataElementId ?? null
}

/**
 * Build a privacy-safe DHIS2 DataValueSet from case facts or packets.
 * Rejects when capability / synthetic-live / identifier leak checks fail.
 */
export function buildAggregateDataValueSet(input: BuildAggregateInput): BuildAggregateResult {
  const policy = input.policy ?? DEFAULT_PRIVACY_EXPORT_POLICY

  if (!input.capabilityGranted) {
    return {
      ok: false,
      code: "CAPABILITY_DENIED",
      message: `Missing capability ${policy.requiredCapability}`,
    }
  }

  if (policy.allowIdentifiable) {
    return { ok: false, code: "POLICY_FORBID", message: "Identifiable export is forbidden on aggregate path" }
  }

  if (input.mode === "live" && policy.blockSyntheticTenantsFromLive && input.isSyntheticTenant) {
    return {
      ok: false,
      code: "SYNTHETIC_LIVE_BLOCKED",
      message: "Synthetic tenants cannot export to live DHIS2",
    }
  }

  const facts = asFacts(input.source)
  const buckets = new Map<string, Dhis2DataValue>()
  let suppressedCells = 0

  for (const fact of facts) {
    if (!isKnownIcd11Stem(fact.icd11StemCode)) continue
    if (fact.period !== input.period) continue
    if (fact.count < policy.minCellCount) {
      suppressedCells += 1
      continue
    }
    const dataElement = resolveDataElement(fact.icd11StemCode, input.dataElementMappings)
    if (!dataElement) continue
    const orgUnit = resolveOrgUnit(fact.localOrgKey, input.orgUnitMappings, input.orgUnit)
    const period = fact.period || input.period
    const key = `${dataElement}|${orgUnit}|${period}`
    const existing = buckets.get(key)
    if (existing) {
      existing.value = String(Number(existing.value) + fact.count)
    } else {
      buckets.set(key, {
        dataElement,
        orgUnit,
        period,
        value: String(fact.count),
      })
    }
  }

  const dataValues = [...buckets.values()].sort((a, b) => {
    const left = `${a.orgUnit}|${a.period}|${a.dataElement}`
    const right = `${b.orgUnit}|${b.period}|${b.dataElement}`
    return left.localeCompare(right)
  })

  if (dataValues.length === 0) {
    return {
      ok: false,
      code: "NO_MAPPED_VALUES",
      message: "No mapped ICD-11 aggregate cells to export",
    }
  }

  const dataValueSet: Dhis2DataValueSet = {
    dataSet: input.dataSet ?? undefined,
    period: input.period,
    orgUnit: input.orgUnit,
    dataValues,
  }

  const leaks = assertNoIdentifiableLeak(dataValueSet)
  if (leaks.length > 0) {
    return {
      ok: false,
      code: "IDENTIFIER_LEAK",
      message: `Privacy gate blocked export: ${leaks.slice(0, 5).join(", ")}`,
    }
  }

  return {
    ok: true,
    dataValueSet,
    suppressedCells,
    sourceFactCount: facts.length,
  }
}

/** Stable fixture helper for tests / simulation. */
export function fixtureAggregateFacts(): AggregateCaseFact[] {
  return [
    { localOrgKey: "facility-kampala-01", period: "202608", icd11StemCode: "1F40", count: 4 },
    { localOrgKey: "facility-kampala-01", period: "202608", icd11StemCode: "CA40", count: 2 },
    { localOrgKey: "facility-kampala-01", period: "202608", icd11StemCode: "1B10", count: 1 },
  ]
}
