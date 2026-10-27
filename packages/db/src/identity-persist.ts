import { supabaseAdmin } from "./admin"
import {
  buildPersonRegistration,
  generateSynapseId,
  localMrnIdentifier,
  splitPersonName,
  type RegisterPersonInput,
} from "./identity"
import { scoreIdentityMatch, type MpiPerson } from "./mpi"
import { toTimelineInsert, type TimelineEventInput } from "./timeline"
import { logAudit } from "./audit"

function isMissingRelation(error: { message?: string; code?: string } | null): boolean {
  if (!error) return false
  const msg = (error.message ?? "").toLowerCase()
  return (
    error.code === "42P01" ||
    error.code === "PGRST205" ||
    msg.includes("does not exist") ||
    msg.includes("could not find the table")
  )
}

type PgError = { code?: string; message: string }

/**
 * `persons`, `person_identifiers`, `person_contacts` and
 * `identity_match_candidates` are not in the generated `Database` type yet.
 * These describe only the calls this module makes, so the cast stays narrower
 * than `any` and each result carries the row shape it actually reads.
 */
type PgQuery<T> = {
  insert: (values: unknown) => PgQuery<T>
  select: (columns?: string) => PgQuery<T>
  eq: (column: string, value: unknown) => PgQuery<T>
  ilike: (column: string, value: string) => PgQuery<T>
  limit: (count: number) => PgQuery<T>
  single: () => PromiseLike<{ data: T; error: PgError | null }>
  maybeSingle: () => PromiseLike<{ data: T | null; error: PgError | null }>
  then: <R>(onfulfilled: (value: { data: T[] | null; error: PgError | null }) => R) => Promise<R>
}

type UntypedDb = { from: <T>(table: string) => PgQuery<T> }

export type LinkedPerson = {
  id: string
  synapseId: string
  fullName: string
}

export async function registerPersonForFacility(params: {
  tenantId: string
  organizationId?: string | null
  actorId?: string | null
  localMrn?: string | null
  sourceSystem?: string | null
  demographics: RegisterPersonInput
}): Promise<LinkedPerson | null> {
  const built = buildPersonRegistration({
    ...params.demographics,
    identifiers: [
      ...(params.demographics.identifiers ?? []),
      ...(params.localMrn
        ? [
            localMrnIdentifier({
              mrn: params.localMrn,
              facilityId: params.tenantId,
              organizationId: params.organizationId,
              sourceSystem: params.sourceSystem,
            }),
          ]
        : []),
    ],
  })
  const names = splitPersonName(built.fullName)
  const synapseId = generateSynapseId(built.countryCode)
  const db = supabaseAdmin as unknown as UntypedDb

  const { data: person, error } = await db
    .from<{ id: string; synapse_id: string; full_name: string }>("persons")
    .insert({
      synapse_id: synapseId,
      given_name: params.demographics.givenName ?? names.givenName,
      family_name: params.demographics.familyName ?? names.familyName,
      other_names: params.demographics.otherNames ?? names.otherNames,
      full_name: built.fullName,
      date_of_birth: params.demographics.dateOfBirth ?? null,
      sex: params.demographics.sex ?? null,
      preferred_language: params.demographics.preferredLanguage ?? null,
      district: params.demographics.district ?? null,
      country_code: built.countryCode,
    })
    .select("id, synapse_id, full_name")
    .single()

  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(error.message)
  }

  const personId = person.id as string

  const identifierRows: Array<Record<string, unknown>> = built.identifiers.map((id) => ({
    person_id: personId,
    identifier_value: id.value,
    identifier_type: id.type,
    issuing_organization_id: id.issuingOrganizationId ?? params.organizationId ?? null,
    issuing_facility_id: id.issuingFacilityId ?? params.tenantId,
    source_system: id.sourceSystem ?? params.sourceSystem ?? "synapse-native",
    status: "active",
  }))
  identifierRows.push({
    person_id: personId,
    identifier_value: person.synapse_id,
    identifier_type: "SYNAPSE_ID",
    issuing_organization_id: null,
    issuing_facility_id: null,
    source_system: "synapse",
    status: "active",
  })

  const { error: idError } = await db.from("person_identifiers").insert(identifierRows)
  if (idError && !isMissingRelation(idError)) {
    console.error("[identity] identifier insert failed", idError)
  }

  if (built.contacts.length > 0) {
    await db.from("person_contacts").insert(
      built.contacts.map((c) => ({
        person_id: personId,
        contact_type: c.type,
        value: c.value,
        provenance: "PROVIDER_VERIFIED",
        is_primary: true,
      })),
    )
  }

  await logAudit({
    actor_id: params.actorId ?? undefined,
    action: "PERSON_REGISTER",
    resource_type: "person",
    resource_id: personId,
    tenant_id: params.tenantId,
    after_state: { synapse_id: person.synapse_id },
  })

  return { id: personId, synapseId: person.synapse_id, fullName: person.full_name }
}

export async function resolvePersonByIdentifier(params: {
  value: string
  type?: string
  facilityId?: string | null
  organizationId?: string | null
}): Promise<LinkedPerson | null> {
  const db = supabaseAdmin as unknown as UntypedDb
  let q = db
    .from<{
      person_id: string
      persons: { id: string; synapse_id: string; full_name: string }
    }>("person_identifiers")
    .select("person_id, persons!inner(id, synapse_id, full_name)")
    .ilike("identifier_value", params.value.trim())
    .eq("status", "active")
    .limit(5)

  if (params.type) q = q.eq("identifier_type", params.type)
  if (params.facilityId) q = q.eq("issuing_facility_id", params.facilityId)
  if (params.organizationId) q = q.eq("issuing_organization_id", params.organizationId)

  const { data, error } = await q
  if (error) {
    if (isMissingRelation(error)) return null
    throw new Error(error.message)
  }
  const row = data?.[0]
  const person = row?.persons
  if (!person) return null
  return { id: person.id, synapseId: person.synapse_id, fullName: person.full_name }
}

export async function publishTimelineEvent(event: TimelineEventInput): Promise<string | null> {
  const db = supabaseAdmin as unknown as UntypedDb
  const { data, error } = await db
    .from<{ id: string }>("patient_timeline_events")
    .insert(toTimelineInsert(event))
    .select("id")
    .maybeSingle()
  if (error) {
    if (isMissingRelation(error) || error.code === "23502") return null
    console.error("[timeline] publish failed", error)
    return null
  }
  return (data?.id as string) ?? null
}

export async function queueIdentityReview(left: MpiPerson, right: MpiPerson): Promise<void> {
  const match = scoreIdentityMatch(left, right)
  if (match.recommendation === "ignore" || match.recommendation === "distinct") return
  const db = supabaseAdmin as unknown as UntypedDb
  const { error } = await db.from<{ id: string }>("identity_match_candidates").insert({
    person_id: left.id,
    candidate_person_id: right.id,
    confidence: match.confidence,
    match_signals: match.signals,
    status: "pending",
  })
  if (error && !isMissingRelation(error)) {
    console.error("[mpi] queue failed", error)
  }
}
