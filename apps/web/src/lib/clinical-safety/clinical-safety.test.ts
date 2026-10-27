import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SAFETY_POLICY,
  decideSafety,
  evaluateSafety,
  loadSafetyPolicy,
  matchesAtcPrefix,
  matchesIcd,
  matchDrugName,
  normaliseName,
  parseReferenceRange,
  rangeApplies,
  toResponsePayload,
  type SafetyCoverage,
  type SafetyInputs,
} from './index'

function loadedCoverage(): SafetyCoverage {
  const loaded = { state: 'loaded' as const, rows: 1 }
  return {
    allergies: { state: 'loaded', rows: 0 },
    interactions: loaded,
    contraindications: loaded,
    doseAdjustments: loaded,
    renalFunction: { state: 'loaded', rows: 1 },
  }
}

function baseInputs(overrides: Partial<SafetyInputs> = {}): SafetyInputs {
  return {
    candidates: [{ label: 'Warfarin 5mg tablets', aliases: [], role: 'new' }],
    allergies: [],
    interactions: [],
    contraindications: [],
    doseAdjustments: [],
    renal: null,
    diagnoses: [],
    ageYears: 40,
    weightKg: 70,
    coverage: loadedCoverage(),
    ...overrides,
  }
}

describe('normaliseName', () => {
  it('strips strengths, dosage forms and punctuation', () => {
    expect(normaliseName('Paracetamol 500mg tablets')).toEqual(['paracetamol'])
    expect(normaliseName('Amoxicillin 250 mg / 5 ml oral suspension')).toEqual(['amoxicillin'])
    expect(normaliseName('Co-amoxiclav 625mg')).toEqual(['co', 'amoxiclav'])
  })

  it('returns an empty list for empty input', () => {
    expect(normaliseName('')).toEqual([])
    expect(normaliseName(null)).toEqual([])
    expect(normaliseName('500mg')).toEqual([])
  })
})

describe('matchDrugName', () => {
  it('matches identical identities exactly', () => {
    expect(matchDrugName('Paracetamol 500mg', 'Paracetamol')).toBe('exact')
    expect(matchDrugName('paracetamol', 'PARACETAMOL 500 MG TABLET')).toBe('exact')
  })

  it('matches a catalogue name appearing as whole tokens in a longer label', () => {
    expect(matchDrugName('Paracetamol Actavis 500mg', 'Paracetamol')).toBe('token')
    expect(matchDrugName('Warfarin sodium 5mg', 'Warfarin')).toBe('token')
  })

  it('refuses matches that cross a token boundary', () => {
    expect(matchDrugName('Penicillamine 250mg', 'Penicillin')).toBe('none')
    expect(matchDrugName('Paracetamols', 'Paracetamol')).toBe('none')
  })

  it('refuses catalogue names too short to be discriminating', () => {
    expect(matchDrugName('ASA', 'ASA')).toBe('none')
  })
})

describe('matchesAtcPrefix', () => {
  it('treats a parent ATC group as covering its children', () => {
    expect(matchesAtcPrefix('N02BE01', 'N02BE')).toBe(true)
    expect(matchesAtcPrefix('N02BE01', 'N02')).toBe(true)
    expect(matchesAtcPrefix('N02', 'N02BE01')).toBe(true)
  })

  it('does not match unrelated classes', () => {
    expect(matchesAtcPrefix('N02BE01', 'J01CA04')).toBe(false)
    expect(matchesAtcPrefix(null, 'N02')).toBe(false)
  })
})

describe('matchesIcd', () => {
  it('treats a stem code as covering its children', () => {
    expect(matchesIcd('5A11.0', '5A11')).toBe(true)
    expect(matchesIcd('5A11', '5A11.0')).toBe(true)
    expect(matchesIcd('5A11.0', '5A11.0')).toBe(true)
  })

  it('does not match siblings or unrelated codes', () => {
    expect(matchesIcd('5A11.0', '5A11.1')).toBe(false)
    expect(matchesIcd('5A11', '1A00')).toBe(false)
    expect(matchesIcd('', '1A00')).toBe(false)
  })
})

describe('parseReferenceRange', () => {
  it('parses the operator forms a renal band is written in', () => {
    expect(parseReferenceRange('<60')).toMatchObject({ operator: 'lt', low: 60 })
    expect(parseReferenceRange('<= 30')).toMatchObject({ operator: 'lte', low: 30 })
    expect(parseReferenceRange('>90')).toMatchObject({ operator: 'gt', low: 90 })
    expect(parseReferenceRange('>= 90')).toMatchObject({ operator: 'gte', low: 90 })
  })

  it('parses ranges written with either separator', () => {
    expect(parseReferenceRange('30-60')).toMatchObject({ operator: 'between', low: 30, high: 60 })
    expect(parseReferenceRange('30 to 60')).toMatchObject({ operator: 'between', low: 30, high: 60 })
    expect(parseReferenceRange('60-30')).toMatchObject({ operator: 'between', low: 30, high: 60 })
  })

  it('parses bands written in words', () => {
    expect(parseReferenceRange('less than 30')).toMatchObject({ operator: 'lt', low: 30 })
    expect(parseReferenceRange('below 30')).toMatchObject({ operator: 'lt', low: 30 })
    expect(parseReferenceRange('greater than 60')).toMatchObject({ operator: 'gt', low: 60 })
    expect(parseReferenceRange('at least 60')).toMatchObject({ operator: 'gte', low: 60 })
    expect(parseReferenceRange('no more than 45')).toMatchObject({ operator: 'lte', low: 45 })
  })

  it('refuses a two-sided rule rather than dropping half of it', () => {
    expect(parseReferenceRange('<30 or >60')).toBeNull()
    expect(parseReferenceRange('less than 30 or more than 60')).toBeNull()
  })

  it('refuses a bare number instead of treating it as equality', () => {
    expect(parseReferenceRange('30')).toBeNull()
  })

  it('returns null when there is no number to parse', () => {
    expect(parseReferenceRange('severe impairment')).toBeNull()
    expect(parseReferenceRange('')).toBeNull()
    expect(parseReferenceRange(null)).toBeNull()
  })

  it('applies ranges inclusively at the boundary', () => {
    const between = parseReferenceRange('30-60')!
    expect(rangeApplies(between, 30)).toBe(true)
    expect(rangeApplies(between, 60)).toBe(true)
    expect(rangeApplies(between, 61)).toBe(false)
    const below = parseReferenceRange('<60')!
    expect(rangeApplies(below, 59.9)).toBe(true)
    expect(rangeApplies(below, 60)).toBe(false)
  })
})

describe('evaluateSafety — allergies', () => {
  it('raises a high alert for a recorded severe allergy to the drug ordered', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        allergies: [
          {
            id: 'a1',
            allergen: 'Warfarin',
            allergen_type: 'drug',
            atc_code: null,
            reaction: 'angioedema',
            severity: 'severe',
            verified: true,
            origin: 'patient_allergies',
          },
        ],
      }),
    )
    expect(evaluation.alerts).toHaveLength(1)
    expect(evaluation.alerts[0]).toMatchObject({ kind: 'allergy_match', severity: 'high' })
    expect(evaluation.alerts[0].detail).toContain('angioedema')
    expect(evaluation.highest).toBe('high')
  })

  it('ranks anaphylaxis above severe and unknown severity above mild', () => {
    const rows = (severity: string) => [
      {
        id: `a-${severity}`,
        allergen: 'Warfarin',
        allergen_type: 'drug',
        atc_code: null,
        reaction: null,
        severity,
        verified: true,
        origin: 'patient_allergies' as const,
      },
    ]
    expect(evaluateSafety(baseInputs({ allergies: rows('anaphylaxis') })).highest).toBe('critical')
    expect(evaluateSafety(baseInputs({ allergies: rows('unknown') })).highest).toBe('moderate')
    expect(evaluateSafety(baseInputs({ allergies: rows('mild') })).highest).toBe('low')
  })

  it('matches an allergy recorded only against an ATC parent', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [
          { label: 'Ibuprofen 400mg', aliases: [], atcCode: 'M01AE01', role: 'new' },
        ],
        allergies: [
          {
            id: 'a2',
            allergen: 'NSAIDs',
            allergen_type: 'drug',
            atc_code: 'M01AE',
            reaction: 'bronchospasm',
            severity: 'severe',
            verified: true,
            origin: 'patient_allergies',
          },
        ],
      }),
    )
    expect(evaluation.alerts[0].detail).toContain('ATC M01AE')
  })

  it('does not alert on an allergy to a different drug', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        allergies: [
          {
            id: 'a3',
            allergen: 'Penicillin',
            allergen_type: 'drug',
            atc_code: null,
            reaction: null,
            severity: 'anaphylaxis',
            verified: true,
            origin: 'patient_allergies',
          },
        ],
      }),
    )
    expect(evaluation.alerts).toEqual([])
  })

  it('does not check allergies against drugs already on the regimen', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [
          { label: 'Warfarin 5mg', aliases: [], role: 'new' },
          { label: 'Penicillin V', aliases: [], role: 'current' },
        ],
        allergies: [
          {
            id: 'a4',
            allergen: 'Penicillin',
            allergen_type: 'drug',
            atc_code: null,
            reaction: null,
            severity: 'severe',
            verified: true,
            origin: 'patient_allergies',
          },
        ],
      }),
    )
    expect(evaluation.alerts).toEqual([])
  })
})

describe('evaluateSafety — interactions', () => {
  const interactionRow = {
    id: 'i1',
    drug_a_code: 'B01AA03',
    drug_a_name: 'Warfarin',
    drug_b_code: 'N02BE01',
    drug_b_name: 'Paracetamol',
    severity: 'major',
    mechanism: 'potentiates anticoagulant effect',
    clinical_effect: 'raised INR and bleeding risk',
    management: 'avoid regular use; monitor INR',
  }

  it('raises an alert when the new drug and a current drug are an interacting pair', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [
          { label: 'Warfarin 5mg', aliases: [], role: 'current' },
          { label: 'Paracetamol 1g', aliases: [], role: 'new' },
        ],
        interactions: [interactionRow],
      }),
    )
    expect(evaluation.alerts).toHaveLength(1)
    expect(evaluation.alerts[0]).toMatchObject({ kind: 'interaction', severity: 'high' })
    expect(evaluation.alerts[0].recommendation).toContain('monitor INR')
  })

  it('does not raise an alert when the other half of the pair is not in play', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Warfarin 5mg', aliases: [], role: 'new' }],
        interactions: [interactionRow],
      }),
    )
    expect(evaluation.alerts).toEqual([])
  })

  it('maps a contraindicated interaction to critical', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [
          { label: 'Warfarin 5mg', aliases: [], role: 'new' },
          { label: 'Aspirin 75mg', aliases: [], role: 'current' },
        ],
        interactions: [
          { ...interactionRow, drug_b_name: 'Aspirin', severity: 'contraindicated' },
        ],
      }),
    )
    expect(evaluation.highest).toBe('critical')
  })
})

describe('evaluateSafety — contraindications', () => {
  const row = {
    id: 'c1',
    drug_code: 'C03CA01',
    drug_name: 'Furosemide',
    condition_icd11: '5A11',
    condition_name: 'Type 2 diabetes mellitus',
    severity: 'absolute',
    reason: 'may worsen glycaemic control',
    alternative: 'thiazide',
  }

  it('raises a critical alert when the patient has the contraindicated condition', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Furosemide 40mg', aliases: [], role: 'new' }],
        contraindications: [row],
        diagnoses: [{ code: '5A11.0', name: 'T2DM with renal complication' }],
      }),
    )
    expect(evaluation.alerts).toHaveLength(1)
    expect(evaluation.alerts[0]).toMatchObject({ kind: 'contraindication', severity: 'critical' })
    expect(evaluation.alerts[0].recommendation).toBe('thiazide')
  })

  it('does not raise an alert for a condition the patient does not have', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Furosemide 40mg', aliases: [], role: 'new' }],
        contraindications: [row],
        diagnoses: [{ code: '1A00', name: 'Cholera' }],
      }),
    )
    expect(evaluation.alerts).toEqual([])
  })
})

describe('evaluateSafety — dose adjustment', () => {
  const renalRow = {
    id: 'd1',
    drug_code: 'J01CA04',
    drug_name: 'Amoxicillin',
    organ_type: 'renal',
    reference_range: '<30',
    standard_dose: '500mg TID',
    adjusted_dose: '500mg BD',
    dose_note: 'extend interval',
    is_avoid: false,
  }

  it('raises an alert when the measured renal function falls inside the band', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Amoxicillin 500mg', aliases: [], role: 'new' }],
        doseAdjustments: [renalRow],
        renal: { value: 22, unit: 'mL/min/1.73m²', source: 'egfr', recordedAt: null },
      }),
    )
    expect(evaluation.alerts).toHaveLength(1)
    expect(evaluation.alerts[0]).toMatchObject({ kind: 'dose_adjustment', severity: 'high' })
    expect(evaluation.alerts[0].detail).toContain('500mg BD')
  })

  it('stays silent when renal function is outside the band', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Amoxicillin 500mg', aliases: [], role: 'new' }],
        doseAdjustments: [renalRow],
        renal: { value: 95, unit: 'mL/min/1.73m²', source: 'egfr', recordedAt: null },
      }),
    )
    expect(evaluation.alerts).toEqual([])
  })

  it('raises avoid-level guidance as critical', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Amoxicillin 500mg', aliases: [], role: 'new' }],
        doseAdjustments: [{ ...renalRow, is_avoid: true }],
        renal: { value: 12, unit: 'mL/min/1.73m²', source: 'egfr', recordedAt: null },
      }),
    )
    expect(evaluation.highest).toBe('critical')
  })

  it('reports an unmeasured organ as a data-quality info alert, not as a finding', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Amoxicillin 500mg', aliases: [], role: 'new' }],
        doseAdjustments: [renalRow],
        renal: null,
      }),
    )
    expect(evaluation.alerts).toHaveLength(1)
    expect(evaluation.alerts[0]).toMatchObject({ severity: 'info', dataQuality: true })
  })

  it('reports an unparseable band as needing review rather than skipping it', () => {
    const evaluation = evaluateSafety(
      baseInputs({
        candidates: [{ label: 'Amoxicillin 500mg', aliases: [], role: 'new' }],
        doseAdjustments: [{ ...renalRow, reference_range: 'severe impairment' }],
        renal: { value: 20, unit: 'mL/min/1.73m²', source: 'egfr', recordedAt: null },
      }),
    )
    expect(evaluation.alerts).toHaveLength(1)
    expect(evaluation.alerts[0]).toMatchObject({ severity: 'moderate', dataQuality: true })
  })
})

describe('evaluateSafety — coverage', () => {
  it('is indeterminate when a risk catalogue it consulted is empty', () => {
    const coverage = loadedCoverage()
    coverage.interactions = {
      state: 'empty',
      rows: 0,
      reason: 'drug_interactions has no rows in this environment',
    }
    const evaluation = evaluateSafety(baseInputs({ coverage }))
    expect(evaluation.indeterminate).toBe(true)
    expect(evaluation.indeterminateDomains).toContain('interactions')
    expect(evaluation.alerts).toEqual([])
  })

  it('is indeterminate when a catalogue read failed', () => {
    const coverage = loadedCoverage()
    coverage.doseAdjustments = { state: 'unavailable', rows: 0, reason: 'timeout' }
    const evaluation = evaluateSafety(baseInputs({ coverage }))
    expect(evaluation.indeterminateDomains).toContain('doseAdjustments')
  })

  it('is not indeterminate when every catalogue was loaded, even with no findings', () => {
    const evaluation = evaluateSafety(baseInputs())
    expect(evaluation.indeterminate).toBe(false)
    expect(evaluation.indeterminateDomains).toEqual([])
    expect(evaluation.highest).toBe('none')
  })

  it('treats an empty allergy list as a clean result, not a gap', () => {
    const coverage = loadedCoverage()
    coverage.allergies = { state: 'loaded', rows: 0 }
    expect(evaluateSafety(baseInputs({ coverage })).indeterminate).toBe(false)
  })

  it('treats a failed allergy read as a gap', () => {
    const coverage = loadedCoverage()
    coverage.allergies = { state: 'unavailable', rows: 0, reason: 'permission denied' }
    expect(evaluateSafety(baseInputs({ coverage })).indeterminate).toBe(true)
  })
})

describe('decideSafety', () => {
  function evaluationWith(overrides: Partial<SafetyInputs>, coverage?: SafetyCoverage) {
    return evaluateSafety(baseInputs({ coverage: coverage ?? loadedCoverage(), ...overrides }))
  }

  const severeAllergy = [
    {
      id: 'a1',
      allergen: 'Warfarin',
      allergen_type: 'drug',
      atc_code: null,
      reaction: 'angioedema',
      severity: 'severe',
      verified: true,
      origin: 'patient_allergies' as const,
    },
  ]

  it('blocks on a severe allergy under the default policy', () => {
    const decision = decideSafety(evaluationWith({ allergies: severeAllergy }), DEFAULT_SAFETY_POLICY)
    expect(decision.decision).toBe('block')
    expect(decision.blocking).toHaveLength(1)
    expect(decision.reasons[0]).toContain('allergy blocks at high')
  })

  it('does not block on a mild allergy under the default policy', () => {
    const mild = [{ ...severeAllergy[0], severity: 'mild' }]
    const decision = decideSafety(evaluationWith({ allergies: mild }), DEFAULT_SAFETY_POLICY)
    expect(decision.decision).toBe('warn')
    expect(decision.blocking).toEqual([])
  })

  it('warns on a major interaction under the default policy', () => {
    const evaluation = evaluationWith({
      candidates: [
        { label: 'Warfarin 5mg', aliases: [], role: 'new' },
        { label: 'Paracetamol 1g', aliases: [], role: 'current' },
      ],
      interactions: [
        {
          id: 'i1',
          drug_a_code: 'B01AA03',
          drug_a_name: 'Warfarin',
          drug_b_code: 'N02BE01',
          drug_b_name: 'Paracetamol',
          severity: 'major',
          mechanism: null,
          clinical_effect: 'bleeding risk',
          management: null,
        },
      ],
    })
    const decision = decideSafety(evaluation, DEFAULT_SAFETY_POLICY)
    expect(decision.decision).toBe('warn')
    expect(decision.suppressed).toHaveLength(1)
  })

  it('blocks on a major interaction once the deployment policy is tightened', () => {
    const policy = { ...DEFAULT_SAFETY_POLICY, interaction: { mode: 'block' as const, blockAtOrAbove: 'high' as const } }
    const evaluation = evaluationWith({
      candidates: [
        { label: 'Warfarin 5mg', aliases: [], role: 'new' },
        { label: 'Paracetamol 1g', aliases: [], role: 'current' },
      ],
      interactions: [
        {
          id: 'i1',
          drug_a_code: 'B01AA03',
          drug_a_name: 'Warfarin',
          drug_b_code: 'N02BE01',
          drug_b_name: 'Paracetamol',
          severity: 'major',
          mechanism: null,
          clinical_effect: 'bleeding risk',
          management: null,
        },
      ],
    })
    expect(decideSafety(evaluation, policy).decision).toBe('block')
  })

  it('never blocks on a data-quality alert alone', () => {
    const evaluation = evaluationWith({
      doseAdjustments: [
        {
          id: 'd1',
          drug_code: 'x',
          drug_name: 'Warfarin',
          organ_type: 'renal',
          reference_range: '<30',
          standard_dose: null,
          adjusted_dose: null,
          dose_note: null,
          is_avoid: true,
        },
      ],
      renal: null,
    })
    const policy = { ...DEFAULT_SAFETY_POLICY, dose: { mode: 'block' as const, blockAtOrAbove: 'info' as const } }
    const decision = decideSafety(evaluation, policy)
    expect(decision.blocking).toEqual([])
    expect(decision.decision).toBe('warn')
  })

  it('blocks when the deployment asks it to and the data is not there', () => {
    const coverage = loadedCoverage()
    coverage.interactions = { state: 'empty', rows: 0, reason: 'no rows' }
    const policy = { ...DEFAULT_SAFETY_POLICY, indeterminate: { mode: 'block' as const, blockAtOrAbove: 'info' as const } }
    const decision = decideSafety(evaluateSafety(baseInputs({ coverage })), policy)
    expect(decision.decision).toBe('block')
    expect(decision.reasons.join(' ')).toContain('could not exclude a risk')
  })

  it('allows when every catalogue was loaded and nothing was found', () => {
    expect(decideSafety(evaluationWith({}), DEFAULT_SAFETY_POLICY).decision).toBe('allow')
  })

  it('allows when the domain policy is switched off, even with a severe finding', () => {
    const policy = { ...DEFAULT_SAFETY_POLICY, allergy: { mode: 'off' as const, blockAtOrAbove: 'high' as const } }
    const decision = decideSafety(evaluationWith({ allergies: severeAllergy }), policy)
    expect(decision.decision).toBe('allow')
    expect(decision.blocking).toEqual([])
  })
})

describe('loadSafetyPolicy', () => {
  it('returns the documented defaults when nothing is set', () => {
    const { policy, warnings } = loadSafetyPolicy({})
    expect(policy).toEqual(DEFAULT_SAFETY_POLICY)
    expect(warnings).toEqual([])
  })

  it('takes a valid override from the environment', () => {
    const { policy } = loadSafetyPolicy({
      CLINICAL_SAFETY_INTERACTION_MODE: 'block',
      CLINICAL_SAFETY_INTERACTION_BLOCKAT: 'moderate',
    })
    expect(policy.interaction).toEqual({ mode: 'block', blockAtOrAbove: 'moderate' })
  })

  it('falls back to the default and says so when the value is unparseable', () => {
    const { policy, warnings } = loadSafetyPolicy({ CLINICAL_SAFETY_ALLERGY_MODE: 'yes' })
    expect(policy.allergy).toEqual(DEFAULT_SAFETY_POLICY.allergy)
    expect(warnings[0]).toContain('CLINICAL_SAFETY_ALLERGY_MODE')
  })
})

describe('toResponsePayload', () => {
  it('carries coverage and indeterminacy so a client cannot read a gap as a pass', () => {
    const coverage = loadedCoverage()
    coverage.interactions = { state: 'empty', rows: 0, reason: 'no rows' }
    const evaluation = evaluateSafety(baseInputs({ coverage }))
    const decision = decideSafety(evaluation, DEFAULT_SAFETY_POLICY)
    const payload = toResponsePayload(evaluation, decision)
    expect(payload.decision).toBe('warn')
    expect(payload.indeterminate).toBe(true)
    expect(payload.indeterminateDomains).toContain('interactions')
    expect(payload.coverage.interactions.state).toBe('empty')
    expect(payload.blockingAlerts).toEqual([])
  })
})

