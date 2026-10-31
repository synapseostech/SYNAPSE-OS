/**
 * Application-level AES-GCM for sensitive SyncCommand payloads.
 * Key material is never hardcoded — callers supply a per-install key
 * from SecureStore / Node crypto.randomBytes.
 */

const ENC_PREFIX = "synapse.aesgcm.v1:"
const IV_LENGTH = 12

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

async function getSubtle(): Promise<SubtleCrypto> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error("WebCrypto SubtleCrypto is required for offline AES-GCM")
  return subtle
}

export async function generateOfflineKeyBytes(): Promise<Uint8Array> {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64")
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function b64ToBytes(value: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(value, "base64"))
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export function encodeKey(bytes: Uint8Array): string {
  return bytesToB64(bytes)
}

export function decodeKey(value: string): Uint8Array {
  return b64ToBytes(value)
}

export function isEncryptedEnvelope(value: string): boolean {
  return value.startsWith(ENC_PREFIX)
}

export async function encryptUtf8(plaintext: string, keyBytes: Uint8Array): Promise<string> {
  const subtle = await getSubtle()
  const iv = new Uint8Array(IV_LENGTH)
  globalThis.crypto.getRandomValues(iv)
  const key = await subtle.importKey("raw", toArrayBuffer(toBytes(keyBytes)), "AES-GCM", false, ["encrypt"])
  const cipher = await subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(new TextEncoder().encode(plaintext)),
  )
  const packed = new Uint8Array(iv.length + cipher.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(cipher), iv.length)
  return ENC_PREFIX + bytesToB64(packed)
}

export async function decryptUtf8(envelope: string, keyBytes: Uint8Array): Promise<string> {
  if (!isEncryptedEnvelope(envelope)) return envelope
  const subtle = await getSubtle()
  const packed = b64ToBytes(envelope.slice(ENC_PREFIX.length))
  const iv = packed.subarray(0, IV_LENGTH)
  const data = packed.subarray(IV_LENGTH)
  const key = await subtle.importKey("raw", toArrayBuffer(toBytes(keyBytes)), "AES-GCM", false, ["decrypt"])
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: toArrayBuffer(iv) }, key, toArrayBuffer(data))
  return new TextDecoder().decode(plain)
}

export async function encryptJson(value: unknown, keyBytes: Uint8Array): Promise<string> {
  return encryptUtf8(JSON.stringify(value), keyBytes)
}

export async function decryptJson<T>(envelope: string, keyBytes: Uint8Array): Promise<T> {
  return JSON.parse(await decryptUtf8(envelope, keyBytes)) as T
}
