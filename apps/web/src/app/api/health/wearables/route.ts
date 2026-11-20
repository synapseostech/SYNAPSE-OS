import { NextRequest } from 'next/server'
import { isHealthOwner, requireWebHealthOwner } from '../../../../lib/personal-health/owner'
import { deleteWearable, getWearables } from '../../../../lib/personal-health/wearables-handlers'

/** Web portal view of the signed-in person's own wearable summaries. */
export async function GET(req: NextRequest) {
  const owner = await requireWebHealthOwner()
  return isHealthOwner(owner) ? getWearables(req, owner) : owner
}

export async function DELETE(req: NextRequest) {
  const owner = await requireWebHealthOwner()
  return isHealthOwner(owner) ? deleteWearable(req, owner) : owner
}
