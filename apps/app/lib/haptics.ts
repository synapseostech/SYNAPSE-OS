/**
 * Haptic feedback for key actions (sale complete, item added, errors).
 *
 * expo-haptics is a native module. An over-the-air update can reach an APK
 * built before it was added, so it is loaded optionally and every call is a
 * silent no-op when the module is missing or the device has no vibrator.
 */
type HapticsModule = typeof import('expo-haptics')

let cached: HapticsModule | null | undefined

function haptics(): HapticsModule | null {
  if (cached !== undefined) return cached
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cached = require('expo-haptics') as HapticsModule
  } catch {
    cached = null
  }
  return cached
}

function run(fn: (h: HapticsModule) => Promise<void>) {
  const h = haptics()
  if (!h) return
  try {
    fn(h).catch(() => {})
  } catch {
    /* module present but native side missing */
  }
}

/** Light tap: adding to cart, toggling a chip, opening a quick action. */
export function tapHaptic() {
  run((h) => h.impactAsync(h.ImpactFeedbackStyle.Light))
}

/** Selection change in a picker or segmented control. */
export function selectionHaptic() {
  run((h) => h.selectionAsync())
}

/** A job finished: sale completed, stock received, photo saved. */
export function successHaptic() {
  run((h) => h.notificationAsync(h.NotificationFeedbackType.Success))
}

export function warningHaptic() {
  run((h) => h.notificationAsync(h.NotificationFeedbackType.Warning))
}

export function errorHaptic() {
  run((h) => h.notificationAsync(h.NotificationFeedbackType.Error))
}
