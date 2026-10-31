import { useFonts, DMSans_400Regular, DMSans_500Medium, DMSans_700Bold } from '@expo-google-fonts/dm-sans'
import { BricolageGrotesque_600SemiBold, BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque'
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono'
import { Stack, router } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { Linking, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { LockScreen } from '@/components/LockScreen'
import { AuthProvider, useAuth } from '@/lib/auth'
import { PharmacySyncHost } from '@/lib/pharmacy-sync'
import { usePushDeepLinks } from '@/lib/push-deeplinks'
import { ThemeProvider, useTheme } from '@/lib/theme'

SplashScreen.preventAutoHideAsync().catch(() => {})

function pathFromResetUrl(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url.replace('synapse://', 'https://synapse.app/'))
    if (parsed.pathname.replace(/^\//, '') !== 'reset-password') return null
    const token = parsed.searchParams.get('token')
    return token ? `/reset-password?token=${encodeURIComponent(token)}` : '/reset-password'
  } catch {
    return null
  }
}

function usePasswordResetDeepLinks() {
  useEffect(() => {
    const handle = (url: string | null | undefined) => {
      const path = pathFromResetUrl(url)
      if (!path) return
      try {
        router.push(path as never)
      } catch {
        /* ignore */
      }
    }
    Linking.getInitialURL().then(handle).catch(() => {})
    const sub = Linking.addEventListener('url', (event) => handle(event.url))
    return () => sub.remove()
  }, [])
}

function RootNavigator() {
  const { isLocked, token } = useAuth()
  const { colors } = useTheme()
  usePushDeepLinks(Boolean(token) && !isLocked)
  usePasswordResetDeepLinks()

  if (isLocked) return <LockScreen />

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
        animation: 'fade',
      }}
    />
  )
}

function ThemedShell({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme()
  return (
    <GestureHandlerRootView>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {children}
      </View>
    </GestureHandlerRootView>
  )
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    DMSans_400Regular,
    DMSans_500Medium,
    DMSans_700Bold,
    BricolageGrotesque_600SemiBold,
    BricolageGrotesque_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
  })
  const [splashReleased, setSplashReleased] = useState(false)

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync().catch(() => {})
      setSplashReleased(true)
    }
  }, [fontsLoaded, fontError])

  useEffect(() => {
    const timer = setTimeout(() => {
      SplashScreen.hideAsync().catch(() => {})
      setSplashReleased(true)
    }, 6_000)
    return () => clearTimeout(timer)
  }, [])

  if (!splashReleased && !fontsLoaded && !fontError) return null

  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ThemedShell>
          <AuthProvider>
            <PharmacySyncHost>
              <RootNavigator />
            </PharmacySyncHost>
          </AuthProvider>
        </ThemedShell>
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
