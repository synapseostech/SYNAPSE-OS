import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { hashPassword, validatePasswordStrength } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { trySendActivationEmail } from '../../../../../lib/auth/activation-email'
import { handleExistingAccountSignup, signupAccepted } from '../../../../../lib/auth/signup-response'
import { checkRateLimit, rateLimiters } from '../../../../../lib/rate-limit'
import { normaliseSignupSex } from '../../../../../lib/personal-health/sex'

export async function POST(req: NextRequest) {
  let userId: string | null = null

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown'
  const rate = await checkRateLimit(rateLimiters.auth, `signup-patient:ip:${ip}`)
  if (!rate.success) {
    return NextResponse.json({ error: 'Too many attempts. Please wait before trying again.' }, { status: 429 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const firstName = typeof body.first_name === 'string' ? body.first_name.trim() : ''
    const lastName = typeof body.last_name === 'string' ? body.last_name.trim() : ''
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    const dob = typeof body.dob === 'string' ? body.dob : ''
    // `sex` is sex recorded at birth (female | male | intersex | undisclosed);
    // older app builds sent it as `gender`. `gender_identity` is optional and free.
    const { clinicalSex, genderIdentity } = normaliseSignupSex(body)
    const password = typeof body.password === 'string' ? body.password : ''

    if (!firstName || !lastName || !email || !password) {
      return NextResponse.json({ error: 'Name, email, and password are required.' }, { status: 400 })
    }

    const strength = validatePasswordStrength(password)
    if (!strength.valid) {
      return NextResponse.json({ error: strength.errors[0] ?? 'Password is not strong enough.' }, { status: 400 })
    }

    // Hash before the lookup so new and existing emails take comparable time.
    const passwordHash = await hashPassword(password)

    const db = supabaseAdmin as any
    const { data: existing, error: existingErr } = await db
      .from('profiles')
      .select('id, email, full_name, first_name, verification_status, email_verified_at, is_deleted')
      .eq('email', email)
      .maybeSingle()

    if (existingErr) {
      console.error('[auth/signup/patient] existing lookup failed', existingErr)
      return NextResponse.json({ error: 'Could not create account.' }, { status: 500 })
    }

    if (existing) {
      await handleExistingAccountSignup({
        db,
        existing,
        origin: req.nextUrl.origin,
        logContext: 'auth/signup/patient',
      })
      return signupAccepted()
    }

    userId = randomUUID()
    const fullName = `${firstName} ${lastName}`.trim()
    const now = new Date().toISOString()

    const { error: profileErr } = await db.from('profiles').insert({
      id: userId,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      email,
      phone: phone || null,
      gender: genderIdentity,
      date_of_birth: dob || null,
      role: 'patient',
      password_hash: passwordHash,
      password_changed_at: now,
      onboarding_complete: false,
      verification_status: 'pending',
      email_verified_at: null,
      activation_sent_at: null,
      app_user: true,
    })

    if (profileErr) {
      console.error('[auth/signup/patient] profile insert failed', profileErr)
      return NextResponse.json({ error: 'Could not create account.' }, { status: 500 })
    }

    const { error: patientErr } = await db.from('patient_profiles').upsert({
      id: userId,
      first_name: firstName,
      last_name: lastName,
      full_name: fullName,
      phone: phone || null,
      date_of_birth: dob || null,
      sex: clinicalSex,
    })

    if (patientErr) {
      console.error('[auth/signup/patient] patient profile upsert failed', patientErr)
      await db.from('patient_profiles').delete().eq('id', userId)
      await db.from('profiles').delete().eq('id', userId)
      return NextResponse.json({ error: 'Could not create account.' }, { status: 500 })
    }

    const emailResult = await trySendActivationEmail({
      origin: req.nextUrl.origin,
      userId,
      email,
      name: fullName,
      logContext: 'auth/signup/patient',
    })

    if (emailResult.sent) {
      await db
        .from('profiles')
        .update({ activation_sent_at: new Date().toISOString() })
        .eq('id', userId)
    }

    return signupAccepted()
  } catch (error) {
    console.error('[auth/signup/patient] unexpected failure', error)

    if (userId) {
      await (supabaseAdmin as any).from('patient_profiles').delete().eq('id', userId)
      await (supabaseAdmin as any).from('profiles').delete().eq('id', userId)
    }

    return NextResponse.json({ error: 'Could not create account.' }, { status: 500 })
  }
}
