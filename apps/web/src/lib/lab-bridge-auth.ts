import { supabaseAdmin } from "@synapse/db/admin"
import {
  BRIDGE_PREFIX_LENGTH,
  bridgeSecretPrefix,
  isLegacyBridgeHash,
  isRejectedBridgeCredentialFormat,
  resolveLabBridgeHashSecret,
  verifyBridgeSecret,
} from "@synapse/db/lab-device-intelligence"

export type LabBridgeRow = {
  id: string
  tenant_id: string
  name?: string
  is_active: boolean
  device_id: string | null
  revoked_at?: string | null
  api_key_hash?: string | null
}

export type LabBridgeLookup =
  | { ok: true; bridge: LabBridgeRow }
  | { ok: false; reason: "invalid" | "hash_unavailable" | "rotation_required" }

/**
 * Modern Lab Edge credentials authenticate by prefix lookup + constant-time
 * scrypt verification (see hashBridgeSecret). Rows still holding a legacy
 * single-round HMAC digest are refused with reason "rotation_required".
 * Legacy plaintext api_key is used only when api_key_hash is NULL.
 * A hashed row never authenticates through api_key, even if both columns are populated.
 */
export async function lookupLabBridge(presented: string): Promise<LabBridgeRow | null> {
  const result = await lookupLabBridgeDetailed(presented)
  return result.ok ? result.bridge : null
}

export async function lookupLabBridgeDetailed(presented: string): Promise<LabBridgeLookup> {
  const apiKey = presented.trim()
  if (isRejectedBridgeCredentialFormat(apiKey)) return { ok: false, reason: "invalid" }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const hashingSecret = resolveLabBridgeHashSecret()

  if (hashingSecret && apiKey.length > BRIDGE_PREFIX_LENGTH) {
    const candidates = await db
      .from("lab_instrument_bridges")
      .select("id, tenant_id, name, is_active, device_id, revoked_at, api_key_hash")
      .eq("api_key_prefix", bridgeSecretPrefix(apiKey))
      .eq("is_active", true)
      .is("revoked_at", null)
      .not("api_key_hash", "is", null)
      .limit(5)
    const rows = (candidates.data ?? []) as LabBridgeRow[]
    let legacyFormatSeen = false
    for (const row of rows) {
      if (isLegacyBridgeHash(row.api_key_hash)) {
        legacyFormatSeen = true
        continue
      }
      if (await verifyBridgeSecret(apiKey, row.api_key_hash, hashingSecret)) return { ok: true, bridge: row }
    }
    if (legacyFormatSeen) return { ok: false, reason: "rotation_required" }
  }

  const legacy = await db
    .from("lab_instrument_bridges")
    .select("id, tenant_id, name, is_active, device_id, revoked_at, api_key_hash")
    .eq("api_key", apiKey)
    .is("api_key_hash", null)
    .eq("is_active", true)
    .is("revoked_at", null)
    .maybeSingle()
  if (legacy.data && !legacy.data.api_key_hash) return { ok: true, bridge: legacy.data as LabBridgeRow }

  if (!hashingSecret) return { ok: false, reason: "hash_unavailable" }
  return { ok: false, reason: "invalid" }
}
