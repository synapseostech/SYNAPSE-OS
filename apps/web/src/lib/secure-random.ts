/**
 * Unbiased random index in [0, n) from the Web Crypto CSPRNG (rejection
 * sampling, no modulo bias). Used even for cosmetic choices so that no
 * Math.random() value can ever flow into identifiers or security-relevant
 * state (CodeQL js/insecure-randomness).
 */
export function secureRandomIndex(n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > 0x80000000) throw new RangeError("n must be an integer in 1..2^31")
  if (n === 1) return 0
  // Mask to the next power of two and reject out-of-range draws: uniform, and
  // no division/modulo on the random value (CodeQL js/biased-cryptographic-random).
  let mask = n - 1
  mask |= mask >>> 1
  mask |= mask >>> 2
  mask |= mask >>> 4
  mask |= mask >>> 8
  mask |= mask >>> 16
  const buf = new Uint32Array(1)
  for (;;) {
    globalThis.crypto.getRandomValues(buf)
    const v = (buf[0]! & mask) >>> 0
    if (v < n) return v
  }
}

export function secureRandomPick<T>(items: readonly T[]): T | undefined {
  return items.length ? items[secureRandomIndex(items.length)] : undefined
}
