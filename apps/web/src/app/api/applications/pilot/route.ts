import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '../../../../lib/supabase/server'
import { resend, NOTIFY_EMAILS, FROM_EMAIL, FROM_NAME, brandedEmail } from '../../../../lib/resend'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))

  const {
    name, email, phone,
    hospital_name, location, bed_count,
    current_system, departments,
    message, facility_type,
  } = body

  if (!name || !email || !hospital_name) {
    return NextResponse.json({ error: 'name, email, and hospital_name are required' }, { status: 400 })
  }

  const supabase = createServiceClient()
  const { error: insertError } = await (supabase as any).from('hospital_leads').upsert(
    {
      contact_name: name,
      contact_email: email,
      contact_phone: phone ?? null,
      hospital_name,
      facility_type: facility_type === 'pharmacy' ? 'pharmacy' : 'hospital',
      location: location ?? null,
      bed_count: bed_count ? Number(bed_count) : null,
      current_system: current_system ?? null,
      departments: departments ?? [],
      notes: message ?? null,
      status: 'new',
      source: 'apply_page',
    },
    { onConflict: 'contact_email' }
  )

  if (insertError) {
    console.error('Failed to save pilot application:', insertError.message)
    return NextResponse.json({ error: 'Failed to save application' }, { status: 500 })
  }

  const deptList = Array.isArray(departments) && departments.length
    ? `<ul style="margin:8px 0;padding-left:20px;color:#A0A0B0;">${departments.map((d: string) => `<li style="margin:2px 0;">${d}</li>`).join('')}</ul>`
    : '<p style="color:#60607A;margin:4px 0;">None specified</p>'

  /* Notify founders */
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: NOTIFY_EMAILS,
    subject: `New Pilot Application: ${hospital_name}`,
    html: brandedEmail({
      subject: `New Pilot Application: ${hospital_name}`,
      body: `
        <h2 style="margin:0 0 20px;font-size:20px;font-weight:700;color:#F5F5F7;">New Pilot Access Application</h2>
        <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;">
          ${[
            ['Contact Name', name],
            ['Email', email],
            ['Phone', phone || '—'],
            ['Hospital', hospital_name],
            ['Location', location || '—'],
            ['Beds', bed_count || '—'],
            ['Current System', current_system || '—'],
          ].map(([k, v]) => `
            <tr>
              <td style="padding:8px 0;font-size:13px;font-weight:600;color:#A0A0B0;width:140px;">${k}</td>
              <td style="padding:8px 0;font-size:13px;color:#F5F5F7;">${v}</td>
            </tr>`).join('')}
        </table>
        <div style="margin-top:16px;">
          <p style="font-size:13px;font-weight:600;color:#A0A0B0;margin-bottom:4px;">Departments of interest:</p>
          ${deptList}
        </div>
        ${message ? `<div style="margin-top:16px;padding:16px;background:rgba(255,255,255,0.04);border-radius:8px;border-left:3px solid #F97316;"><p style="font-size:13px;color:#A0A0B0;margin:0;">${message}</p></div>` : ''}
        <div style="margin-top:24px;">
          <a href="https://admin.synapseos.tech/applications" style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;">View in Admin Dashboard</a>
        </div>
      `,
    }),
  })

  /* Auto-reply to applicant */
  await resend.emails.send({
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    to: [email],
    subject: 'Your Synapse OS application has been received',
    html: brandedEmail({
      subject: 'Your Synapse OS application has been received',
      body: `
        <h2 style="margin:0 0 12px;font-size:20px;font-weight:700;color:#F5F5F7;">Thank you, ${name}.</h2>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 16px;">
          We've received your pilot access application for <strong style="color:#F5F5F7;">${hospital_name}</strong>.
          Our team reviews every application personally and will be in touch within 24 hours.
        </p>
        <p style="font-size:15px;line-height:1.7;color:#A0A0B0;margin:0 0 24px;">
          In the meantime, you can explore the AI diagnosis demo or review the platform overview.
        </p>
        <a href="https://demo.synapseos.tech" style="display:inline-block;background:#F97316;color:#07070A;font-weight:700;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;margin-right:12px;">Try Live Demo</a>
        <a href="https://synapseos.tech/platform" style="display:inline-block;background:rgba(255,255,255,0.08);color:#F5F5F7;font-weight:600;font-size:13px;padding:10px 20px;border-radius:8px;text-decoration:none;border:1px solid rgba(255,255,255,0.12);">Platform Overview</a>
      `,
    }),
  })

  return NextResponse.json({ ok: true })
}
