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
 * Both are checked on launch and when the app returns to the foreground, at
 * most every few hours. A failed check is silent: the app keeps working on the
 * version it has, and the next check tries again.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Updates from 'expo-updates'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, Linking } from 'react-native'
import { apiBaseUrl } from '@/lib/api'
import { type AppRelease, type ApkUpdate, decideApkUpdate, shouldCheckForUpdates } from '@/lib/app-update'

const DISMISSED_KEY = 'synapse.update.dismissed-version'
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
  /** Hides an optional APK prompt until a newer version ships. */
  dismissApk: () => void
  restartNow: () => void
}

export function useAppUpdates(): AppUpdates {
  const [apk, setApk] = useState<ApkUpdate>({ kind: 'none' })
  const [restartReady, setRestartReady] = useState(false)
  const lastChecked = useRef<number | null>(null)
  const running = useRef(false)

  const check = useCallback(async () => {
    const now = Date.now()
    if (running.current || !shouldCheckForUpdates(lastChecked.current, now)) return
    running.current = true
    lastChecked.current = now
    try {
      const [release, dismissed, ready] = await Promise.all([
        fetchRelease(),
        AsyncStorage.getItem(DISMISSED_KEY).catch(() => null),
        fetchOverTheAir(),
      ])
      // Under the appVersion policy the runtime version is the native app
      // version, which is what an APK release replaces.
      setApk(decideApkUpdate(Updates.runtimeVersion, release, dismissed))
      if (ready) setRestartReady(true)
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
    Linking.openURL(apk.apkUrl).catch(() => {})
  }, [apk])

  const dismissApk = useCallback(() => {
    if (apk.kind !== 'optional') return
    AsyncStorage.setItem(DISMISSED_KEY, apk.version).catch(() => {})
    setApk({ kind: 'none' })
  }, [apk])

  const restartNow = useCallback(() => {
    Updates.reloadAsync().catch(() => {})
  }, [])

  return { apk, restartReady, installApk, dismissApk, restartNow }
}
