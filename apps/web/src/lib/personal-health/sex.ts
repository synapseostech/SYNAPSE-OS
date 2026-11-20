/**
 * Sign-up sex and gender, mapped onto what the database accepts.
 *
 * patient_profiles.sex is constrained to male | female | other and drives
 * clinical defaults, so it holds sex recorded at birth: intersex is stored as
 * `other`, and "prefer not to say" as null. Gender identity is separate,
 * optional, and stored on profiles.gender as the person wrote it. Before this,
 * the app sent `undisclosed` straight into patient_profiles.sex, which the
 * check constraint refused and sign-up failed.
 */
export type ClinicalSex = 'male' | 'female' | 'other'

const SEX_AT_BIRTH: Record<string, ClinicalSex | null> = {
  female: 'female',
  male: 'male',
  intersex: 'other',
  other: 'other',
  undisclosed: null,
  prefer_not_to_say: null,
}

export function normaliseSignupSex(body: Record<string, unknown>): {
  clinicalSex: ClinicalSex | null
  genderIdentity: string | null
} {
  const rawSex = typeof body.sex === 'string' ? body.sex : typeof body.gender === 'string' ? body.gender : ''
  const key = rawSex.trim().toLowerCase()
  const clinicalSex = Object.hasOwn(SEX_AT_BIRTH, key) ? (SEX_AT_BIRTH[key] ?? null) : null

  const rawIdentity = typeof body.gender_identity === 'string' ? body.gender_identity.trim() : ''
  const genderIdentity = rawIdentity ? rawIdentity.slice(0, 60) : null
  return { clinicalSex, genderIdentity }
}
