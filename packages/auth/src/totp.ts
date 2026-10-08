// TOTP — RFC 6238 over HMAC-SHA-1 using Web Crypto API (Node 15+)
// No external dependency. Works in Node.js and Edge Runtime.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

function b32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 0x1f]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 0x1f]
  return out
}

function b32Decode(input: string): Uint8Array {
  // Linear trailing-padding strip instead of /=+$/ (CodeQL js/polynomial-redos #3).
  // Same semantics: trailing '=' removed before whitespace is stripped.
  let str = input.toUpperCase()
  let end = str.length
  while (end > 0 && str.charCodeAt(end - 1) === 61 /* '=' */) end--
  str = str.slice(0, end).replace(/\s/g, '')
  const bytes: number[] = []
  let bits = 0, value = 0
  for (const ch of str) {
    const idx = B32.indexOf(ch)
    if (idx === -1) continue
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return new Uint8Array(bytes)
}

export function generateTotpSecret(): string {
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  return b32Encode(bytes)
}

export function totpUri(secret: string, email: string): string {
  const issuer = 'Synapse OS'
  const label  = `${encodeURIComponent(issuer)}:${encodeURIComponent(email)}`
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}

async function totpCode(secret: string, counter: number): Promise<string> {
  const key = b32Decode(secret)
  const buf = new Uint8Array(8)
  new DataView(buf.buffer).setBigUint64(0, BigInt(counter), false)
  const ck = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', ck, buf))
  // HMAC-SHA1 is always 20 bytes; non-null assertions are safe here
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const off = mac[19]! & 0xf
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const num = (((mac[off]! & 0x7f) << 24) | ((mac[off+1]! & 0xff) << 16) |
               // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
               ((mac[off+2]! & 0xff) << 8)  |  (mac[off+3]! & 0xff)) % 1_000_000
  return num.toString().padStart(6, '0')
}

export function currentTotpTimeStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / 30)
}

export async function verifyTotp(secret: string, code: string): Promise<boolean> {
  return (await matchingTotpTimeStep(secret, code)) !== null
}

/** Like verifyTotp, but returns the actual time-step the code matched (for replay-protection bookkeeping) instead of a bare boolean. */
export async function matchingTotpTimeStep(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null
  const t = currentTotpTimeStep()
  for (const d of [-1, 0, 1]) {
    if (await totpCode(secret, t + d) === code) return t + d
  }
  return null
}
