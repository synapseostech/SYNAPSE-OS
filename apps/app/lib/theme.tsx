/**
 * Synapse mobile design tokens — dark + light palettes.
 * Prefer `useTheme().colors` in components so Appearance updates apply.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Appearance, StatusBar as RNStatusBar, StyleSheet, useColorScheme } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { StatusBar } from 'expo-status-bar'

export type ThemeScheme = 'light' | 'dark'
export type ThemePreference = 'system' | ThemeScheme

const THEME_PREF_KEY = 'synapse.theme.preference.v1'

const darkPalette = {
  bg: '#07070A',
  bgSubtle: '#0E0E12',
  bgElevated: '#16161B',
  surface: '#16161B',
  surfaceHover: '#26262C',
  popover: '#26262C',
  text: '#ECECEF',
  textSecondary: '#A1A1AC',
  textMuted: '#C9C2B3',
  border: '#26262C',
  borderStrong: '#3A3A44',
  borderSubtle: '#1A1A22',
  input: '#3A3A44',
  primary: '#F97316',
  primaryHover: '#FB7E3C',
  primaryForeground: '#07070A',
  primarySoft: 'rgba(249, 115, 22, 0.12)',
  accent: '#FB7E3C',
  gold: '#E8B84B',
  goldSoft: 'rgba(232, 184, 75, 0.12)',
  teal: '#1FA6A6',
  tealSoft: 'rgba(31, 166, 166, 0.12)',
  success: '#3DD68C',
  successSoft: 'rgba(61, 214, 140, 0.12)',
  warning: '#FFB224',
  warningSoft: 'rgba(255, 178, 36, 0.12)',
  danger: '#F2555A',
  dangerSoft: 'rgba(242, 85, 90, 0.12)',
  info: '#4C9DFF',
  infoSoft: 'rgba(76, 157, 255, 0.12)',
  error: '#F2555A',
  errorBg: 'rgba(242, 85, 90, 0.08)',
  errorBorder: 'rgba(242, 85, 90, 0.28)',
  white: '#FFFFFF',
  codeBg: '#0E0E12',
  codeFg: '#D2D2D9',
  glowTeal: 'rgba(31, 166, 166, 0.10)',
  glowOrange: 'rgba(249, 115, 22, 0.04)',
} as const

const lightPalette = {
  bg: '#F7F6F3',
  bgSubtle: '#EFEEEA',
  bgElevated: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceHover: '#F0EFEC',
  popover: '#FFFFFF',
  text: '#14141A',
  textSecondary: '#5C5C68',
  textMuted: '#3E4A5C',
  border: '#E4E2DC',
  borderStrong: '#C9C6BE',
  borderSubtle: '#EDEBE6',
  input: '#D6D3CB',
  primary: '#EA6A0C',
  primaryHover: '#F97316',
  primaryForeground: '#FFFFFF',
  primarySoft: 'rgba(234, 106, 12, 0.12)',
  accent: '#F97316',
  gold: '#B8860B',
  goldSoft: 'rgba(184, 134, 11, 0.12)',
  teal: '#0F8A8A',
  tealSoft: 'rgba(15, 138, 138, 0.12)',
  success: '#1F9D5B',
  successSoft: 'rgba(31, 157, 91, 0.12)',
  warning: '#C47F00',
  warningSoft: 'rgba(196, 127, 0, 0.12)',
  danger: '#D64545',
  dangerSoft: 'rgba(214, 69, 69, 0.12)',
  info: '#2B7DE9',
  infoSoft: 'rgba(43, 125, 233, 0.12)',
  error: '#D64545',
  errorBg: 'rgba(214, 69, 69, 0.08)',
  errorBorder: 'rgba(214, 69, 69, 0.28)',
  white: '#FFFFFF',
  codeBg: '#F0EFEC',
  codeFg: '#2A2A32',
  glowTeal: 'rgba(15, 138, 138, 0.08)',
  glowOrange: 'rgba(234, 106, 12, 0.06)',
} as const

type PaletteKeys = keyof typeof darkPalette
export type ThemeColors = { [K in PaletteKeys]: string }

/** Default export kept for legacy StyleSheet imports (dark). Prefer useTheme(). */
export const colors: ThemeColors = { ...darkPalette }

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const

export const radii = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 24,
  full: 9999,
} as const

export const fonts = {
  display: 'BricolageGrotesque_700Bold',
  heading: 'BricolageGrotesque_600SemiBold',
  body: 'DMSans_400Regular',
  bodyMedium: 'DMSans_500Medium',
  bodyBold: 'DMSans_700Bold',
  mono: 'IBMPlexMono_500Medium',
} as const

export const typography = {
  display: { fontFamily: fonts.display, fontSize: 36, fontWeight: '600' as const, letterSpacing: -0.4, lineHeight: 43 },
  h1: { fontFamily: fonts.display, fontSize: 28, fontWeight: '600' as const, letterSpacing: -0.3, lineHeight: 34 },
  h2: { fontFamily: fonts.heading, fontSize: 22, fontWeight: '600' as const, letterSpacing: -0.2, lineHeight: 28 },
  h3: { fontFamily: fonts.heading, fontSize: 17, fontWeight: '600' as const, lineHeight: 24 },
  h4: { fontFamily: fonts.heading, fontSize: 15, fontWeight: '600' as const, lineHeight: 21 },
  bodyLg: { fontFamily: fonts.body, fontSize: 18, fontWeight: '400' as const, lineHeight: 29 },
  body: { fontFamily: fonts.body, fontSize: 16, fontWeight: '400' as const, lineHeight: 26 },
  bodySm: { fontFamily: fonts.body, fontSize: 14, fontWeight: '400' as const, lineHeight: 21 },
  caption: { fontFamily: fonts.bodyMedium, fontSize: 12, fontWeight: '500' as const, letterSpacing: 0.12, lineHeight: 17 },
  label: {
    fontFamily: fonts.bodyMedium,
    fontSize: 11,
    fontWeight: '600' as const,
    letterSpacing: 1.1,
    textTransform: 'uppercase' as const,
  },
  mono: { fontFamily: fonts.mono, fontSize: 14, fontWeight: '500' as const, lineHeight: 21 },
  stat: { fontFamily: fonts.display, fontSize: 24, fontWeight: '600' as const, letterSpacing: -0.5, lineHeight: 29 },
  hero: { fontFamily: fonts.display, fontSize: 28, fontWeight: '600' as const, letterSpacing: -0.3 },
  title: { fontFamily: fonts.heading, fontSize: 22, fontWeight: '600' as const, letterSpacing: -0.2 },
  heading: { fontFamily: fonts.heading, fontSize: 17, fontWeight: '600' as const },
  bodyMedium: { fontFamily: fonts.bodyMedium, fontSize: 15, fontWeight: '500' as const },
} as const

export const tabBarHeight = 64

/** Minimum comfortable touch target (Android guidance is 48dp). */
export const touchTarget = 48

/** Soft shadows; Android uses elevation, iOS/web the shadow props. */
export function elevation(level: 0 | 1 | 2 | 3, scheme: ThemeScheme = 'dark') {
  if (level === 0) return {}
  const opacity = scheme === 'dark' ? 0.45 : 0.08 + level * 0.03
  return {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: level * 2 },
    shadowOpacity: opacity,
    shadowRadius: level * 6,
    elevation: level * 2,
  }
}

export function toneColors(c: ThemeColors) {
  return {
    primary: c.primary,
    gold: c.gold,
    green: c.success,
    red: c.danger,
    muted: c.textMuted,
    teal: c.teal,
    warning: c.warning,
    amber: c.warning,
    info: c.info,
  } as const
}

/**
 * Tone map that follows the active scheme. The provider updates it in place
 * whenever the scheme changes, so screens that read it while rendering get
 * the light or dark tone. Prefer toneColors(useTheme().colors) in new code.
 */
export const TONE_COLORS: { -readonly [K in keyof ReturnType<typeof toneColors>]: string } = toneColors(darkPalette)
export type StatTone = keyof typeof TONE_COLORS

type ThemeContextValue = {
  preference: ThemePreference
  scheme: ThemeScheme
  colors: ThemeColors
  setPreference: (pref: ThemePreference) => void
  isDark: boolean
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function resolveScheme(preference: ThemePreference, system: ThemeScheme | null | undefined): ThemeScheme {
  if (preference === 'light' || preference === 'dark') return preference
  return system === 'light' ? 'light' : 'dark'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme()
  const [preference, setPreferenceState] = useState<ThemePreference>('system')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const stored = await AsyncStorage.getItem(THEME_PREF_KEY)
        if (!cancelled && (stored === 'system' || stored === 'light' || stored === 'dark')) {
          setPreferenceState(stored)
        }
      } catch {
        /* ignore */
      } finally {
        if (!cancelled) setReady(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const setPreference = useCallback((pref: ThemePreference) => {
    setPreferenceState(pref)
    void AsyncStorage.setItem(THEME_PREF_KEY, pref)
  }, [])

  const scheme = resolveScheme(preference, system)
  const palette = scheme === 'light' ? lightPalette : darkPalette
  // Mutable legacy exports follow the scheme before children render.
  if (colors.bg !== palette.bg) {
    Object.assign(colors, palette)
    Object.assign(TONE_COLORS, toneColors(palette))
  }

  // Keep legacy `colors` export roughly in sync for modules that still read it at render time.
  useEffect(() => {
    Object.assign(colors, palette)
    RNStatusBar.setBarStyle(scheme === 'dark' ? 'light-content' : 'dark-content', true)
  }, [scheme, palette])

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      scheme,
      colors: palette,
      setPreference,
      isDark: scheme === 'dark',
    }),
    [preference, scheme, palette, setPreference],
  )

  if (!ready) {
    return (
      <ThemeContext.Provider value={value}>
        <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
        {children}
      </ThemeContext.Provider>
    )
  }

  return (
    <ThemeContext.Provider value={value}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) {
    const system = Appearance.getColorScheme() === 'light' ? 'light' : 'dark'
    const palette = system === 'light' ? lightPalette : darkPalette
    return {
      preference: 'system',
      scheme: system,
      colors: palette,
      setPreference: () => {},
      isDark: system === 'dark',
    }
  }
  return ctx
}

/**
 * Theme-aware StyleSheet. Styles built at import time freeze the palette that
 * was active then, which is why light mode used to show dark cards. Use:
 *
 *   const useStyles = makeStyles((colors) => ({ root: { backgroundColor: colors.bg } }))
 *   function Screen() { const styles = useStyles() ... }
 *
 * Each scheme's sheet is built once and cached.
 */
type StyleInput = Parameters<typeof StyleSheet.create>[0]

export function makeStyles<T extends StyleInput>(
  factory: (c: ThemeColors, scheme: ThemeScheme) => T & StyleInput,
): () => Readonly<T> {
  const cache: Partial<Record<ThemeScheme, Readonly<T>>> = {}
  return function useStyles(): Readonly<T> {
    const { colors: c, scheme } = useTheme()
    let sheet = cache[scheme]
    if (!sheet) {
      sheet = StyleSheet.create(factory(c, scheme)) as Readonly<T>
      cache[scheme] = sheet
    }
    return sheet as Readonly<T>
  }
}
