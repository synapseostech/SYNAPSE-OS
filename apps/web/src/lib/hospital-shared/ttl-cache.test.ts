import { describe, expect, it } from 'vitest'
import { TtlCache } from './ttl-cache'

describe('TtlCache', () => {
  it('returns a value until it expires', () => {
    let t = 1000
    const cache = new TtlCache<boolean>(50, 10, () => t)
    cache.set('k', true)
    expect(cache.get('k')).toBe(true)
    t += 49
    expect(cache.get('k')).toBe(true)
    t += 1
    expect(cache.get('k')).toBeUndefined()
  })

  it('evicts the oldest entry when full', () => {
    const cache = new TtlCache<number>(1000, 2)
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBe(2)
    expect(cache.get('c')).toBe(3)
  })
})
