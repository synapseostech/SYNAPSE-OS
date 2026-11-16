"use client"

import { useEffect, useRef, useCallback } from "react"

const IDLE_MS = 30 * 60 * 1000
const WARN_MS = 25 * 60 * 1000
const ACTIVITY_EVENTS = ["mousemove", "keydown", "mousedown", "touchstart", "scroll"] as const

/**
 * Long-running work the operator started and is waiting on — a Tally cut-over
 * apply runs for longer than the idle window at customer scale — makes no
 * mouse or keyboard events. Signing out in the middle of it stopped the import
 * with a 401. While a hold is open the idle timer restarts instead of signing
 * out; once the last hold is released, the normal idle rule applies again.
 */
let activeHolds = 0

export function holdIdleLogout(): () => void {
  activeHolds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    activeHolds = Math.max(0, activeHolds - 1)
  }
}

export function idleLogoutHeld(): boolean {
  return activeHolds > 0
}

interface UseIdleLogoutOptions {
  onWarn: (secondsLeft: number) => void
  onLogout: () => void
  onReset: () => void
}

export function useIdleLogout({ onWarn, onLogout, onReset }: UseIdleLogoutOptions) {
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const warnedRef = useRef(false)

  const clearTimers = useCallback(() => {
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current)
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current)
    if (countdownRef.current) clearInterval(countdownRef.current)
  }, [])

  const resetTimer: () => void = useCallback(() => {
    clearTimers()
    if (warnedRef.current) {
      warnedRef.current = false
      onReset()
    }

    warnTimerRef.current = setTimeout(() => {
      if (idleLogoutHeld()) {
        resetTimer()
        return
      }
      warnedRef.current = true
      let secondsLeft = (IDLE_MS - WARN_MS) / 1000
      onWarn(secondsLeft)
      countdownRef.current = setInterval(() => {
        secondsLeft -= 1
        if (secondsLeft <= 0) {
          if (countdownRef.current) clearInterval(countdownRef.current)
          return
        }
        onWarn(secondsLeft)
      }, 1000)
    }, WARN_MS)

    logoutTimerRef.current = setTimeout(() => {
      if (idleLogoutHeld()) {
        resetTimer()
        return
      }
      clearTimers()
      onLogout()
    }, IDLE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resetTimer re-arms itself
  }, [clearTimers, onWarn, onLogout, onReset])

  useEffect(() => {
    resetTimer()
    const handleActivity = () => resetTimer()
    for (const event of ACTIVITY_EVENTS) {
      document.addEventListener(event, handleActivity, { passive: true })
    }
    return () => {
      clearTimers()
      for (const event of ACTIVITY_EVENTS) {
        document.removeEventListener(event, handleActivity)
      }
    }
  }, [resetTimer, clearTimers])
}
