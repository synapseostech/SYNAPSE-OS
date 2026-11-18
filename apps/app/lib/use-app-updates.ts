/**
 * Keeps the installed app current without a reinstall where possible.
 *
 * Two kinds of release reach a device:
 *  - An over-the-air update (expo-updates): new screens and logic for the
 *    native build already installed. It downloads in the background and is
 *    applied when the user taps "Restart", so nothing is reinstalled.
 *  - A new APK: needed when a release changes native code. The server
 *    announces it at /api/mobile/app-version; the user taps the prompt, the
 *    APK downloads, and Android's installer finishes the update over the
 *    existing app, keeping its data.
 *
 * The server is asked on launch and when the app returns to the foreground,
 * at most every few hours. The APK decision itself is made again on every
 * launch and resume from the last answer, which is kept on the device: so a
 * prompt dismissed with "Not now" comes back a day later, and a required
 * update covers the app even when it starts offline. A failed check is
 * silent: the app keeps working on the version it has, and the next check
 * tries again.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Updates from 'expo-updates'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking } from 'react-native'
import { apiBaseUrl } from '@/lib/api'
import {
  type AppRelease,
  type ApkUpdate,
  decideApkUpdate,
  parseDismissal,
  serialiseDismissal,
  shouldCheckForUpdates,
} from '@/lib/app-update'

const DISMISSED_KEY = 'synapse.update.dismissed-version'
const RELEASE_KEY = 'synapse.update.last-release'
const CHECK_TIMEOUT_MS = 10_000

async function fetchRelease(): Promise<AppRelease | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const response = await fetch(`${apiBaseUrl()}/api/mobile/app-version`, { signal: controller.signal })
    if (!response.ok) return null
    return (await response.json()) as AppRelease
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function cachedRelease(): Promise<AppRelease | null> {
  try {
    const raw = await AsyncStorage.getItem(RELEASE_KEY)
    return raw ? (JSON.parse(raw) as AppRelease) : null
  } catch {
    return null
  }
}

/** Fetches an over-the-air update in the background; true when one is ready. */
async function fetchOverTheAir(): Promise<boolean> {
  // Development builds and Expo Go have no update channel to ask.
  if (!Updates.isEnabled || __DEV__) return false
  try {
    const check = await Updates.checkForUpdateAsync()
    if (!check.isAvailable) return false
    const fetched = await Updates.fetchUpdateAsync()
    return fetched.isNew
  } catch {
    return false
  }
}

export type AppUpdates = {
  apk: ApkUpdate
  /** An over-the-air update is downloaded and waits for a restart. */
  restartReady: boolean
  /** Opens the APK download; Android's installer takes it from there. */
  installApk: () => void
  /** Hides an optional APK prompt for a day, or until a newer version ships. */
  dismissApk: () => void
  restartNow: () => void
}

export function useAppUpdates(): AppUpdates {
  const [apk, setApk] = useState<ApkUpdate>({ kind: 'none' })
  const [restartReady, setRestartReady] = useState(false)
  const lastChecked = useRef<number | null>(null)
  const release = useRef<AppRelease | null | undefined>(undefined)
  const running = useRef(false)

  const check = useCallback(async () => {
    if (running.current) return
    running.current = true
    try {
      if (release.current === undefined) release.current = await cachedRelease()
      const now = Date.now()
      if (shouldCheckForUpdates(lastChecked.current, now)) {
        lastChecked.current = now
        const [fresh, ready] = await Promise.all([fetchRelease(), fetchOverTheAir()])
        if (fresh) {
          release.current = fresh
          AsyncStorage.setItem(RELEASE_KEY, JSON.stringify(fresh)).catch(() => {})
        }
        if (ready) setRestartReady(true)
      }
      const dismissal = parseDismissal(await AsyncStorage.getItem(DISMISSED_KEY).catch(() => null))
      // Under the appVersion policy the runtime version is the native app
      // version, which is what an APK release replaces.
      setApk(decideApkUpdate(Updates.runtimeVersion, release.current, dismissal, Date.now()))
    } finally {
      running.current = false
    }
  }, [])

  useEffect(() => {
    void check()
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void check()
    })
    return () => subscription.remove()
  }, [check])

  const installApk = useCallback(() => {
    if (apk.kind === 'none') return
    // The link is the .apk file itself (decideApkUpdate refuses anything
    // else), so this starts the download; tapping the finished download opens
    // Android's installer over the existing app.
    Linking.openURL(apk.apkUrl).catch(() => {})
  }, [apk])

  const dismissApk = useCallback(() => {
    if (apk.kind !== 'optional') return
    AsyncStorage.setItem(DISMISSED_KEY, serialiseDismissal({ version: apk.version, at: Date.now() })).catch(() => {})
    setApk({ kind: 'none' })
  }, [apk])

  const restartNow = useCallback(() => {
    Updates.reloadAsync().catch(() => {})
  }, [])

  return { apk, restartReady, installApk, dismissApk, restartNow }
}
