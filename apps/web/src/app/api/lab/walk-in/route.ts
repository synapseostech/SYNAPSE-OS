import { NextResponse } from 'next/server'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { createLabWalkIn, LabWalkInError, labWalkInSchema } from '@/lib/lab/walk-in'

export const dynamic = 'force-dynamic'

/** Walk-in or referred patient with one or more tests; bills the priced ones. */
export async function POST(request: Request) {
  const ctx = await requireLabAccess('order.create')
  if (isLabContextError(ctx)) return ctx

  const parsed = labWalkInSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  try {
    const created = await createLabWalkIn(ctx, parsed.data)
    return NextResponse.json(created, { status: 201 })
  } catch (err) {
    if (err instanceof LabWalkInError) return NextResponse.json({ error: err.code }, { status: err.status })
    return NextResponse.json({ error: err instanceof Error ? err.message : 'LAB_WALK_IN_FAILED' }, { status: 500 })
  }
}
