import { z } from 'zod'

export const patientRegisterSchema = z.object({
  full_name: z.string().min(1).max(200),
  dob: z.string().min(4).max(40).optional(),
  sex: z.enum(['M', 'F']),
  phone: z.string().max(30).optional(),
  district: z.string().max(100).optional(),
  nin: z.string().max(30).optional(),
  duplicate_override_reason: z.string().trim().min(5).max(500).optional(),
})

export const triageSchema = z.object({
  patient_id: z.string().uuid(),
  chief_complaint: z.string().min(1).max(2000),
  clinical_stage: z.enum(['RED', 'YELLOW', 'GREEN']).optional(),
  bp_systolic: z.coerce.number().min(50).max(300).optional(),
  bp_diastolic: z.coerce.number().min(20).max(200).optional(),
  heart_rate: z.coerce.number().min(20).max(250).optional(),
  respiratory_rate: z.coerce.number().min(5).max(60).optional(),
  temperature_c: z.coerce.number().min(30).max(43).optional(),
  spo2: z.coerce.number().min(50).max(100).optional(),
})

export const labOrderCreateSchema = z.object({
  encounter_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  loinc_code: z.string().min(1).max(40),
  test_name: z.string().min(1).max(500),
  urgency: z.enum(['STAT', 'URGENT', 'ROUTINE']).optional(),
  care_plan_id: z.string().uuid().optional(),
  person_id: z.string().uuid().optional(),
  replaces_lab_order_id: z.string().uuid().optional(),
})

export const prescriptionCreateSchema = z.object({
  encounter_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  medication_display: z.string().min(1).max(500),
  dose: z.string().min(1).max(2000),
  quantity: z.coerce.number().positive(),
  unit: z.string().min(1).max(40).default('unit'),
  care_plan_id: z.string().uuid().optional(),
  person_id: z.string().uuid().optional(),
  pharmacy_tenant_id: z.string().uuid().optional(),
  /**
   * Present only when a prescriber is deliberately proceeding past a clinical
   * safety block. A short reason is rejected: an override that says "ok" is not
   * a record of a clinical decision.
   */
  safety_override_reason: z.string().trim().min(8).max(500).optional(),
})

export const hospitalDispenseSchema = z.object({
  prescription_id: z.string().uuid(),
  product_id: z.string().uuid(),
  pharmacy_tenant_id: z.string().uuid(),
  payment_method: z.string().min(1).max(40).default('cash'),
  /** See `safety_override_reason` on `prescriptionCreateSchema`. */
  safety_override_reason: z.string().trim().min(8).max(500).optional(),
})

export const admissionCreateSchema = z.object({
  patient_id: z.string().uuid(),
  bed_id: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  encounter_id: z.string().uuid().optional(),
})

export const vitalsRecordSchema = z.object({
  encounter_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  bp_systolic: z.coerce.number().min(50).max(300).optional(),
  bp_diastolic: z.coerce.number().min(20).max(200).optional(),
  heart_rate: z.coerce.number().min(20).max(250).optional(),
  respiratory_rate: z.coerce.number().min(5).max(60).optional(),
  temperature_c: z.coerce.number().min(30).max(43).optional(),
  spo2: z.coerce.number().min(50).max(100).optional(),
  weight_kg: z.coerce.number().min(0.5).max(400).optional(),
  height_cm: z.coerce.number().min(20).max(250).optional(),
  clinical_stage: z.enum(['RED', 'YELLOW', 'GREEN']).optional(),
})

export const encounterAmendSchema = z.object({
  field: z.enum(['chief_complaint', 'clinical_stage', 'clinical_note']),
  new_value: z.string().min(1).max(4000),
  reason: z.string().min(3).max(2000),
})

export const edTriageSchema = z.object({
  patient_id: z.string().uuid(),
  chief_complaint: z.string().min(1).max(2000),
  clinical_stage: z.enum(['RED', 'YELLOW', 'GREEN']),
  arrival_mode: z.enum(['walk_in', 'ambulance', 'referral']).optional(),
  bp_systolic: z.coerce.number().min(50).max(300).optional(),
  bp_diastolic: z.coerce.number().min(20).max(200).optional(),
  heart_rate: z.coerce.number().min(20).max(250).optional(),
  respiratory_rate: z.coerce.number().min(5).max(60).optional(),
  temperature_c: z.coerce.number().min(30).max(43).optional(),
  spo2: z.coerce.number().min(50).max(100).optional(),
})

export const encounterPaymentSchema = z.object({
  amount: z.coerce.number().positive(),
  payment_method: z.enum(['cash', 'mobile_money', 'card', 'bank_transfer']).default('cash'),
  payment_ref: z.string().max(120).optional(),
  idempotency_key: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
})

export const edAssignBaySchema = z.object({
  encounter_id: z.string().uuid(),
  patient_id: z.string().uuid(),
  bay_id: z.string().uuid(),
})
