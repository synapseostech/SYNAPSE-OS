import { describe, expect, it } from "vitest"
import { formatSynapseId, isValidSynapseId } from "./identity"

// Reference implementation of the previous arithmetic encoder, kept only to
// prove the bit-extraction rewrite is output-identical (existing IDs unchanged).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
function legacyBody(bytes: Uint8Array): string {
  let n = 0
  for (let i = 0; i < 5; i++) n = n * 256 + (bytes[i] ?? 0)
  let body = ""
  for (let i = 0; i < 8; i++) {
    body = ALPHABET[n % 32] + body
    n = Math.floor(n / 32)
  }
  return body
}

// Deterministic xorshift sample set (no CSPRNG needed to prove equivalence).
function deterministicSamples(count: number): Uint8Array[] {
  let x = 0x9e3779b9
  const out: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const b = new Uint8Array(5)
    for (let j = 0; j < 5; j++) {
      x ^= x << 13
      x ^= x >>> 17
      x ^= x << 5
      b[j] = x & 0xff
    }
    out.push(b)
  }
  return out
}

describe("Synapse ID body encoding (CodeQL js/biased-cryptographic-random #7)", () => {
  it("matches the legacy encoder for edge and random inputs", () => {
    const cases = [
      new Uint8Array([0, 0, 0, 0, 0]),
      new Uint8Array([255, 255, 255, 255, 255]),
      new Uint8Array([1, 2, 3, 4, 5]),
      new Uint8Array([128, 0, 0, 0, 1]),
      ...deterministicSamples(5000),
    ]
    for (const bytes of cases) {
      const id = formatSynapseId("UG", bytes)
      expect(id).toContain(legacyBody(bytes))
      expect(isValidSynapseId(id)).toBe(true)
    }
  })
})
