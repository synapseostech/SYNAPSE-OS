import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import type { HealthOwner } from './owner'
import {
  disconnect,
  historyStart,
  isProvider,
  listConnections,
  listDaily,
  parseReadings,
  parseScopes,
  recordConsent,
  saveReadings,
  WEARABLE_CONSENT_VERSION,
} from './wearables'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const NO_STORE = { 'Cache-Control': 'private, no-store' }

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

function failure(err: unknown, context: string) {
  console.error(`[personal-health/wearables] ${context}`, err instanceof Error ? err.message : err)
  return json({ error: 'Could not reach your health data. Try again.' }, 500)
}

/** Connections and daily summaries for the signed-in owner only. */
export async function getWearables(req: NextRequest, owner: HealthOwner) {
  const days = Number(req.nextUrl.searchParams.get('days') ?? 30)
  try {
    const [connections, daily] = await Promise.all([
      listConnections(db(), owner.ownerId),
      listDaily(db(), owner.ownerId, historyStart(days)),
    ])
    return json({ consentVersion: WEARABLE_CONSENT_VERSION, connections, daily })
  } catch (err) {
    return failure(err, 'read')
  }
}

/** Records consent for a provider and the metrics the user agreed to share. */
export async function putConsent(req: NextRequest, owner: HealthOwner) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  if (!isProvider(body.provider)) return json({ error: 'Unknown provider.' }, 400)
  if (body.consent !== true) return json({ error: 'Consent is required to store readings.' }, 400)
  const scopes = parseScopes(body.scopes)
  if (!scopes.length) return json({ error: 'Choose at least one reading to share.' }, 400)
  try {
    await recordConsent(db(), owner.ownerId, body.provider, scopes)
    return json({ ok: true, provider: body.provider, scopes, consentVersion: WEARABLE_CONSENT_VERSION })
  } catch (err) {
    return failure(err, 'consent')
  }
}

/** Stores daily summaries. Refused unless the owner has consented to that provider. */
export async function postReadings(req: NextRequest, owner: HealthOwner) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  if (!isProvider(body.provider)) return json({ error: 'Unknown provider.' }, 400)
  try {
    const connections = await listConnections(db(), owner.ownerId)
    const connection = connections.find((item) => item.provider === body.provider)
    if (!connection) {
      return json({ error: 'Connect this source and agree to share before syncing.', code: 'CONSENT_REQUIRED' }, 409)
    }
    const { readings, rejected } = parseReadings(body.readings, connection.scopes)
    await saveReadings(db(), owner.ownerId, body.provider, readings)
    return json({ ok: true, saved: readings.length, rejected })
  } catch (err) {
    return failure(err, 'sync')
  }
}

/** Disconnects a provider and deletes its stored readings. */
export async function deleteWearable(req: NextRequest, owner: HealthOwner) {
  const provider = req.nextUrl.searchParams.get('provider')
  if (!isProvider(provider)) return json({ error: 'Unknown provider.' }, 400)
  try {
    await disconnect(db(), owner.ownerId, provider)
    return json({ ok: true, provider, deleted: true })
  } catch (err) {
    return failure(err, 'disconnect')
  }
}
