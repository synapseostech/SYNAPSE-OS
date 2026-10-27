// Insurance copilot service — ADVISORY ONLY.
// HARD RULE: No auto-submit. No auto-appeal. No auto-preauth.
// Every action that changes claim/preauth status requires explicit human confirmation.
// Every copilot action is logged to insurance_copilot_audit.

import { supabaseAdmin } from '@synapse/db/admin'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabaseAdmin as any

// ── Types ──────────────────────────────────────────────────────────────────

export interface EligibilityResult {
  policyId:     string | null
  covered:      boolean
  copayAmount:  number | null
  planName:     string | null
  expiryDate:   string | null
  notes:        string
}

export interface CoverageCheckResult {
  covered:      boolean
  copayAmount:  number | null
  benefitLimit: number | null
  benefitUsed:  number | null
  notes:        string
}

export interface ClaimDraft {
  id:          string
  status:      'draft'
  patientId:   string | null
  encounterId: string | null
  totalAmount: number
  notes:       string
}

export interface RejectionRiskResult {
  riskScore:   number  // 0-1
  riskLabel:   'low' | 'medium' | 'high'
  reasons:     string[]
  suggestions: string[]
}

// ── Audit helper ───────────────────────────────────────────────────────────

async function auditCopilotAction(params: {
  tenantId:   string
  actorId:    string
  action:     string
  patientId?: string
  resourceId?: string
  input?:     Record<string, unknown>
  output?:    Record<string, unknown>
}): Promise<void> {
  await db.from('insurance_copilot_audit').insert({
    tenant_id:   params.tenantId,
    actor_id:    params.actorId,
    action:      params.action,
    patient_id:  params.patientId ?? null,
    resource_id: params.resourceId ?? null,
    input:       params.input ?? null,
    output:      params.output ?? null,
    ai_model:    null,
  }).catch(() => {})
}

// ── Eligibility check ──────────────────────────────────────────────────────

export async function checkEligibility(params: {
  tenantId:   string
  patientId:  string
  checkedBy:  string
  encounterId?: string
}): Promise<EligibilityResult> {
  // Look up active policy for this patient+tenant
  const { data: policy } = await db
    .from('insurance_policies')
    .select('id, plan_name, copay_amount, expiry_date, status')
    .eq('tenant_id', params.tenantId)
    .eq('patient_id', params.patientId)
    .eq('status', 'active')
    .order('effective_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  const result: EligibilityResult = {
    policyId:    policy?.id ?? null,
    covered:     !!policy,
    copayAmount: policy?.copay_amount ? Number(policy.copay_amount) : null,
    planName:    policy?.plan_name ?? null,
    expiryDate:  policy?.expiry_date ?? null,
    notes:       policy ? 'Active policy found.' : 'No active insurance policy on file.',
  }

  await db.from('insurance_coverage_checks').insert({
    tenant_id:   params.tenantId,
    policy_id:   policy?.id ?? null,
    patient_id:  params.patientId,
    encounter_id: params.encounterId ?? null,
    checked_by:  params.checkedBy,
    check_type:  'eligibility',
    covered:     result.covered,
    copay_amount: result.copayAmount,
    notes:       result.notes,
  })

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.checkedBy,
    action:     'eligibility_check',
    patientId:  params.patientId,
    input:      { patient_id: params.patientId },
    output:     { covered: result.covered, plan: result.planName },
  })

  return result
}

// ── Coverage check ─────────────────────────────────────────────────────────

export async function runCoverageCheck(params: {
  tenantId:    string
  patientId:   string
  policyId:    string
  benefitKey:  string
  serviceCode?: string
  checkedBy:   string
  encounterId?: string
}): Promise<CoverageCheckResult> {
  // The policy is the ownership anchor: benefits are only read once the policy
  // is proven to belong to the caller's tenant.
  const { data: policy } = await db
    .from('insurance_policies')
    .select('copay_amount')
    .eq('id', params.policyId)
    .eq('tenant_id', params.tenantId)
    .maybeSingle()

  if (!policy) {
    return {
      covered:      false,
      copayAmount:  null,
      benefitLimit: null,
      benefitUsed:  null,
      notes:        'Policy not found for this facility.',
    }
  }

  const { data: benefit } = await db
    .from('insurance_benefits')
    .select('limit_amount, used_amount, period')
    .eq('policy_id', params.policyId)
    .eq('benefit_key', params.benefitKey)
    .maybeSingle()

  const limitAmount = benefit?.limit_amount ? Number(benefit.limit_amount) : null
  const usedAmount  = benefit?.used_amount  ? Number(benefit.used_amount)  : null

  const covered = !!benefit && (limitAmount === null || (usedAmount ?? 0) < (limitAmount ?? Infinity))
  const result: CoverageCheckResult = {
    covered,
    copayAmount:  policy?.copay_amount ? Number(policy.copay_amount) : null,
    benefitLimit: limitAmount,
    benefitUsed:  usedAmount,
    notes: covered
      ? `Benefit '${params.benefitKey}' is available.`
      : `Benefit '${params.benefitKey}' is not covered or limit exhausted.`,
  }

  await db.from('insurance_coverage_checks').insert({
    tenant_id:    params.tenantId,
    policy_id:    params.policyId,
    patient_id:   params.patientId,
    encounter_id: params.encounterId ?? null,
    checked_by:   params.checkedBy,
    check_type:   'benefit',
    service_code: params.serviceCode ?? null,
    covered:      result.covered,
    copay_amount: result.copayAmount,
    benefit_limit: result.benefitLimit,
    benefit_used:  result.benefitUsed,
    notes:         result.notes,
  })

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.checkedBy,
    action:     'coverage_check',
    patientId:  params.patientId,
    input:      { benefit_key: params.benefitKey, service_code: params.serviceCode },
    output:     { covered, limit: limitAmount, used: usedAmount },
  })

  return result
}

// ── Preauth draft (ADVISORY — never auto-submit) ────────────────────────────

export async function draftPreauthorization(params: {
  tenantId:       string
  patientId:      string
  policyId:       string
  encounterId?:   string
  requestedBy:    string
  authType:       string
  diagnosisCodes: string[]
  procedureCodes: string[]
  estimatedCost:  number
  clinicalNotes?: string
}): Promise<string> {
  const { data, error } = await db
    .from('insurance_preauthorizations')
    .insert({
      tenant_id:       params.tenantId,
      patient_id:      params.patientId,
      policy_id:       params.policyId,
      encounter_id:    params.encounterId ?? null,
      requested_by:    params.requestedBy,
      auth_type:       params.authType,
      diagnosis_codes: params.diagnosisCodes,
      procedure_codes: params.procedureCodes,
      estimated_cost:  params.estimatedCost,
      clinical_notes:  params.clinicalNotes ?? null,
      status:          'draft',   // NEVER 'submitted' — human must submit manually
    })
    .select('id')
    .single()

  if (error) throw new Error(`Failed to create preauth draft: ${error.message}`)

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.requestedBy,
    action:     'preauth_drafted',
    patientId:  params.patientId,
    resourceId: data.id,
    input:      { auth_type: params.authType, estimated_cost: params.estimatedCost },
    output:     { preauth_id: data.id, status: 'draft' },
  })

  return data.id
}

// ── Claim draft (ADVISORY — never auto-submit) ──────────────────────────────

export async function generateClaimDraft(params: {
  tenantId:    string
  patientId:   string
  encounterId: string
  policyId:    string
  actorId:     string
}): Promise<ClaimDraft> {
  // Pull encounter + diagnosis data for draft. The encounter must belong to
  // this tenant and to the patient named on the request; diagnoses are then
  // read by encounter id, which is safe once the encounter is proven owned.
  const { data: encounter } = await db
    .from('encounters')
    .select('id, created_at')
    .eq('id', params.encounterId)
    .eq('tenant_id', params.tenantId)
    .eq('patient_id', params.patientId)
    .maybeSingle()

  const { data: diagnoses } = encounter
    ? await db
        .from('encounter_diagnoses')
        .select('title, stem_code')
        .eq('encounter_id', params.encounterId)
    : { data: null }

  const notes = encounter
    ? `Draft generated from encounter ${params.encounterId}. ` +
      `Diagnoses: ${(diagnoses ?? []).map((d: Record<string, string>) => d.title).join(', ') || 'none'}. ` +
      `Review and submit manually.`
    : `Draft could not be verified: encounter ${params.encounterId} was not found for this facility and patient. ` +
      `Confirm the encounter before relying on this draft.`

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.actorId,
    action:     'claim_drafted',
    patientId:  params.patientId,
    resourceId: params.encounterId,
    input:      { encounter_id: params.encounterId, policy_id: params.policyId },
    output:     { status: 'draft', note: 'advisory only' },
  })

  return {
    id:          encounter?.id ?? params.encounterId,
    status:      'draft',
    patientId:   params.patientId,
    encounterId: params.encounterId,
    totalAmount: 0,
    notes,
  }
}

// ── Rejection risk score (heuristic, advisory) ─────────────────────────────

export async function scoreRejectionRisk(params: {
  tenantId:       string
  policyId:       string
  diagnosisCodes: string[]
  procedureCodes: string[]
  estimatedCost:  number
  actorId:        string
}): Promise<RejectionRiskResult> {
  const reasons: string[]     = []
  const suggestions: string[] = []
  let riskScore = 0

  // Heuristic checks
  if (!params.diagnosisCodes.length) { reasons.push('No diagnosis codes attached.'); riskScore += 0.3 }
  if (!params.procedureCodes.length) { reasons.push('No procedure codes attached.'); riskScore += 0.2 }
  if (params.estimatedCost > 5_000_000) {
    reasons.push('High estimated cost may trigger manual review.')
    suggestions.push('Attach clinical justification for high-cost procedures.')
    riskScore += 0.25
  }

  if (riskScore === 0) suggestions.push('Claim looks complete. Verify codes before submitting.')

  riskScore = Math.min(1, riskScore)
  const riskLabel: RejectionRiskResult['riskLabel'] =
    riskScore < 0.3 ? 'low' : riskScore < 0.6 ? 'medium' : 'high'

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.actorId,
    action:     'rejection_risk_scored',
    input:      { diagnosis_codes: params.diagnosisCodes, estimated_cost: params.estimatedCost },
    output:     { risk_score: riskScore, risk_label: riskLabel },
  })

  return { riskScore, riskLabel, reasons, suggestions }
}

// ── Denial explanation + appeal draft (advisory) ───────────────────────────

export async function explainDenial(params: {
  tenantId:  string
  claimId:   string
  actorId:   string
}): Promise<{ explanation: string; appealPoints: string[] }> {
  const { data: claim } = await db
    .from('insurance_claims')
    .select('denial_reason, status, claim_amount')
    .eq('id', params.claimId)
    .eq('tenant_id', params.tenantId)
    .maybeSingle()

  const explanation = claim?.denial_reason
    ? `Claim denied: ${claim.denial_reason}. Amount: ${claim.claim_amount}.`
    : 'No denial reason on record. Check with payer directly.'

  const appealPoints = [
    'Verify diagnosis and procedure codes are correct.',
    'Confirm policy was active on date of service.',
    'Attach supporting clinical documentation.',
    'Contact payer for specific denial code clarification.',
  ]

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.actorId,
    action:     'denial_explained',
    resourceId: params.claimId,
    output:     { explanation },
  })

  return { explanation, appealPoints }
}

export async function draftAppeal(params: {
  tenantId:    string
  claimId:     string
  actorId:     string
  extraNotes?: string
}): Promise<string> {
  const { explanation, appealPoints } = await explainDenial({
    tenantId: params.tenantId,
    claimId:  params.claimId,
    actorId:  params.actorId,
  })

  const draft = [
    `APPEAL DRAFT — Do not send without clinical review`,
    ``,
    explanation,
    ``,
    `Grounds for appeal:`,
    ...appealPoints.map(p => `- ${p}`),
    params.extraNotes ? `\nAdditional notes: ${params.extraNotes}` : '',
  ].join('\n')

  await auditCopilotAction({
    tenantId:   params.tenantId,
    actorId:    params.actorId,
    action:     'appeal_drafted',
    resourceId: params.claimId,
    output:     { draft_length: draft.length, status: 'draft' },
  })

  // ADVISORY ONLY — returns draft text; human must copy/submit manually
  return draft
}
