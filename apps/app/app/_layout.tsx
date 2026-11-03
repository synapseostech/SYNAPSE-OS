import { useFonts, DMSans_400Regular, DMSans_500Medium, DMSans_700Bold } from '@expo-google-fonts/dm-sans'
import { BricolageGrotesque_600SemiBold, BricolageGrotesque_700Bold } from '@expo-google-fonts/bricolage-grotesque'
import { IBMPlexMono_400Regular, IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono'
import { Stack, router, type ErrorBoundaryProps } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import { useEffect, useState } from 'react'
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native'
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

/**
 * Without this, a render error anywhere in the route tree takes the whole
 * process down and the app looks dead. Expo Router renders this instead and
 * keeps the rest of the app (and the offline SQLite data) intact.
 * Deliberately self-contained: no theme, font or auth dependency, so it can
 * still render when one of those is what failed.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={crashStyles.root}>
      <Text style={crashStyles.title}>Something went wrong</Text>
      <Text style={crashStyles.body}>
        This screen could not be shown. Anything already saved on this device is still there.
      </Text>
      {error?.message ? (
        <Text style={crashStyles.detail} numberOfLines={5}>
          {error.message}
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void retry()
        }}
        style={({ pressed }) => [crashStyles.button, pressed && crashStyles.buttonPressed]}
      >
        <Text style={crashStyles.buttonText}>Try again</Text>
      </Pressable>
    </View>
  )
}

const crashStyles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
    backgroundColor: '#07070A',
  },
  title: { color: '#ECECEF', fontSize: 22, fontWeight: '600' },
  body: { color: '#A1A1AC', fontSize: 15, lineHeight: 22, marginTop: 10 },
  detail: {
    color: '#C9C2B3',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 18,
  },
  button: {
    alignSelf: 'flex-start',
    marginTop: 26,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    backgroundColor: '#F97316',
  },
  buttonPressed: { backgroundColor: '#FB7E3C' },
  buttonText: { color: '#07070A', fontSize: 15, fontWeight: '600' },
})
