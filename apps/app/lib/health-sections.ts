/**
 * Which parts of My Health a person sees, and the sex-specific checks offered.
 *
 * Sex recorded at birth only sets defaults for sections that are clinically
 * sex-specific (cycle and pregnancy; prostate and testicular checks). Gender
 * identity is separate and never hides anything. Every section can be turned on
 * or off by the person, so a trans man can keep cycle tracking and an intersex
 * person can choose what applies. "Prefer not to say" shows the general
 * sections and offers the rest as opt-ins.
 *
 * Pure: no React Native imports, so node:test covers it.
 */

export type SexAtBirth = 'female' | 'male' | 'intersex' | 'undisclosed'

export const SEX_AT_BIRTH_OPTIONS: ReadonlyArray<{ value: SexAtBirth; label: string }> = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'intersex', label: 'Intersex' },
  { value: 'undisclosed', label: 'Prefer not to say' },
]

export type GenderIdentity = 'woman' | 'man' | 'non_binary' | 'self_describe' | 'undisclosed'

export const GENDER_OPTIONS: ReadonlyArray<{ value: GenderIdentity; label: string }> = [
  { value: 'woman', label: 'Woman' },
  { value: 'man', label: 'Man' },
  { value: 'non_binary', label: 'Non-binary' },
  { value: 'self_describe', label: 'Let me describe' },
  { value: 'undisclosed', label: 'Prefer not to say' },
]

export type HealthSections = {
  cycle: boolean
  pregnancy: boolean
  mensHealth: boolean
}

export function isSexAtBirth(value: unknown): value is SexAtBirth {
  return value === 'female' || value === 'male' || value === 'intersex' || value === 'undisclosed'
}

/** Older builds stored "other" or "Rather not say"; read them as the nearest option. */
export function readSexAtBirth(value: unknown): SexAtBirth | null {
  if (isSexAtBirth(value)) return value
  if (value === 'other') return 'intersex'
  return null
}

export function defaultHealthSections(sex: SexAtBirth | null): HealthSections {
  return {
    cycle: sex === 'female',
    pregnancy: sex === 'female',
    mensHealth: sex === 'male',
  }
}

/** Saved choices win; anything not chosen yet falls back to the sex default. */
export function resolveHealthSections(
  sex: SexAtBirth | null,
  saved: Partial<HealthSections> | null | undefined,
): HealthSections {
  const defaults = defaultHealthSections(sex)
  return {
    cycle: typeof saved?.cycle === 'boolean' ? saved.cycle : defaults.cycle,
    pregnancy: typeof saved?.pregnancy === 'boolean' ? saved.pregnancy : defaults.pregnancy,
    mensHealth: typeof saved?.mensHealth === 'boolean' ? saved.mensHealth : defaults.mensHealth,
  }
}

/** What the sign-up endpoint stores; mirrors apps/web/src/lib/personal-health/sex.ts. */
export function signupSexPayload(sex: SexAtBirth | null, gender: GenderIdentity | null, selfDescribed: string) {
  const genderIdentity =
    gender === 'self_describe'
      ? selfDescribed.trim().slice(0, 60)
      : gender && gender !== 'undisclosed'
        ? (GENDER_OPTIONS.find((option) => option.value === gender)?.label ?? '')
        : ''
  return { sex: sex ?? 'undisclosed', gender_identity: genderIdentity }
}

export function ageOn(dateOfBirth: string | null | undefined, now: Date = new Date()): number | null {
  if (!dateOfBirth || !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) return null
  const [y, m, d] = dateOfBirth.split('-').map(Number)
  let age = now.getFullYear() - y
  if (now.getMonth() + 1 < m || (now.getMonth() + 1 === m && now.getDate() < d)) age -= 1
  return age >= 0 && age < 130 ? age : null
}

export type HealthCheck = {
  id: string
  section: keyof HealthSections | 'general'
  title: string
  detail: string
  /** Suggested reminder cadence, used to prefill a reminder. */
  every: 'month' | 'year' | 'three_years'
}

/**
 * Checks to talk through with a clinician. Wording is advisory, not a diagnosis,
 * and follows common guidance (WHO cervical screening from 30, prostate
 * discussion from 50 or 45 with risk factors).
 */
export function healthChecksFor(sections: HealthSections, age: number | null): HealthCheck[] {
  const checks: HealthCheck[] = [
    {
      id: 'blood-pressure',
      section: 'general',
      title: 'Blood pressure check',
      detail: 'At least once a year from 18, more often if it has been high.',
      every: 'year',
    },
  ]
  if (age === null || age >= 35) {
    checks.push({
      id: 'blood-sugar',
      section: 'general',
      title: 'Blood sugar (diabetes) test',
      detail: 'Every 3 years from 35, or sooner if you are overweight or it runs in the family.',
      every: 'three_years',
    })
  }
  if (sections.cycle || sections.pregnancy) {
    if (age === null || age >= 25) {
      checks.push({
        id: 'cervical-screening',
        section: 'cycle',
        title: 'Cervical screening',
        detail: 'HPV or smear test, usually every 3 to 5 years. Ask your clinic which applies to you.',
        every: 'three_years',
      })
    }
    checks.push({
      id: 'breast-check',
      section: 'cycle',
      title: 'Breast self-check',
      detail: 'Once a month, a few days after your period. See a clinician about any new lump.',
      every: 'month',
    })
  }
  if (sections.mensHealth) {
    checks.push({
      id: 'testicular-check',
      section: 'mensHealth',
      title: 'Testicular self-check',
      detail: 'Once a month, most important between 15 and 49. See a clinician about any lump or swelling.',
      every: 'month',
    })
    if (age === null || age >= 45) {
      checks.push({
        id: 'prostate-talk',
        section: 'mensHealth',
        title: 'Prostate check (PSA) conversation',
        detail:
          'Talk it through with a clinician from 50, or from 45 if a father or brother had prostate cancer. Also go sooner if passing urine changes.',
        every: 'year',
      })
    }
  }
  return checks
}

/** Weeks and days of pregnancy from a due date (40 weeks after the last period). */
export function pregnancyProgress(
  dueDate: string | null | undefined,
  now: Date = new Date(),
): { weeks: number; days: number; trimester: 1 | 2 | 3; daysToGo: number } | null {
  if (!dueDate || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null
  const due = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const daysToGo = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  const elapsed = 280 - daysToGo
  if (elapsed < 0 || elapsed > 300) return null
  const weeks = Math.floor(elapsed / 7)
  return {
    weeks,
    days: elapsed % 7,
    trimester: weeks < 13 ? 1 : weeks < 27 ? 2 : 3,
    daysToGo: Math.max(0, daysToGo),
  }
}
