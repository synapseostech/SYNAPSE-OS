import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isHealthOwner, requireMobileHealthOwner } from '../../../../../lib/personal-health/owner'

/**
 * The few signup facts My Health uses to pick sections: sex recorded at sign-up,
 * gender, date of birth. Owner-only, like the rest of personal health.
 */
export async function GET(req: NextRequest) {
  const owner = await requireMobileHealthOwner(req)
  if (!isHealthOwner(owner)) return owner

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const [{ data: profile }, { data: patient }] = await Promise.all([
    db.from('profiles').select('gender, date_of_birth').eq('id', owner.ownerId).maybeSingle(),
    db.from('patient_profiles').select('sex, date_of_birth').eq('id', owner.ownerId).maybeSingle(),
  ])

  const sex = typeof patient?.sex === 'string' ? patient.sex : null
  return NextResponse.json(
    {
      sex: sex === 'female' || sex === 'male' ? sex : sex === 'other' ? 'intersex' : null,
      gender: typeof profile?.gender === 'string' ? profile.gender : null,
      dateOfBirth: (patient?.date_of_birth as string | null) ?? (profile?.date_of_birth as string | null) ?? null,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
