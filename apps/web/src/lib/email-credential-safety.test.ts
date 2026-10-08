import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sent: Array<{ subject?: string; html?: string; to?: unknown }> = []
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (payload: { subject?: string; html?: string; to?: unknown }) => {
        sent.push(payload)
        return { data: { id: 'test-id' }, error: null }
      },
    }
  },
}))

const ROOT = join(__dirname, '..', '..', '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name.startsWith('.')) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\.(ts|tsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

describe('email credential safety', () => {
  beforeEach(() => {
    sent.length = 0
    process.env.RESEND_API_KEY = 'test-key'
    vi.resetModules()
  })
  afterEach(() => {
    delete process.env.RESEND_API_KEY
    delete process.env.EMAIL_ORGANIZATION_POSTAL_ADDRESS
  })

  it('staff invitation emails carry only the single-use setup link, never a password', async () => {
    const { sendHospitalStaffInviteEmail } = await import('./resend')
    await sendHospitalStaffInviteEmail({
      to: 'staff@example.test',
      hospitalName: 'Test Hospital <script>alert(1)</script>',
      staffName: 'Ada "Lovelace"',
      role: 'hospital_admin',
      inviteUrl: 'https://synapseos.tech/invite/facility/tok_abc',
    })
    expect(sent).toHaveLength(1)
    const html = String(sent[0]!.html)
    expect(html).toContain('https://synapseos.tech/invite/facility/tok_abc')
    expect(html).not.toMatch(/password<\/td>|temporary password|tempPassword/i)
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('refuses to send an invitation without a secure setup link', async () => {
    const { sendHospitalStaffInviteEmail } = await import('./resend')
    await expect(
      sendHospitalStaffInviteEmail({ to: 'x@example.test', hospitalName: 'H', staffName: 'S', role: 'nurse', inviteUrl: '' }),
    ).rejects.toThrow('invite_url_required')
    await expect(
      sendHospitalStaffInviteEmail({ to: 'x@example.test', hospitalName: 'H', staffName: 'S', role: 'nurse', inviteUrl: 'javascript:alert(1)' }),
    ).rejects.toThrow('invite_url_required')
    expect(sent).toHaveLength(0)
  })

  it('the plaintext-credential sender no longer exists', async () => {
    const mod = (await import('./resend')) as Record<string, unknown>
    expect(mod.sendPharmacyCredentialsEmail).toBeUndefined()
  })

  it('footer address is config-driven, escaped, and omitted when unset', async () => {
    const { organizationFooterLine, brandedEmail } = await import('./resend')
    expect(organizationFooterLine({})).toBe('Synapse Health Technologies Ltd')
    expect(organizationFooterLine({ EMAIL_ORGANIZATION_POSTAL_ADDRESS: 'P.O. Box 1 <b>' })).toBe(
      'Synapse Health Technologies Ltd &middot; P.O. Box 1 &lt;b&gt;',
    )
    expect(brandedEmail({ subject: 's', body: 'b' })).toContain('Synapse Health Technologies Ltd<br/>')
  })

  it('no source file hardcodes the former residential address or a temp-password email block', () => {
    const files = [...walk(join(ROOT, 'apps')), ...walk(join(ROOT, 'packages'))]
    const offenders: string[] = []
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      if (/Katuuso|Buziga|Ebrine(&apos;|')s Residence/i.test(src)) offenders.push(`${relative(ROOT, f)}: residential address`)
      if (/Temporary Password<\/span>|Your temporary password:|>\$\{tempPassword/i.test(src)) offenders.push(`${relative(ROOT, f)}: temp password template`)
    }
    expect(offenders).toEqual([])
  })
})
