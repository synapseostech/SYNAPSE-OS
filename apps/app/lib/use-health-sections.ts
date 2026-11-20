import { useCallback, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { useAuth } from './auth'
import {
  readSexAtBirth,
  resolveHealthSections,
  type HealthSections,
  type SexAtBirth,
} from './health-sections'
import {
  getHealthPreferences,
  getHealthProfile,
  saveHealthPreferences,
  type HealthPreferences,
} from './personal-store'
import { fetchSignupHealthFacts } from './wearables-api'

export type SectionsState = {
  loaded: boolean
  sex: SexAtBirth | null
  gender: string | null
  dateOfBirth: string | null
  sections: HealthSections
  pregnancyDueDate: string | null
}

const INITIAL: SectionsState = {
  loaded: false,
  sex: null,
  gender: null,
  dateOfBirth: null,
  sections: resolveHealthSections(null, null),
  pregnancyDueDate: null,
}

/**
 * Sex, gender and section choices for the signed-in person. The first time My
 * Health opens on a phone, what they gave at sign-up is copied down once, so a
 * new account already shows the right sections without asking again.
 */
export function useHealthSections() {
  const { user, token } = useAuth()
  const userId = user?.id
  const [state, setState] = useState<SectionsState>(INITIAL)
  const [prefs, setPrefs] = useState<HealthPreferences | null>(null)

  useFocusEffect(
    useCallback(() => {
      let active = true
      if (!userId) return
      ;(async () => {
        let current = await getHealthPreferences(userId).catch(() => null)
        const profile = await getHealthProfile(userId).catch(() => null)
        if (current && !current.seededFromSignup && !current.sexAtBirth && token) {
          const facts = await fetchSignupHealthFacts(token).catch(() => null)
          if (facts) {
            current = {
              ...current,
              sexAtBirth: readSexAtBirth(facts.sex),
              gender: current.gender ?? facts.gender,
              seededFromSignup: true,
            }
            await saveHealthPreferences(userId, current).catch(() => {})
          }
        }
        if (!active || !current) return
        const sex = readSexAtBirth(current.sexAtBirth) ?? readSexAtBirth(profile?.sex)
        setPrefs(current)
        setState({
          loaded: true,
          sex,
          gender: current.gender,
          dateOfBirth: profile?.dateOfBirth ?? null,
          sections: resolveHealthSections(sex, current.sections as Partial<HealthSections> | null),
          pregnancyDueDate: current.pregnancyDueDate,
        })
      })()
      return () => {
        active = false
      }
    }, [userId, token]),
  )

  const save = useCallback(
    async (patch: { sex?: SexAtBirth | null; gender?: string | null; sections?: Partial<HealthSections>; pregnancyDueDate?: string | null }) => {
      if (!userId) return
      const base: HealthPreferences = prefs ?? {
        sexAtBirth: null,
        gender: null,
        sections: null,
        pregnancyDueDate: null,
        seededFromSignup: true,
      }
      const next: HealthPreferences = {
        ...base,
        sexAtBirth: patch.sex !== undefined ? patch.sex : base.sexAtBirth,
        gender: patch.gender !== undefined ? patch.gender : base.gender,
        sections: patch.sections ? { ...(base.sections ?? {}), ...patch.sections } : base.sections,
        pregnancyDueDate: patch.pregnancyDueDate !== undefined ? patch.pregnancyDueDate : base.pregnancyDueDate,
        seededFromSignup: true,
      }
      await saveHealthPreferences(userId, next)
      setPrefs(next)
      const sex = readSexAtBirth(next.sexAtBirth)
      setState((prev) => ({
        ...prev,
        sex,
        gender: next.gender,
        sections: resolveHealthSections(sex, next.sections as Partial<HealthSections> | null),
        pregnancyDueDate: next.pregnancyDueDate,
      }))
    },
    [userId, prefs],
  )

  return { ...state, save }
}
