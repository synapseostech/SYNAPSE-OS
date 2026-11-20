import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRepeatLabRelease } from './lab-release-idempotency'

describe('isRepeatLabRelease', () => {
  it('treats an already RELEASED order as a repeat release', () => {
    expect(isRepeatLabRelease('RELEASED')).toBe(true)
    expect(isRepeatLabRelease('released')).toBe(true)
  })
  it.each(['VERIFIED', 'RESULT_ENTERED', 'AMENDED', '', null, undefined])('first release from %s is not a repeat', (s) => {
    expect(isRepeatLabRelease(s as string | null | undefined)).toBe(false)
  })
  it('the lab engine returns before any write or publish on a repeat release', () => {
    const src = readFileSync(join(__dirname, 'lab', 'engine.ts'), 'utf8')
    expect(src).toMatch(/if \(action !== 'verify' && isRepeatLabRelease\(order\.status\)\) return idle\(\)/)
  })
})
