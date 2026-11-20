import { NextRequest } from 'next/server'
import { isHealthOwner, requireMobileHealthOwner } from '../../../../../lib/personal-health/owner'
import {
  deleteWearable,
  getWearables,
  postReadings,
  putConsent,
} from '../../../../../lib/personal-health/wearables-handlers'

/**
 * My Synapse Health wearables for the signed-in person (patient or staff).
 * GET    connections + daily summaries
 * PUT    record consent { provider, scopes, consent: true }
 * POST   upload daily summaries { provider, readings }
 * DELETE ?provider=…  disconnect and delete that provider's readings
 */
export async function GET(req: NextRequest) {
  const owner = await requireMobileHealthOwner(req)
  return isHealthOwner(owner) ? getWearables(req, owner) : owner
}

export async function PUT(req: NextRequest) {
  const owner = await requireMobileHealthOwner(req)
  return isHealthOwner(owner) ? putConsent(req, owner) : owner
}

export async function POST(req: NextRequest) {
  const owner = await requireMobileHealthOwner(req)
  return isHealthOwner(owner) ? postReadings(req, owner) : owner
}

export async function DELETE(req: NextRequest) {
  const owner = await requireMobileHealthOwner(req)
  return isHealthOwner(owner) ? deleteWearable(req, owner) : owner
}
