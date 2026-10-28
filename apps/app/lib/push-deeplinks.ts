import { useEffect } from 'react'
import * as Notifications from 'expo-notifications'
import { router } from 'expo-router'

/** Map push `data.url` / `data.target` (e.g. app:/queue) → expo-router path. */
function pathFromPushTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  let value = raw.trim()
  if (value.startsWith('app:')) value = value.slice(4)
  if (!value.startsWith('/')) value = `/${value}`

  const allowed = new Set([
    '/home',
    '/queue',
    '/records',
    '/appointments',
    '/stock',
    '/lab',
    '/claims',
    '/patients',
    '/meds',
    '/profile',
    '/personal/reminders',
  ])
  const base = value.split('?')[0]
  if (!allowed.has(base)) return '/home'
  return value
}

function navigateToTarget(data: Record<string, unknown> | undefined) {
  if (!data) return
  const target = pathFromPushTarget(data.url ?? data.target)
  if (!target) return
  // Consumer screens live under (personal); the rest are (main) tabs.
  if (target.startsWith('/personal/')) {
    try {
      router.push(`/(personal)${target.slice('/personal'.length)}` as never)
    } catch {
      router.push('/(personal)/today' as never)
    }
    return
  }
  const href = `/(main)${target}` as const
  try {
    router.push(href)
  } catch {
    router.push('/(main)/home')
  }
}

/**
 * Handles notification taps (cold + warm start) for deep links.
 */
export function usePushDeepLinks(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return

    let cancelled = false

    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (cancelled || !response) return
        navigateToTarget(response.notification.request.content.data as Record<string, unknown>)
      })
      .catch(() => {})

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      navigateToTarget(response.notification.request.content.data as Record<string, unknown>)
    })

    return () => {
      cancelled = true
      sub.remove()
    }
  }, [enabled])
}
