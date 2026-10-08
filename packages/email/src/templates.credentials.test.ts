import { describe, expect, it } from 'vitest'
import { organizationFooterLine } from './client'
import { inviteHtml } from './templates'

describe('@synapse/email invitation template', () => {
  it('renders only the setup link and never a password block', () => {
    const html = inviteHtml({
      name: 'Ada',
      facilityName: 'Test Pharmacy',
      role: 'pharmacist',
      inviteUrl: 'https://pharm.synapseos.tech/invite/tok_x',
      // a stale caller passing a password must not get it rendered
      ...({ tempPassword: 'Hunter2!Secret' } as Record<string, string>),
    } as Parameters<typeof inviteHtml>[0])
    expect(html).toContain('https://pharm.synapseos.tech/invite/tok_x')
    expect(html).not.toContain('Hunter2!Secret')
    expect(html).not.toMatch(/temporary password/i)
  })

  it('footer address comes from config only', () => {
    expect(organizationFooterLine({})).toBe('Synapse Health Technologies Ltd')
    expect(organizationFooterLine({ EMAIL_ORGANIZATION_POSTAL_ADDRESS: 'Plot 1, Kampala' })).toBe(
      'Synapse Health Technologies Ltd &middot; Plot 1, Kampala',
    )
  })
})
