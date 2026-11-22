import type { ContinuitySummary } from '@synapse/db/patient-continuity'
import type { ClinicalWriteup } from '@synapse/db/clinical-writeup'
import type { FindingMap } from '@synapse/interop/differential-engine'

export type WorkspaceDiagnosis = {
  encounter_id: string
  stem_code: string
  title: string
  certainty: 'confirmed' | 'suspected' | 'differential' | string
  diagnosis_type: string
  suggested_by?: string | null
}

export type WorkspaceLabResult = {
  test_name: string | null
  value?: string | null
  result_value?: string | null
  numeric_value?: number | string | null
  unit?: string | null
  is_abnormal?: boolean | null
  is_critical?: boolean | null
  abnormal_flag?: string | null
  status?: string | null
}

export type WorkspaceLabOrder = {
  id: string
  test_name: string | null
  loinc_code: string | null
  workflow_status: string | null
  status: string | null
  urgency: string | null
  ordered_at: string | null
  accession_number: string | null
  results: WorkspaceLabResult[]
}

export type WorkspaceVitals = {
  bp_systolic?: number | null
  bp_diastolic?: number | null
  heart_rate?: number | null
  temperature_c?: number | null
  spo2?: number | null
  respiratory_rate?: number | null
  weight_kg?: number | null
  height_cm?: number | null
  recorded_at?: string | null
}

export type LabCatalogEntry = {
  id: string
  code: string
  loinc_code: string | null
  name: string
  section: string
  price: number | null
  currency: string | null
  turnaround_minutes: number | null
}

export type WorkspaceResponse = {
  encounter: {
    id: string
    patientId: string
    chiefComplaint: string | null
    status: string | null
    isSigned: boolean
    visitDate: string | null
    disposition: string | null
    writeup: ClinicalWriteup
    completeness: { percent?: number; missing?: string[] } & Record<string, unknown>
    findings: FindingMap
    vitals: WorkspaceVitals | null
    diagnoses: WorkspaceDiagnosis[]
    labOrders: WorkspaceLabOrder[]
    prescriptions: { medication_display: string | null; dose: string | null; status: string | null }[]
  }
  summary: ContinuitySummary
  labCatalog: LabCatalogEntry[]
}
