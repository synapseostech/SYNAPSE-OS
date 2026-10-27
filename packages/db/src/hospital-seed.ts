/**
 * Deterministic synthetic hospital seeding framework.
 * SYNAPSE INTEGRATED REGIONAL HOSPITAL — canonical acceptance environment.
 *
 * Seed: 20260830 — running twice must NOT duplicate the hospital.
 * Only synthetic/demo tenants may be created, reset, or reseeded.
 */

import { assertDemoResetAllowed, SYNTHETIC_CLASSIFICATION } from "./simulation"
import { ExchangeOutbox } from "./exchange"
import { WorkQueue } from "./work-queue"
import { generateSynapseId, localMrnIdentifier } from "./identity"

export const HOSPITAL_SEED_VERSION = "20260830" as const
export const HOSPITAL_CANONICAL_SEED = 20260830
export const HOSPITAL_CANONICAL_SLUG = "synapse-integrated-demo"
export const HOSPITAL_CANONICAL_NAME = "SYNAPSE INTEGRATED REGIONAL HOSPITAL"

export type HospitalDepartmentDef = {
  code: string
  name: string
  deptType: string
  moduleKey: string
  classification: "OPERATIONAL" | "PARTIAL" | "NOT_IMPLEMENTED"
}

export type HospitalLocationDef = {
  code: string
  name: string
  locationType: string
  departmentCode: string
  parentCode?: string
  floor?: number
  building?: string
}

export type HospitalStaffRoleDef = {
  code: string
  displayName: string
  role: string
  departmentCode: string
  profession: string
  capabilities: string[]
}

export type HospitalTestPatientDef = {
  key: string
  label: string
  givenName: string
  familyName: string
  dateOfBirth: string
  sex: "M" | "F"
  phone: string
  journey: string
  scenarioId?: string
}

export const HOSPITAL_DEPARTMENTS: HospitalDepartmentDef[] = [
  { code: "reception", name: "Reception / Registration / Medical Records", deptType: "administrative", moduleKey: "registration", classification: "PARTIAL" },
  { code: "triage", name: "Triage", deptType: "clinical", moduleKey: "opd", classification: "PARTIAL" },
  { code: "opd", name: "Outpatient Department", deptType: "clinical", moduleKey: "opd", classification: "PARTIAL" },
  { code: "emergency", name: "Emergency Department", deptType: "clinical", moduleKey: "emergency", classification: "PARTIAL" },
  { code: "medicine", name: "General Medicine", deptType: "clinical", moduleKey: "clinical", classification: "PARTIAL" },
  { code: "surgery", name: "General Surgery", deptType: "clinical", moduleKey: "clinical", classification: "NOT_IMPLEMENTED" },
  { code: "paediatrics", name: "Paediatrics", deptType: "clinical", moduleKey: "immunization", classification: "NOT_IMPLEMENTED" },
  { code: "obgyn", name: "Obstetrics & Gynaecology", deptType: "clinical", moduleKey: "maternity", classification: "NOT_IMPLEMENTED" },
  { code: "anc", name: "Antenatal Clinic", deptType: "clinical", moduleKey: "maternity", classification: "NOT_IMPLEMENTED" },
  { code: "labour", name: "Labour / Delivery", deptType: "clinical", moduleKey: "maternity", classification: "NOT_IMPLEMENTED" },
  { code: "postnatal", name: "Postnatal", deptType: "clinical", moduleKey: "maternity", classification: "NOT_IMPLEMENTED" },
  { code: "medical_ward", name: "Inpatient Medical Ward", deptType: "inpatient", moduleKey: "ipd", classification: "PARTIAL" },
  { code: "surgical_ward", name: "Surgical Ward", deptType: "inpatient", moduleKey: "ipd", classification: "NOT_IMPLEMENTED" },
  { code: "paediatric_ward", name: "Paediatric Ward", deptType: "inpatient", moduleKey: "ipd", classification: "NOT_IMPLEMENTED" },
  { code: "maternity_ward", name: "Maternity Ward", deptType: "inpatient", moduleKey: "maternity", classification: "NOT_IMPLEMENTED" },
  { code: "laboratory", name: "Laboratory", deptType: "diagnostic", moduleKey: "lab", classification: "PARTIAL" },
  { code: "blood_bank", name: "Blood Bank", deptType: "diagnostic", moduleKey: "lab", classification: "NOT_IMPLEMENTED" },
  { code: "radiology", name: "Radiology / Imaging", deptType: "diagnostic", moduleKey: "radiology", classification: "NOT_IMPLEMENTED" },
  { code: "pharmacy", name: "Pharmacy", deptType: "support", moduleKey: "dispensing", classification: "PARTIAL" },
  { code: "theatre", name: "Theatre / Operating Room", deptType: "clinical", moduleKey: "theatre", classification: "NOT_IMPLEMENTED" },
  { code: "billing", name: "Billing / Cashier", deptType: "financial", moduleKey: "billing", classification: "PARTIAL" },
  { code: "insurance", name: "Insurance / Claims", deptType: "financial", moduleKey: "claims", classification: "PARTIAL" },
  { code: "referral", name: "Referral Office", deptType: "administrative", moduleKey: "emergency", classification: "PARTIAL" },
  { code: "stores", name: "Stores / Procurement", deptType: "support", moduleKey: "support_ops", classification: "NOT_IMPLEMENTED" },
  { code: "him", name: "Health Information / Records", deptType: "administrative", moduleKey: "registration", classification: "PARTIAL" },
  { code: "public_health", name: "Public Health / Surveillance", deptType: "administrative", moduleKey: "public_health", classification: "NOT_IMPLEMENTED" },
  { code: "administration", name: "Hospital Administration", deptType: "administrative", moduleKey: "core", classification: "OPERATIONAL" },
]

export const HOSPITAL_LOCATIONS: HospitalLocationDef[] = [
  { code: "main_reception", name: "Main Reception", locationType: "reception", departmentCode: "reception" },
  { code: "opd_triage", name: "OPD Triage", locationType: "triage", departmentCode: "triage", parentCode: "main_reception" },
  { code: "opd_consult_1", name: "OPD Consultation Room 1", locationType: "consultation", departmentCode: "opd", parentCode: "opd_triage" },
  { code: "opd_consult_2", name: "OPD Consultation Room 2", locationType: "consultation", departmentCode: "opd", parentCode: "opd_triage" },
  { code: "ed_bay_1", name: "Emergency Bay 1", locationType: "bay", departmentCode: "emergency" },
  { code: "ed_bay_2", name: "Emergency Bay 2", locationType: "bay", departmentCode: "emergency" },
  { code: "ed_resus", name: "Resuscitation Room", locationType: "resuscitation", departmentCode: "emergency", parentCode: "ed_bay_1" },
  { code: "medical_ward", name: "Medical Ward", locationType: "ward", departmentCode: "medical_ward", floor: 2, building: "Block A" },
  { code: "surgical_ward", name: "Surgical Ward", locationType: "ward", departmentCode: "surgical_ward", floor: 3, building: "Block A" },
  { code: "paediatric_ward", name: "Paediatric Ward", locationType: "ward", departmentCode: "paediatric_ward", floor: 2, building: "Block B" },
  { code: "maternity_ward", name: "Maternity Ward", locationType: "ward", departmentCode: "maternity_ward", floor: 1, building: "Block C" },
  { code: "anc_clinic", name: "ANC Clinic", locationType: "clinic", departmentCode: "anc" },
  { code: "lab_reception", name: "Lab Reception", locationType: "reception", departmentCode: "laboratory" },
  { code: "phlebotomy", name: "Phlebotomy", locationType: "collection", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "hematology_bench", name: "Hematology Bench", locationType: "bench", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "chemistry_bench", name: "Chemistry Bench", locationType: "bench", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "microbiology_bench", name: "Microbiology Bench", locationType: "bench", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "rad_reception", name: "Radiology Reception", locationType: "reception", departmentCode: "radiology" },
  { code: "xray_room", name: "X-Ray Room", locationType: "imaging", departmentCode: "radiology", parentCode: "rad_reception" },
  { code: "ultrasound_room", name: "Ultrasound Room", locationType: "imaging", departmentCode: "radiology", parentCode: "rad_reception" },
  { code: "main_pharmacy", name: "Main Pharmacy", locationType: "pharmacy", departmentCode: "pharmacy" },
  { code: "ed_pharmacy", name: "Emergency Pharmacy", locationType: "pharmacy", departmentCode: "pharmacy", parentCode: "main_pharmacy" },
  { code: "main_theatre", name: "Main Theatre", locationType: "theatre", departmentCode: "theatre" },
  { code: "recovery", name: "Recovery", locationType: "recovery", departmentCode: "theatre", parentCode: "main_theatre" },
  { code: "billing_desk", name: "Billing Desk", locationType: "desk", departmentCode: "billing" },
  { code: "insurance_desk", name: "Insurance Desk", locationType: "desk", departmentCode: "insurance" },
  { code: "stores", name: "Stores", locationType: "warehouse", departmentCode: "stores" },
]

export const LABORATORY_LOCATIONS: HospitalLocationDef[] = [
  { code: "lab_reception", name: "Reception / Registration", locationType: "reception", departmentCode: "laboratory" },
  { code: "lab_phlebotomy", name: "Phlebotomy / Specimen Collection", locationType: "collection", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_processing", name: "Sample Processing / Accessioning", locationType: "processing", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_hematology", name: "Hematology", locationType: "section", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_chemistry", name: "Clinical Chemistry", locationType: "section", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_microbiology", name: "Microbiology", locationType: "section", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_quality", name: "Quality Management", locationType: "quality", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_stores", name: "Reagents / Stores", locationType: "stores", departmentCode: "laboratory", parentCode: "lab_reception" },
  { code: "lab_instruments", name: "Instruments / Equipment", locationType: "bench", departmentCode: "laboratory", parentCode: "lab_reception" },
]

export const HOSPITAL_STAFF_ROLES: HospitalStaffRoleDef[] = [
  { code: "hosp_admin", displayName: "Hospital Administrator", role: "hospital_admin", departmentCode: "administration", profession: "administrator", capabilities: ["staff.manage", "facility.manage", "module.manage"] },
  { code: "med_super", displayName: "Medical Superintendent", role: "facility_admin", departmentCode: "administration", profession: "physician", capabilities: ["encounter.read", "encounter.write", "staff.manage"] },
  { code: "records_officer", displayName: "Records Officer", role: "records_officer", departmentCode: "him", profession: "health_information", capabilities: ["patient.search", "patient.register", "patient.demographics.update"] },
  { code: "receptionist", displayName: "Receptionist", role: "receptionist", departmentCode: "reception", profession: "administrative", capabilities: ["patient.search", "patient.register", "patient.demographics.update", "appointment.read", "queue.create"] },
  { code: "triage_nurse", displayName: "Triage Nurse", role: "nurse", departmentCode: "triage", profession: "nursing", capabilities: ["patient.read", "observation.create", "triage.create", "task.update"] },
  { code: "opd_nurse", displayName: "OPD Nurse", role: "nurse", departmentCode: "opd", profession: "nursing", capabilities: ["patient.read", "observation.create", "task.update"] },
  { code: "opd_doctor", displayName: "OPD Doctor", role: "doctor", departmentCode: "opd", profession: "physician", capabilities: ["encounter.read", "encounter.write", "diagnosis.suggest", "diagnosis.confirm", "order.lab", "order.imaging", "prescription.create", "pathway.start", "pathway.override"] },
  { code: "ed_nurse", displayName: "Emergency Nurse", role: "nurse", departmentCode: "emergency", profession: "nursing", capabilities: ["patient.read", "observation.create", "triage.create", "task.update"] },
  { code: "ed_doctor", displayName: "Emergency Doctor", role: "doctor", departmentCode: "emergency", profession: "physician", capabilities: ["encounter.read", "encounter.write", "diagnosis.confirm", "order.lab", "order.imaging", "prescription.create", "pathway.start"] },
  { code: "internist", displayName: "Internal Medicine Doctor", role: "doctor", departmentCode: "medicine", profession: "physician", capabilities: ["encounter.read", "encounter.write", "diagnosis.confirm", "order.lab", "prescription.create", "pathway.start"] },
  { code: "surgeon", displayName: "Surgeon", role: "doctor", departmentCode: "surgery", profession: "surgeon", capabilities: ["encounter.read", "encounter.write", "diagnosis.confirm", "order.lab", "prescription.create"] },
  { code: "surgical_nurse", displayName: "Surgical Nurse", role: "nurse", departmentCode: "surgical_ward", profession: "nursing", capabilities: ["patient.read", "observation.create", "task.update"] },
  { code: "paediatrician", displayName: "Paediatrician", role: "doctor", departmentCode: "paediatrics", profession: "physician", capabilities: ["encounter.read", "encounter.write", "diagnosis.confirm", "order.lab", "prescription.create"] },
  { code: "paed_nurse", displayName: "Paediatric Nurse", role: "nurse", departmentCode: "paediatric_ward", profession: "nursing", capabilities: ["patient.read", "observation.create", "task.update"] },
  { code: "obstetrician", displayName: "Obstetrician", role: "doctor", departmentCode: "obgyn", profession: "physician", capabilities: ["encounter.read", "encounter.write", "diagnosis.confirm", "order.lab", "order.imaging"] },
  { code: "midwife", displayName: "Midwife", role: "nurse", departmentCode: "labour", profession: "midwifery", capabilities: ["patient.read", "observation.create", "task.update"] },
  { code: "lab_receptionist", displayName: "Lab Receptionist", role: "lab_tech", departmentCode: "laboratory", profession: "laboratory", capabilities: ["lab.order.read"] },
  { code: "phlebotomist", displayName: "Phlebotomist", role: "lab_tech", departmentCode: "laboratory", profession: "laboratory", capabilities: ["lab.order.read", "lab.specimen.collect"] },
  { code: "lab_technician", displayName: "Lab Technician", role: "lab_tech", departmentCode: "laboratory", profession: "laboratory", capabilities: ["lab.specimen.receive", "lab.result.enter"] },
  { code: "lab_scientist", displayName: "Lab Scientist / Verifier", role: "lab_scientist", departmentCode: "laboratory", profession: "laboratory", capabilities: ["lab.result.review", "lab.result.verify", "lab.result.amend"] },
  { code: "radiographer", displayName: "Radiographer", role: "radiographer", departmentCode: "radiology", profession: "radiology", capabilities: ["imaging.order.read", "imaging.study.perform"] },
  { code: "radiologist", displayName: "Radiologist", role: "doctor", departmentCode: "radiology", profession: "radiology", capabilities: ["imaging.report.create", "imaging.report.finalize"] },
  { code: "pharmacist", displayName: "Pharmacist", role: "pharmacist", departmentCode: "pharmacy", profession: "pharmacy", capabilities: ["prescription.read", "prescription.verify", "medication.dispense"] },
  { code: "pharm_tech", displayName: "Pharmacy Technician", role: "pharmacy_technician", departmentCode: "pharmacy", profession: "pharmacy", capabilities: ["prescription.read", "medication.dispense"] },
  { code: "theatre_nurse", displayName: "Theatre Nurse", role: "nurse", departmentCode: "theatre", profession: "nursing", capabilities: ["patient.read", "task.update"] },
  { code: "anaesthesia", displayName: "Anaesthesia Provider", role: "doctor", departmentCode: "theatre", profession: "anaesthesia", capabilities: ["encounter.read", "encounter.write"] },
  { code: "cashier", displayName: "Cashier", role: "billing_officer", departmentCode: "billing", profession: "finance", capabilities: ["invoice.read", "payment.collect"] },
  { code: "insurance_officer", displayName: "Insurance Officer", role: "claims_officer", departmentCode: "insurance", profession: "finance", capabilities: ["coverage.check", "claim.prepare", "claim.review"] },
  { code: "referral_coord", displayName: "Referral Coordinator", role: "referral_coordinator", departmentCode: "referral", profession: "administrative", capabilities: ["patient.read", "encounter.read"] },
  { code: "storekeeper", displayName: "Storekeeper", role: "storekeeper", departmentCode: "stores", profession: "logistics", capabilities: [] },
  { code: "him_officer", displayName: "Health Information Officer", role: "records_officer", departmentCode: "him", profession: "health_information", capabilities: ["patient.search", "encounter.read"] },
  { code: "ph_officer", displayName: "Public Health Officer", role: "public_health_officer", departmentCode: "public_health", profession: "public_health", capabilities: ["aggregate.read", "report.prepare"] },
  { code: "it_admin", displayName: "IT Administrator", role: "it_administrator", departmentCode: "administration", profession: "it", capabilities: ["facility.manage"] },
]

export const HOSPITAL_TEST_PATIENTS: HospitalTestPatientDef[] = [
  { key: "A", label: "Uncomplicated malaria OPD", givenName: "Amina", familyName: "Nalubega", dateOfBirth: "1992-03-15", sex: "F", phone: "+256700100001", journey: "MALARIA_OPD_GOLDEN", scenarioId: "opd-malaria" },
  { key: "B", label: "Sepsis Emergency → Lab → Admission", givenName: "Joseph", familyName: "Okello", dateOfBirth: "1978-11-22", sex: "M", phone: "+256700100002", journey: "SEPSIS_EMERGENCY_GOLDEN", scenarioId: "sepsis-critical-lab" },
  { key: "C", label: "DKA Emergency → Lab → Medical Ward", givenName: "Sarah", familyName: "Atim", dateOfBirth: "2001-07-08", sex: "F", phone: "+256700100003", journey: "DKA_INPATIENT_GOLDEN", scenarioId: "dka" },
  { key: "D", label: "Pneumonia OPD → Imaging/Lab", givenName: "Peter", familyName: "Mugisha", dateOfBirth: "1965-01-30", sex: "M", phone: "+256700100004", journey: "PNEUMONIA_DIAGNOSTICS_GOLDEN", scenarioId: "pneumonia" },
  { key: "E", label: "Appendicitis Emergency → Surgery → Theatre", givenName: "Grace", familyName: "Namukasa", dateOfBirth: "1988-09-12", sex: "F", phone: "+256700100005", journey: "SURGERY_APPENDICITIS_GOLDEN" },
  { key: "F", label: "ANC → preeclampsia → maternity admission", givenName: "Rebecca", familyName: "Akello", dateOfBirth: "1995-04-25", sex: "F", phone: "+256700100006", journey: "MATERNITY_PREECLAMPSIA_GOLDEN" },
  { key: "G", label: "Paediatric severe malaria", givenName: "Emmanuel", familyName: "Wasswa", dateOfBirth: "2019-06-18", sex: "M", phone: "+256700100007", journey: "PAEDIATRIC_MALARIA_GOLDEN" },
  { key: "H", label: "Insured elective procedure", givenName: "David", familyName: "Ssempijja", dateOfBirth: "1980-12-03", sex: "M", phone: "+256700100008", journey: "INSURANCE_CLAIM_GOLDEN", scenarioId: "insurance-claim" },
  { key: "I", label: "Referral from Health Centre", givenName: "Florence", familyName: "Nabirye", dateOfBirth: "1970-08-14", sex: "F", phone: "+256700100009", journey: "REFERRAL_GOLDEN", scenarioId: "referral" },
  { key: "J", label: "Routine outpatient normal investigations", givenName: "Henry", familyName: "Kato", dateOfBirth: "1990-02-28", sex: "M", phone: "+256700100010", journey: "COMPLETE_HOSPITAL_DAY" },
]

function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

function uuidFromRng(rng: () => number): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(rng() * 256))
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.map((b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type SeededDepartment = {
  id: string
  code: string
  name: string
  deptType: string
  moduleKey: string
  classification: string
  isActive: boolean
}

export type SeededLocation = {
  id: string
  code: string
  name: string
  locationType: string
  departmentId: string
  departmentCode: string
  parentId: string | null
  parentCode: string | null
  floor: number | null
  building: string | null
  isActive: boolean
}

export type SeededStaffAccount = {
  id: string
  personId: string
  staffCode: string
  displayName: string
  email: string
  role: string
  departmentId: string
  departmentCode: string
  profession: string
  capabilities: string[]
  isSynthetic: true
  accountState: "provisioned"
  registrationNumber: string
}

export type SeededPatient = {
  id: string
  personId: string
  synapseId: string
  mrn: string
  key: string
  label: string
  journey: string
  demographics: {
    givenName: string
    familyName: string
    fullName: string
    dateOfBirth: string
    sex: "M" | "F"
    phone: string
  }
  aliases: ReturnType<typeof localMrnIdentifier>[]
  isSynthetic: true
  dataClassification: typeof SYNTHETIC_CLASSIFICATION
}

export type HospitalSeedSnapshot = {
  seed: number
  seedVersion: string
  slug: string
  name: string
  tenantId: string
  hospitalId: string
  organizationId: string
  environment: "demo"
  isSynthetic: true
  dataClassification: typeof SYNTHETIC_CLASSIFICATION
  protectedFlags: {
    reporting: true
    claims: true
    notifications: true
  }
  country: "UG"
  facilityType: "hospital"
  hospitalType: "Regional Referral Hospital"
  contact: {
    address: "Plot 42, Synapse Valley Road, Kampala"
    phone: "+256-800-SYNAPSE"
    email: "demo@synapse-integrated.local"
  }
  departments: SeededDepartment[]
  locations: SeededLocation[]
  staff: SeededStaffAccount[]
  patients: SeededPatient[]
  modules: string[]
  seededAt: string
}

type GlobalHospitalSeed = {
  registry: Map<string, HospitalSeedSnapshot>
  workQueues: Map<string, WorkQueue>
}

const globalSeed = globalThis as typeof globalThis & { __synapseHospitalSeed?: GlobalHospitalSeed }

function store(): GlobalHospitalSeed {
  if (!globalSeed.__synapseHospitalSeed) {
    globalSeed.__synapseHospitalSeed = { registry: new Map(), workQueues: new Map() }
  }
  return globalSeed.__synapseHospitalSeed
}

export function getHospitalSeed(slug: string): HospitalSeedSnapshot | undefined {
  return store().registry.get(slug)
}

export function getHospitalWorkQueue(tenantId: string): WorkQueue | undefined {
  return store().workQueues.get(tenantId)
}

export function inspectHospital(slug: string = HOSPITAL_CANONICAL_SLUG): HospitalSeedSnapshot | { error: string } {
  const snapshot = store().registry.get(slug)
  if (!snapshot) return { error: "HOSPITAL_NOT_SEEDED" }
  return snapshot
}

export type SeedHospitalOptions = {
  seed?: number
  slug?: string
  name?: string
  actorId: string
  force?: boolean
}

export function seedHospital(options: SeedHospitalOptions): HospitalSeedSnapshot {
  const seed = options.seed ?? HOSPITAL_CANONICAL_SEED
  const slug = options.slug ?? HOSPITAL_CANONICAL_SLUG
  const name = options.name ?? HOSPITAL_CANONICAL_NAME

  const existing = store().registry.get(slug)
  if (existing && !options.force) {
    return existing
  }

  const rng = mulberry32(seed)
  const tenantId = uuidFromRng(rng)
  const hospitalId = uuidFromRng(rng)
  const organizationId = uuidFromRng(rng)
  const _simulationRunId = uuidFromRng(rng)
  const now = new Date().toISOString()

  const departments: SeededDepartment[] = HOSPITAL_DEPARTMENTS.map((d) => ({
    id: uuidFromRng(rng),
    code: d.code,
    name: d.name,
    deptType: d.deptType,
    moduleKey: d.moduleKey,
    classification: d.classification,
    isActive: d.classification !== "NOT_IMPLEMENTED",
  }))

  const deptByCode = new Map(departments.map((d) => [d.code, d]))

  const locations: SeededLocation[] = HOSPITAL_LOCATIONS.map((loc) => {
    const dept = deptByCode.get(loc.departmentCode)
    return {
      id: uuidFromRng(rng),
      code: loc.code,
      name: loc.name,
      locationType: loc.locationType,
      departmentId: dept?.id ?? uuidFromRng(rng),
      departmentCode: loc.departmentCode,
      parentId: null,
      parentCode: loc.parentCode ?? null,
      floor: loc.floor ?? null,
      building: loc.building ?? null,
      isActive: true,
    }
  })

  const locByCode = new Map(locations.map((l) => [l.code, l]))
  for (const loc of locations) {
    if (loc.parentCode) {
      loc.parentId = locByCode.get(loc.parentCode)?.id ?? null
    }
  }

  const staff: SeededStaffAccount[] = HOSPITAL_STAFF_ROLES.map((s) => {
    const dept = deptByCode.get(s.departmentCode)
    const personId = uuidFromRng(rng)
    const staffId = uuidFromRng(rng)
    return {
      id: staffId,
      personId,
      staffCode: s.code,
      displayName: s.displayName,
      email: `synthetic.${s.code}@${slug}.synapseos.local`,
      role: s.role,
      departmentId: dept?.id ?? uuidFromRng(rng),
      departmentCode: s.departmentCode,
      profession: s.profession,
      capabilities: s.capabilities,
      isSynthetic: true as const,
      accountState: "provisioned" as const,
      registrationNumber: `SYN-${s.code.toUpperCase()}-${seed}`,
    }
  })

  const patients: SeededPatient[] = HOSPITAL_TEST_PATIENTS.map((p) => {
    const personId = uuidFromRng(rng)
    const patientId = uuidFromRng(rng)
    const synapseBytes = Uint8Array.from({ length: 5 }, () => Math.floor(rng() * 256))
    const synapseId = generateSynapseId("UG", synapseBytes)
    const mrn = `SIRH-${p.key}-${seed}`
    const fullName = `${p.givenName} ${p.familyName}`
    return {
      id: patientId,
      personId,
      synapseId,
      mrn,
      key: p.key,
      label: p.label,
      journey: p.journey,
      demographics: {
        givenName: p.givenName,
        familyName: p.familyName,
        fullName,
        dateOfBirth: p.dateOfBirth,
        sex: p.sex,
        phone: p.phone,
      },
      aliases: [localMrnIdentifier({ mrn, facilityId: tenantId, organizationId })],
      isSynthetic: true,
      dataClassification: SYNTHETIC_CLASSIFICATION,
    }
  })

  const modules = [
    "core", "registration", "opd", "clinical", "ipd", "lab", "radiology",
    "dispensing", "maternity", "emergency", "theatre", "billing", "claims",
    "referral", "migration", "reports", "public_health",
  ]

  const snapshot: HospitalSeedSnapshot = {
    seed,
    seedVersion: HOSPITAL_SEED_VERSION,
    slug,
    name,
    tenantId,
    hospitalId,
    organizationId,
    environment: "demo",
    isSynthetic: true,
    dataClassification: SYNTHETIC_CLASSIFICATION,
    protectedFlags: { reporting: true, claims: true, notifications: true },
    country: "UG",
    facilityType: "hospital",
    hospitalType: "Regional Referral Hospital",
    contact: {
      address: "Plot 42, Synapse Valley Road, Kampala",
      phone: "+256-800-SYNAPSE",
      email: "demo@synapse-integrated.local",
    },
    departments,
    locations,
    staff,
    patients,
    modules,
    seededAt: now,
  }

  store().registry.set(slug, snapshot)
  store().workQueues.set(tenantId, new WorkQueue(new ExchangeOutbox()))

  return snapshot
}

export function resetHospital(slug: string = HOSPITAL_CANONICAL_SLUG): { ok: true; slug: string } | { ok: false; error: string } {
  const existing = store().registry.get(slug)
  if (!existing) return { ok: false, error: "HOSPITAL_NOT_FOUND" }

  assertDemoResetAllowed({ classification: "demo", isSynthetic: true })

  store().workQueues.delete(existing.tenantId)
  store().registry.delete(slug)

  return { ok: true, slug }
}

export function reseedHospital(options: SeedHospitalOptions): HospitalSeedSnapshot {
  const slug = options.slug ?? HOSPITAL_CANONICAL_SLUG
  const existing = store().registry.get(slug)
  if (existing) {
    assertDemoResetAllowed({ classification: "demo", isSynthetic: true })
    store().workQueues.delete(existing.tenantId)
    store().registry.delete(slug)
  }
  return seedHospital({ ...options, force: true })
}

export function assertProductionSeedBlocked(): void {
  assertDemoResetAllowed({ classification: "production", isSynthetic: true })
}
