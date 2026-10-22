/**
 * Universal person identity — SYNAPSE ID, identifier namespaces, registration.
 * Pure helpers are safe to unit-test. Persistence helpers require supabaseAdmin.
 */

export const SYNAPSE_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export const IDENTIFIER_TYPES = [
  "SYNAPSE_ID",
  "MRN",
  "UHID",
  "OPENMRS",
  "UGANDAEMR",
  "LAB_NUMBER",
  "INSURANCE_MEMBER",
  "DONOR_NUMBER",
  "NIN",
  "PHONE",
  "OTHER",
] as const

export type IdentifierType = (typeof IDENTIFIER_TYPES)[number]

export const PROVENANCE_SOURCES = [
  "SELF_REPORTED",
  "PROVIDER_VERIFIED",
  "LAB_VERIFIED",
  "IMPORTED",
  "SYSTEM_GENERATED",
] as const

export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number]

export const VERIFICATION_STATUSES = ["UNVERIFIED", "VERIFIED", "DISPUTED", "SUPERSEDED"] as const
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number]

export type PersonDemographics = {
  givenName?: string | null
  familyName?: string | null
  otherNames?: string | null
  fullName?: string | null
  dateOfBirth?: string | null
  sex?: "M" | "F" | "I" | "U" | null
  preferredLanguage?: string | null
  district?: string | null
  countryCode?: string | null
}

export type ExternalIdentifier = {
  value: string
  type: IdentifierType
  issuingOrganizationId?: string | null
  issuingFacilityId?: string | null
  sourceSystem?: string | null
}

const SYNAPSE_ID_RE = /^SYN-[A-Z]{2}-[0-9A-HJKMNP-TV-Z]{9}$/

export function normalizeCountryCode(code?: string | null): string {
  const cc = (code ?? "UG").toUpperCase().replace(/[^A-Z]/g, "")
  return cc.length === 2 ? cc : "UG"
}

export function composeFullName(demo: PersonDemographics): string {
  if (demo.fullName?.trim()) return demo.fullName.trim()
  return [demo.givenName, demo.otherNames, demo.familyName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(" ")
}

export function normalizePersonName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, "")
  if (digits.startsWith("256") && digits.length >= 12) return `+${digits}`
  if (digits.startsWith("0") && digits.length === 10) return `+256${digits.slice(1)}`
  if (digits.length === 9) return `+256${digits}`
  return digits ? `+${digits}` : ""
}

export function normalizeIdentifierValue(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

export function identifierNamespaceKey(id: ExternalIdentifier): string {
  const org = id.issuingOrganizationId ?? "00000000-0000-0000-0000-000000000000"
  const facility = id.issuingFacilityId ?? "00000000-0000-0000-0000-000000000000"
  return `${org}|${facility}|${id.type}|${normalizeIdentifierValue(id.value).toLowerCase()}`
}

/** Two identical strings from different issuers are different identifiers. */
export function identifiersAreSameNamespace(a: ExternalIdentifier, b: ExternalIdentifier): boolean {
  return identifierNamespaceKey(a) === identifierNamespaceKey(b)
}

export function isValidSynapseId(value: string): boolean {
  if (!SYNAPSE_ID_RE.test(value)) return false
  const cc = value.slice(4, 6)
  const body = value.slice(7, 15)
  const check = value.slice(15, 16)
  const expectedIdx =
    (body.charCodeAt(0) +
      body.charCodeAt(2) +
      body.charCodeAt(4) +
      body.charCodeAt(7) +
      cc.charCodeAt(0) +
      cc.charCodeAt(1)) %
    32
  return SYNAPSE_ID_ALPHABET[expectedIdx] === check
}

function encodeCrockford40(bytes: Uint8Array): string {
  if (bytes.length < 5) throw new Error("need 5 bytes")
  // 40 bits -> exactly 8 base32 symbols, most significant first. Extract
  // 5-bit groups with shifts/masks: every symbol is uniform and there is no
  // division or modulo on CSPRNG output (CodeQL js/biased-cryptographic-random #7).
  const hi = bytes[0] ?? 0 // top 8 bits
  const lo = (((bytes[1] ?? 0) << 24) | ((bytes[2] ?? 0) << 16) | ((bytes[3] ?? 0) << 8) | (bytes[4] ?? 0)) >>> 0
  let body = ""
  for (let i = 7; i >= 0; i--) {
    const shift = i * 5 // bit offset of this symbol within the 40-bit value
    let sym: number
    if (shift >= 32) sym = (hi >>> (shift - 32)) & 0x1f
    else if (shift + 5 <= 32) sym = (lo >>> shift) & 0x1f
    else sym = ((lo >>> shift) | (hi << (32 - shift))) & 0x1f
    body += SYNAPSE_ID_ALPHABET[sym]
  }
  return body
}

export function formatSynapseId(countryCode: string, entropy5: Uint8Array): string {
  const cc = normalizeCountryCode(countryCode)
  const body = encodeCrockford40(entropy5)
  const checkIdx =
    (body.charCodeAt(0) +
      body.charCodeAt(2) +
      body.charCodeAt(4) +
      body.charCodeAt(7) +
      cc.charCodeAt(0) +
      cc.charCodeAt(1)) %
    32
  return `SYN-${cc}-${body}${SYNAPSE_ID_ALPHABET[checkIdx]}`
}

export function generateSynapseId(countryCode = "UG", randomBytes?: Uint8Array): string {
  const bytes = randomBytes ?? crypto.getRandomValues(new Uint8Array(5))
  return formatSynapseId(countryCode, bytes)
}

export function splitPersonName(fullName: string): {
  givenName: string
  familyName: string
  otherNames: string | null
} {
  const parts = fullName.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { givenName: "", familyName: "", otherNames: null }
  if (parts.length === 1) return { givenName: parts[0]!, familyName: parts[0]!, otherNames: null }
  const familyName = parts[parts.length - 1]!
  const givenName = parts[0]!
  const otherNames = parts.length > 2 ? parts.slice(1, -1).join(" ") : null
  return { givenName, familyName, otherNames }
}

export type RegisterPersonInput = PersonDemographics & {
  identifiers?: ExternalIdentifier[]
  phone?: string | null
  email?: string | null
}

export type RegisterPersonResult = {
  fullName: string
  countryCode: string
  synapseIdPlaceholder: true
  identifiers: ExternalIdentifier[]
  contacts: Array<{ type: "phone" | "email"; value: string }>
}

/**
 * Pure registration payload. Persistence assigns UUID + SYNAPSE ID in SQL.
 */
export function buildPersonRegistration(input: RegisterPersonInput): RegisterPersonResult {
  const fullName = composeFullName(input)
  if (!fullName) throw new Error("PERSON_NAME_REQUIRED")
  const countryCode = normalizeCountryCode(input.countryCode)
  const identifiers: ExternalIdentifier[] = [...(input.identifiers ?? [])]
  const contacts: Array<{ type: "phone" | "email"; value: string }> = []
  if (input.phone?.trim()) {
    const phone = normalizePhone(input.phone)
    contacts.push({ type: "phone", value: phone })
    identifiers.push({
      value: phone,
      type: "PHONE",
      issuingFacilityId: input.identifiers?.[0]?.issuingFacilityId ?? null,
    })
  }
  if (input.email?.trim()) {
    contacts.push({ type: "email", value: input.email.trim().toLowerCase() })
  }
  return { fullName, countryCode, synapseIdPlaceholder: true, identifiers, contacts }
}

export function localMrnIdentifier(params: {
  mrn: string
  facilityId: string
  organizationId?: string | null
  sourceSystem?: string | null
}): ExternalIdentifier {
  return {
    value: normalizeIdentifierValue(params.mrn),
    type: "MRN",
    issuingFacilityId: params.facilityId,
    issuingOrganizationId: params.organizationId ?? null,
    sourceSystem: params.sourceSystem ?? "synapse-native",
  }
}

export function isClinicallyVerified(fact: {
  provenance: ProvenanceSource
  verificationStatus: VerificationStatus
}): boolean {
  return (
    fact.verificationStatus === "VERIFIED" &&
    (fact.provenance === "PROVIDER_VERIFIED" || fact.provenance === "LAB_VERIFIED")
  )
}

export function clinicalFactDisplay(fact: {
  value: string
  provenance: ProvenanceSource
  verificationStatus: VerificationStatus
}): { value: string; stateLabel: string; clinicallyTrusted: boolean } {
  const clinicallyTrusted = isClinicallyVerified(fact)
  const stateLabel = clinicallyTrusted
    ? "Verified"
    : fact.verificationStatus === "DISPUTED"
      ? "Disputed"
      : fact.provenance === "SELF_REPORTED"
        ? "Self-reported — unverified"
        : fact.provenance === "IMPORTED"
          ? "Imported — unverified"
          : "Unverified"
  return { value: fact.value, stateLabel, clinicallyTrusted }
}
