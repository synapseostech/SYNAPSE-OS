import { useEffect, useState } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { Redirect } from 'expo-router'
import { SynapseLogo } from '@/components/SynapseLogo'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { colors } from '@/lib/theme'

export default function Index() {
  const { user, isLoading, token } = useAuth()
  const [pharmTarget, setPharmTarget] = useState<string | null>(null)

  const isPharmacy = user?.dashboardKind === 'pharmacy'
  const isPersonal = user?.dashboardKind === 'patient'
  const needsPasswordChange = Boolean(user?.mustChangePassword)

  useEffect(() => {
    let active = true
    async function check() {
      if (!user || !token || needsPasswordChange || !isPharmacy) return
      try {
        const data = await apiRequest<{ completed: boolean }>('/api/mobile/pharmacy/onboarding', { token })
        if (active) setPharmTarget(data.completed ? '/(main)/home' : '/onboarding')
      } catch {
        // Fail open to the app if onboarding status can't be read.
        if (active) setPharmTarget('/(main)/home')
      }
    }
    check()
    return () => {
      active = false
    }
  }, [user, token, isPharmacy, needsPasswordChange])

  if (isLoading) {
    return (
      <View style={styles.root}>
        <SynapseLogo size="lg" />
        <ActivityIndicator color={colors.primary} size="large" style={styles.spinner} />
      </View>
    )
  }

  if (!user) return <Redirect href="/(auth)/login" />
  if (needsPasswordChange) return <Redirect href="/change-password" />

  if (isPersonal) return <Redirect href="/(personal)/today" />

  if (isPharmacy) {
    if (!pharmTarget) {
      return (
        <View style={styles.root}>
          <SynapseLogo size="lg" />
          <ActivityIndicator color={colors.primary} size="large" style={styles.spinner} />
        </View>
      )
    }
    return <Redirect href={pharmTarget as never} />
  }

  return <Redirect href="/(main)/home" />
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.bg,
    gap: 24,
  },
  spinner: { marginTop: 8 },
})
