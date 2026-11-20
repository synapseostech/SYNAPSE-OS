import "server-only"

import { supabaseAdmin } from "@synapse/db/admin"

function db() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return supabaseAdmin as any
}

export async function listHospitalPatients(tenantId: string, q?: string) {
  type Row = {
    id: string
    full_name: string
    date_of_birth: string | null
    dob: string | null
    sex: string | null
    mrn: string | null
    created_at: string | null
  }
  const term = q?.trim().slice(0, 80) ?? ""
  if (term.length >= 2) {
    // Same search as the registration desk: name, MRN, phone or NIN in one query.
    const { data, error } = await db().rpc("hospital_search_patients", {
      p_tenant_id: tenantId,
      p_query: term,
      p_limit: 50,
    })
    if (!error) {
      return ((data ?? []) as Array<{ id: string; full_name: string; mrn: string | null; dob: string | null; sex: string | null }>).map(
        (p): Row => ({ ...p, date_of_birth: null, created_at: null }),
      )
    }
    if (error.code !== "PGRST202" && error.code !== "42883") throw new Error(error.message)
  }
  let query = db()
    .from("patients")
    .select("id, full_name, dob, sex, mrn, created_at")
    .eq("tenant_id", tenantId)
    .eq("is_deleted", false)
    .order("created_at", { ascending: false })
    .limit(50)
  if (term) query = query.ilike("full_name", `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as Row[]
}

export async function getHospitalPatientChart(tenantId: string, patientId: string) {
  const client = db()
  const { data: patient, error: patientError } = await client
    .from("patients")
    .select("*")
    .eq("id", patientId)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (patientError) throw new Error(patientError.message)
  if (!patient) return null

  let synapseId: string | null = null
  if (patient.person_id) {
    const { data: person, error: personError } = await client
      .from("persons")
      .select("synapse_id")
      .eq("id", patient.person_id)
      .maybeSingle()
    if (personError) throw new Error(personError.message)
    synapseId = typeof person?.synapse_id === "string" ? person.synapse_id : null
  }

  const { data: encounters, error: encounterError } = await client
    .from("encounters")
    .select("id, visit_date, status, chief_complaint, clinical_stage")
    .eq("patient_id", patientId)
    .eq("tenant_id", tenantId)
    .order("visit_date", { ascending: false })
    .limit(10)
  if (encounterError) throw new Error(encounterError.message)

  const encounterIds = (encounters ?? []).map((row: { id: string }) => row.id)
  let latestVitals: Record<string, unknown> | null = null
  if (encounterIds.length) {
    const { data: vitals, error: vitalsError } = await client
      .from("vitals")
      .select("bp_systolic, bp_diastolic, heart_rate, temperature_c, spo2, respiratory_rate, created_at")
      .eq("tenant_id", tenantId)
      .in("encounter_id", encounterIds)
      .order("created_at", { ascending: false })
      .limit(1)
    if (vitalsError) throw new Error(vitalsError.message)
    latestVitals = (vitals?.[0] as Record<string, unknown> | undefined) ?? null
  }

  return {
    patient: { ...patient, synapse_id: synapseId },
    encounters: encounters ?? [],
    latestVitals,
  }
}

export async function countHospitalCensus(tenantId: string) {
  const client = db()
  const [patientRes, encounterRes] = await Promise.all([
    client
      .from("patients")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("is_deleted", false),
    client
      .from("encounters")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId),
  ])
  return {
    patients: patientRes.count ?? 0,
    encounters: encounterRes.count ?? 0,
  }
}
